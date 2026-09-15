import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { SqlSessionStore, SqlRouterMemory, ensureSchema } from '../src/adapters/sql.js';
import { RedisSessionStore, RedisRouterMemory } from '../src/adapters/redis.js';
import { InMemoryRouterMemory } from '../src/router/memory.js';
import type { Message } from '../src/core/types.js';

/**
 * Integracion real contra Postgres y Redis.
 *
 * Los tests con dobles cubren la logica pero no la sintaxis: el ON CONFLICT y
 * el script Lua nunca se ejecutan ahi. Esto los ejecuta.
 *
 * Se saltea solo si no hay servidores: `docker run -p 55432:5432 postgres` y
 * `docker run -p 56379:6379 redis`.
 */
const PG = process.env.TEST_PG_URL ?? 'postgres://postgres:test@127.0.0.1:55432/orchestati';
const REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379';

/**
 * Se sondea el puerto ANTES de declarar las suites para poder saltearlas de
 * forma visible. Detectarlo adentro obligaria a elegir entre fallar sin
 * servidor o pasar en silencio sin haber probado nada.
 */
function puertoAbierto(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port })
      .on('connect', () => { s.destroy(); resolve(true); })
      .on('error', () => resolve(false));
    s.setTimeout(ms, () => { s.destroy(); resolve(false); });
  });
}

const hayPg = await puertoAbierto(new URL(PG).hostname, Number(new URL(PG).port || 5432));
const hayRedis = await puertoAbierto(new URL(REDIS).hostname, Number(new URL(REDIS).port || 6379));

if (!hayPg || !hayRedis) {
  console.warn(
    `\n  [integración] salteada — ${!hayPg ? 'sin Postgres ' : ''}${!hayRedis ? 'sin Redis ' : ''}` +
      `\n  docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=orchestati postgres:16-alpine` +
      `\n  docker run -d --rm -p 56379:6379 redis:7-alpine\n`,
  );
}

let pool: Pool | undefined;
let redis: RedisClientType | undefined;

beforeAll(async () => {
  if (hayPg) {
    const p = new Pool({ connectionString: PG, connectionTimeoutMillis: 3000 });
    await p.query('SELECT 1');
    pool = p;
  }
  if (hayRedis) {
    const r = createClient({ url: REDIS }) as RedisClientType;
    await r.connect();
    redis = r;
  }
});

afterAll(async () => {
  await pool?.end();
  await redis?.quit();
});

const msg = (n: number): Message[] => [
  { role: 'user', content: `pedido ${n}` },
  { role: 'assistant', content: `respuesta ${n}` },
];

const unico = (): string => `t${Date.now()}${Math.random().toString(36).slice(2, 7)}`;

describe.runIf(hayPg)('Postgres real', () => {
  it('crea el esquema y es idempotente', async () => {
    if (!pool) return;
    await ensureSchema(pool);
    await ensureSchema(pool); // dos veces: el DDL no debe fallar
    const { rows } = await pool.query(
      `SELECT to_regclass('orchestati_sessions') AS s, to_regclass('orchestati_router_memory') AS m`,
    );
    expect(rows[0].s).toBeTruthy();
    expect(rows[0].m).toBeTruthy();
  });

  it('guarda y recupera una conversacion', async () => {
    if (!pool) return;
    const s = new SqlSessionStore(pool);
    const id = unico();
    await s.append(id, msg(1));
    await s.append(id, msg(2));

    expect(await s.history(id)).toEqual([...msg(1), ...msg(2)]);
    await s.clear(id);
    expect(await s.history(id)).toEqual([]);
  });

  it('el recorte conserva arranque y cola, hecho en la consulta', async () => {
    if (!pool) return;
    const s = new SqlSessionStore(pool, 6);
    const id = unico();
    for (let i = 0; i < 10; i++) await s.append(id, msg(i));

    const h = await s.history(id);
    expect(h).toHaveLength(6);
    expect(h[0]!.content).toBe('pedido 0');
    expect(h.at(-1)!.content).toBe('respuesta 9');
  });

  it('el ON CONFLICT calcula el EWMA y sobrevive a escrituras concurrentes', async () => {
    if (!pool) return;
    const key = unico();
    const a = new SqlRouterMemory(pool);
    const b = new SqlRouterMemory(pool);

    // Dos "instancias" escribiendo a la vez sobre el mismo par.
    for (let i = 0; i < 10; i++) {
      a.record('factual_qa', key, 1);
      b.record('factual_qa', key, 1);
    }
    await Promise.all([a.flush(), b.flush()]);

    const { rows } = await pool.query(
      `SELECT score, n FROM orchestati_router_memory WHERE intent = $1 AND agent_id = $2`,
      ['factual_qa', key],
    );
    // Ninguna actualizacion se perdio y el score converge hacia el resultado.
    expect(Number(rows[0].n)).toBe(20);
    expect(Number(rows[0].score)).toBeGreaterThan(0.9);
  });

  it('load() recupera lo que escribio otra instancia', async () => {
    if (!pool) return;
    const key = unico();
    const escritor = new SqlRouterMemory(pool);
    for (let i = 0; i < 5; i++) escritor.record('code_debug', key, 1);
    await escritor.flush();

    const lector = await new SqlRouterMemory(pool).load();
    expect(lector.prior('code_debug', key)).toBeCloseTo(escritor.prior('code_debug', key), 6);
  });
});

describe.runIf(hayRedis)('Redis real', () => {
  it('guarda y recupera una conversacion', async () => {
    if (!redis) return;
    const s = new RedisSessionStore(redis, 20, `test:${unico()}:`);
    await s.append('s1', msg(1));
    expect(await s.history('s1')).toEqual(msg(1));
    await s.clear('s1');
    expect(await s.history('s1')).toEqual([]);
  });

  it('el script Lua calcula el EWMA de verdad', async () => {
    if (!redis) return;
    const key = `test:mem:${unico()}`;
    const m = new RedisRouterMemory(redis, key);
    m.record('factual_qa', 'llm.quick', 1);
    await m.flush();

    const guardado = await redis.hGet(key, 'factual_qa::llm.quick');
    expect(guardado).toBeTruthy();
    const [score, n] = guardado!.split(':');
    expect(Number(n)).toBe(1);
    expect(Number(score)).toBeCloseTo(1, 6);
    await redis.del(key);
  });

  it('dos instancias concurrentes no se pisan', async () => {
    if (!redis) return;
    const key = `test:mem:${unico()}`;
    const a = new RedisRouterMemory(redis, key);
    const b = new RedisRouterMemory(redis, key);

    for (let i = 0; i < 10; i++) {
      a.record('factual_qa', 'x', 1);
      b.record('factual_qa', 'x', 1);
    }
    await Promise.all([a.flush(), b.flush()]);

    const [, n] = (await redis.hGet(key, 'factual_qa::x'))!.split(':');
    expect(Number(n)).toBe(20);
    await redis.del(key);
  });

  it('coincide con la memoria de proceso ante la misma secuencia', async () => {
    if (!redis) return;
    const key = `test:mem:${unico()}`;
    const enMemoria = new InMemoryRouterMemory();
    const enRedis = new RedisRouterMemory(redis, key);

    for (const [outcome, peso] of [[1, 0.25], [0, 1], [0.8, 0.6], [1, 0.7]] as const) {
      enMemoria.record('factual_qa', 'a', outcome, peso);
      enRedis.record('factual_qa', 'a', outcome, peso);
    }
    await enRedis.flush();

    const releido = await new RedisRouterMemory(redis, key).load();
    expect(releido.prior('factual_qa', 'a')).toBeCloseTo(enMemoria.prior('factual_qa', 'a'), 6);
    await redis.del(key);
  });
});
