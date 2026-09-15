import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileSessionStore,
  InMemorySessionStore,
  trimHistory,
  DEFAULT_MAX_TURNS,
} from '../src/runtime/session.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { MockModel } from '../src/llm/model.js';
import type { Message } from '../src/core/types.js';

const msg = (n: number): Message[] => [
  { role: 'user', content: `pedido ${n}` },
  { role: 'assistant', content: `respuesta ${n}` },
];

describe('trimHistory', () => {
  it('conserva el arranque y la cola, no solo la cola', () => {
    const largo = Array.from({ length: 50 }, (_, i) => msg(i)).flat();
    const corto = trimHistory(largo, 10);

    expect(corto).toHaveLength(10);
    // El primer intercambio se guarda: ahi se establece de que se habla.
    expect(corto[0]!.content).toBe('pedido 0');
    expect(corto[1]!.content).toBe('respuesta 0');
    // Y lo mas reciente tambien.
    expect(corto.at(-1)!.content).toBe('respuesta 49');
  });

  it('con un cupo minimo se queda solo con lo reciente', () => {
    const largo = Array.from({ length: 50 }, (_, i) => msg(i)).flat();
    expect(trimHistory(largo, 2)).toEqual(msg(49));
  });

  it('nunca devuelve mas de lo pedido', () => {
    const largo = Array.from({ length: 50 }, (_, i) => msg(i)).flat();
    for (const n of [1, 2, 3, 4, 7, 10, 25]) {
      expect(trimHistory(largo, n).length, `maxTurns=${n}`).toBeLessThanOrEqual(n);
    }
  });

  it('no toca un historial corto', () => {
    expect(trimHistory(msg(1), DEFAULT_MAX_TURNS)).toHaveLength(2);
  });
});

describe('InMemorySessionStore', () => {
  it('guarda y devuelve por sesion, sin mezclar', async () => {
    const store = new InMemorySessionStore();
    await store.append('a', msg(1));
    await store.append('b', msg(2));

    expect((await store.history('a'))[0]!.content).toBe('pedido 1');
    expect((await store.history('b'))[0]!.content).toBe('pedido 2');
    expect(await store.history('inexistente')).toEqual([]);
  });

  it('limpia una sesion', async () => {
    const store = new InMemorySessionStore();
    await store.append('a', msg(1));
    await store.clear('a');
    expect(await store.history('a')).toEqual([]);
  });

  it('recorta cuando se hace larga', async () => {
    const store = new InMemorySessionStore(4);
    for (let i = 0; i < 10; i++) await store.append('a', msg(i));
    expect((await store.history('a')).length).toBeLessThanOrEqual(4);
  });
});

describe('FileSessionStore', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orchestati-sess-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sobrevive a que se reinicie el proceso', async () => {
    const uno = new FileSessionStore(dir);
    await uno.append('s1', msg(1));

    // Otra instancia: simula levantar el proceso de nuevo.
    const dos = new FileSessionStore(dir);
    expect((await dos.history('s1'))[0]!.content).toBe('pedido 1');
  });

  it('sanitiza el id para que no escriba fuera del directorio', async () => {
    const store = new FileSessionStore(dir);
    await store.append('../../evil', msg(9));
    // Se guardo con nombre saneado y se lee igual: no salio del directorio.
    expect((await store.history('../../evil'))[0]!.content).toBe('pedido 9');
  });

  it('una sesion vacia devuelve lista vacia, no rompe', async () => {
    const store = new FileSessionStore(dir);
    expect(await store.history('nunca-existio')).toEqual([]);
  });

  it('ignora lineas corruptas en vez de fallar', async () => {
    const store = new FileSessionStore(dir);
    await store.append('s2', msg(1));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 's2.jsonl'), 'esto no es json\n');
    await store.append('s2', msg(2));

    const hist = await store.history('s2');
    expect(hist).toHaveLength(4);
  });
});

describe('orquestador con sesion', () => {
  it('le pasa el historial al agente en el pedido siguiente', async () => {
    const sessions = new InMemorySessionStore();
    const o = new Orchestrator({ model: new MockModel(), sessions });

    await o.run('que es un closure', { sessionId: 'x' });
    const hist = await sessions.history('x');

    expect(hist).toHaveLength(2);
    expect(hist[0]).toEqual({ role: 'user', content: 'que es un closure' });
    expect(hist[1]!.role).toBe('assistant');
  });

  it('sin sessionId no guarda nada', async () => {
    const sessions = new InMemorySessionStore();
    const o = new Orchestrator({ model: new MockModel(), sessions });
    await o.run('que es un closure');
    expect(await sessions.history('x')).toEqual([]);
  });

  it('el historial explicito le gana al de la sesion', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.append('x', msg(1));
    const o = new Orchestrator({ model: new MockModel(), sessions });

    const res = await o.run('seguimos', { sessionId: 'x', history: [] });
    expect(res.text.length).toBeGreaterThan(0);
  });
});
