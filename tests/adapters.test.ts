import { describe, expect, it, vi } from 'vitest';
import {
  SqlSessionStore,
  SqlRouterMemory,
  sqlSchema,
  ensureSchema,
  type SqlClient,
} from '../src/adapters/sql.js';
import { RedisSessionStore, RedisRouterMemory, type RedisLike } from '../src/adapters/redis.js';
import { InMemoryRouterMemory } from '../src/router/memory.js';
import type { Intent, Message } from '../src/core/types.js';

// --- dobles ----------------------------------------------------------------

/** Registra las consultas y devuelve lo que se le configure. */
class FakeSql implements SqlClient {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  rows: Array<Record<string, unknown>> = [];
  falla?: Error;

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, ...(values ? { values } : {}) });
    if (this.falla) throw this.falla;
    return { rows: this.rows };
  }
}

/** Redis en memoria, con el EWMA del script reimplementado para comparar. */
class FakeRedis implements RedisLike {
  listas = new Map<string, string[]>();
  hashes = new Map<string, Record<string, string>>();
  evals: Array<{ keys: string[]; arguments: string[] }> = [];

  async get(): Promise<string | null> { return null; }
  async set(): Promise<unknown> { return 'OK'; }
  async del(key: string | string[]): Promise<unknown> {
    for (const k of Array.isArray(key) ? key : [key]) { this.listas.delete(k); this.hashes.delete(k); }
    return 1;
  }
  async rPush(key: string, values: string[]): Promise<unknown> {
    this.listas.set(key, [...(this.listas.get(key) ?? []), ...values]);
    return values.length;
  }
  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.listas.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }
  async hGetAll(key: string): Promise<Record<string, string>> { return this.hashes.get(key) ?? {}; }
  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.evals.push(options);
    const [key] = options.keys;
    const [field, outcome, alpha, primera] = options.arguments;
    const h = this.hashes.get(key!) ?? {};
    const raw = h[field!];
    let score: number, n: number;
    if (raw) {
      const [s, cnt] = raw.split(':');
      score = Number(s) * (1 - Number(alpha)) + Number(outcome) * Number(alpha);
      n = Number(cnt) + 1;
    } else {
      score = Number(primera); n = 1;
    }
    h[field!] = `${score}:${n}`;
    this.hashes.set(key!, h);
    return h[field!];
  }
}

const msg = (n: number): Message[] => [
  { role: 'user', content: `pedido ${n}` },
  { role: 'assistant', content: `respuesta ${n}` },
];

// --- SQL -------------------------------------------------------------------

describe('SqlSessionStore', () => {
  it('inserta todos los mensajes de un turno en una sola consulta', async () => {
    const c = new FakeSql();
    await new SqlSessionStore(c).append('s1', msg(1));

    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.text).toMatch(/INSERT INTO orchestati_sessions/);
    // Un placeholder por columna variable, no strings interpolados.
    expect(c.calls[0]!.text).toContain('($1, $2, $3), ($1, $4, $5)');
    expect(c.calls[0]!.values).toEqual(['s1', 'user', 'pedido 1', 'assistant', 'respuesta 1']);
  });

  it('nunca interpola valores en el SQL', async () => {
    const c = new FakeSql();
    const malicioso = "x'; DROP TABLE orchestati_sessions; --";
    await new SqlSessionStore(c).append(malicioso, [{ role: 'user', content: malicioso }]);
    await new SqlSessionStore(c).clear(malicioso);

    for (const call of c.calls) {
      expect(call.text).not.toContain('DROP TABLE');
      expect(call.values).toContain(malicioso);
    }
  });

  it('trae el arranque y la cola en una consulta, no la sesion entera', async () => {
    const c = new FakeSql();
    c.rows = [{ role: 'user', content: 'primero' }, { role: 'assistant', content: 'ultimo' }];
    const out = await new SqlSessionStore(c, 20).history('s1');

    expect(c.calls[0]!.text).toMatch(/ORDER BY seq ASC LIMIT 2/);
    expect(c.calls[0]!.text).toMatch(/ORDER BY seq DESC LIMIT \$2/);
    expect(c.calls[0]!.values).toEqual(['s1', 18]);
    expect(out).toEqual([
      { role: 'user', content: 'primero' },
      { role: 'assistant', content: 'ultimo' },
    ]);
  });

  it('con un cupo minimo pide solo la cola', async () => {
    const c = new FakeSql();
    await new SqlSessionStore(c, 2).history('s1');
    expect(c.calls[0]!.text).not.toContain('UNION');
  });

  it('no consulta nada si no hay mensajes que guardar', async () => {
    const c = new FakeSql();
    await new SqlSessionStore(c).append('s1', []);
    expect(c.calls).toEqual([]);
  });

  it('respeta nombres de tabla propios', async () => {
    const c = new FakeSql();
    await new SqlSessionStore(c, 20, { sessions: 'mi_tabla' }).clear('s1');
    expect(c.calls[0]!.text).toContain('mi_tabla');
  });
});

describe('sqlSchema', () => {
  it('es idempotente', () => {
    expect(sqlSchema()).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sqlSchema()).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('ensureSchema ejecuta cada sentencia por separado', async () => {
    const c = new FakeSql();
    await ensureSchema(c);
    expect(c.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of c.calls) expect(call.text).not.toContain(';');
  });
});

describe('SqlRouterMemory', () => {
  it('calcula el EWMA dentro del UPDATE, no en el proceso', async () => {
    const c = new FakeSql();
    const m = new SqlRouterMemory(c);
    m.record('factual_qa', 'llm.quick', 1);
    await m.flush();

    // Si el calculo viviera en el proceso, dos instancias se pisarian.
    const sql = c.calls[0]!.text;
    expect(sql).toMatch(/ON CONFLICT .* DO UPDATE/s);
    // El score nuevo se deriva del score que ya esta en la tabla.
    expect(sql).toMatch(/score\s*=\s*orchestati_router_memory\.score/);
  });

  it('castea los parametros numericos explicitamente', async () => {
    // Sin el cast, Postgres infiere el tipo de $5 desde `1 - $5` —donde el 1
    // es un literal entero— y rechaza 0.25 con "invalid input syntax for
    // type integer". Solo aparece contra una base real.
    const c = new FakeSql();
    const m = new SqlRouterMemory(c);
    m.record('factual_qa', 'a', 1);
    await m.flush();

    expect(c.calls[0]!.text).toMatch(/\$5::double precision/);
    expect(c.calls[0]!.text).toMatch(/\$3::double precision/);
  });

  it('prior() responde sin ir a la red', () => {
    const c = new FakeSql();
    const m = new SqlRouterMemory(c);
    // Sin load() y sin await: es sincronico por contrato.
    expect(m.prior('factual_qa', 'llm.quick')).toBe(0.5);
    expect(c.calls).toEqual([]);
  });

  it('load() calienta el cache desde la base', async () => {
    const c = new FakeSql();
    c.rows = [{ intent: 'factual_qa', agent_id: 'llm.quick', score: 0.9, n: 10 }];
    const m = await new SqlRouterMemory(c).load();

    expect(m.prior('factual_qa', 'llm.quick')).toBeCloseTo(0.9, 5);
  });

  it('un fallo de escritura no rompe la corrida', async () => {
    const c = new FakeSql();
    c.falla = new Error('base caida');
    const onError = vi.fn();
    const m = new SqlRouterMemory(c, {}, onError);

    expect(() => m.record('factual_qa', 'a', 1)).not.toThrow();
    await m.flush();
    expect(onError).toHaveBeenCalled();
    // El cache local sigue sirviendo aunque la base no responda.
    expect(m.prior('factual_qa', 'a')).toBeGreaterThan(0.5);
  });
});

// --- Redis -----------------------------------------------------------------

describe('RedisSessionStore', () => {
  it('guarda y recupera una conversacion', async () => {
    const r = new FakeRedis();
    const s = new RedisSessionStore(r);
    await s.append('s1', msg(1));
    expect(await s.history('s1')).toEqual(msg(1));
  });

  it('no mezcla sesiones', async () => {
    const r = new FakeRedis();
    const s = new RedisSessionStore(r);
    await s.append('a', msg(1));
    await s.append('b', msg(2));
    expect((await s.history('a'))[0]!.content).toBe('pedido 1');
  });

  it('recorta conservando arranque y cola', async () => {
    const r = new FakeRedis();
    const s = new RedisSessionStore(r, 6);
    for (let i = 0; i < 10; i++) await s.append('s1', msg(i));

    const h = await s.history('s1');
    expect(h).toHaveLength(6);
    expect(h[0]!.content).toBe('pedido 0');
    expect(h.at(-1)!.content).toBe('respuesta 9');
  });

  it('ignora entradas corruptas en vez de romper', async () => {
    const r = new FakeRedis();
    r.listas.set('orchestati:session:s1', ['no es json', JSON.stringify({ role: 'user', content: 'ok' })]);
    expect(await new RedisSessionStore(r).history('s1')).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('acepta clientes en camelCase y en minusculas', async () => {
    const r = new FakeRedis();
    // ioredis expone rpush/lrange en vez de rPush/lRange.
    const ioredis = {
      get: r.get.bind(r), set: r.set.bind(r), del: r.del.bind(r),
      rpush: (k: string, ...v: string[]) => r.rPush(k, v),
      lrange: r.lRange.bind(r),
      hgetall: r.hGetAll.bind(r),
    } as RedisLike;

    const s = new RedisSessionStore(ioredis);
    await s.append('s1', msg(1));
    expect(await s.history('s1')).toEqual(msg(1));
  });

  it('limpia una sesion', async () => {
    const r = new FakeRedis();
    const s = new RedisSessionStore(r);
    await s.append('s1', msg(1));
    await s.clear('s1');
    expect(await s.history('s1')).toEqual([]);
  });
});

describe('RedisRouterMemory', () => {
  it('manda el EWMA a Redis para que sea atomico', async () => {
    const r = new FakeRedis();
    const m = new RedisRouterMemory(r);
    m.record('factual_qa', 'llm.quick', 1);
    await m.flush();

    expect(r.evals).toHaveLength(1);
    expect(r.evals[0]!.arguments[0]).toBe('factual_qa::llm.quick');
  });

  it('load() recupera lo escrito', async () => {
    const r = new FakeRedis();
    const uno = new RedisRouterMemory(r);
    for (let i = 0; i < 5; i++) uno.record('factual_qa', 'llm.quick', 1);
    await uno.flush();

    // Otra instancia, como otro proceso que arranca.
    const dos = await new RedisRouterMemory(r).load();
    expect(dos.prior('factual_qa', 'llm.quick')).toBeCloseTo(uno.prior('factual_qa', 'llm.quick'), 5);
  });

  it('sin eval avisa en vez de escribir mal', async () => {
    const onError = vi.fn();
    const sinEval = { get: async () => null, set: async () => 'OK', del: async () => 1 } as RedisLike;
    new RedisRouterMemory(sinEval, 'k', onError).record('factual_qa', 'a', 1);
    expect(onError).toHaveBeenCalled();
  });
});

// --- lo que mas importa ----------------------------------------------------

describe('las tres memorias coinciden', () => {
  /**
   * Si divergieran, cambiar de backend cambiaria el ruteo — y seria un cambio
   * invisible, porque nadie compara priors entre entornos.
   */
  it('la misma secuencia deja el mismo prior en memoria, SQL y Redis', async () => {
    const enMemoria = new InMemoryRouterMemory();
    const sql = new SqlRouterMemory(new FakeSql());
    const redis = new RedisRouterMemory(new FakeRedis());

    const secuencia: Array<[Intent, string, number, number]> = [
      ['factual_qa', 'llm.quick', 1, 0.25],
      ['factual_qa', 'llm.quick', 0, 1],
      ['factual_qa', 'llm.quick', 0.8, 0.6],
      ['code_debug', 'llm.debugger', 1, 1],
      ['factual_qa', 'llm.quick', 1, 0.7],
    ];

    for (const [intent, agente, outcome, peso] of secuencia) {
      enMemoria.record(intent, agente, outcome, peso);
      sql.record(intent, agente, outcome, peso);
      redis.record(intent, agente, outcome, peso);
    }
    await sql.flush();
    await redis.flush();

    for (const [intent, agente] of secuencia) {
      const esperado = enMemoria.prior(intent, agente);
      expect(sql.prior(intent, agente), `sql ${intent}/${agente}`).toBeCloseTo(esperado, 9);
      expect(redis.prior(intent, agente), `redis ${intent}/${agente}`).toBeCloseTo(esperado, 9);
    }
  });

  it('un peso cero no registra nada en ninguna', async () => {
    const sql = new SqlRouterMemory(new FakeSql());
    const redis = new RedisRouterMemory(new FakeRedis());
    sql.record('factual_qa', 'a', 1, 0);
    redis.record('factual_qa', 'a', 1, 0);

    expect(sql.snapshot()).toEqual({});
    expect(redis.snapshot()).toEqual({});
  });
});
