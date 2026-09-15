import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrchestatiServer } from '../src/server.js';
import { MockModel } from '../src/llm/model.js';
import { InMemorySessionStore } from '../src/runtime/session.js';
import { InMemoryRouterMemory } from '../src/router/memory.js';

let base: string;
let app: ReturnType<typeof createOrchestatiServer>;

beforeAll(async () => {
  app = createOrchestatiServer({
    model: new MockModel(),
    sessions: new InMemorySessionStore(),
    routerOptions: { memory: new InMemoryRouterMemory() },
  });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('servidor', () => {
  it('responde /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agents: number; confirm: string };
    expect(body.ok).toBe(true);
    expect(body.agents).toBeGreaterThan(0);
    // Del otro lado de un HTTP no hay a quien preguntarle: solo lectura.
    expect(body.confirm).toBe('auto-safe');
  });

  it('lista el pool de agentes', async () => {
    const res = await fetch(`${base}/agents`);
    const body = (await res.json()) as { agents: Array<{ id: string; tier: string }> };
    expect(body.agents.some((a) => a.id === 'reflex.smalltalk')).toBe(true);
    expect(body.agents.some((a) => a.tier === 'deep')).toBe(true);
  });

  it('/inspect analiza sin ejecutar', async () => {
    const res = await post('/inspect', { input: 'hola' });
    const body = (await res.json()) as {
      signals: { primaryIntent: string };
      decision: { tier: string; agents: string[] };
    };
    expect(body.signals.primaryIntent).toBe('greeting');
    expect(body.decision.tier).toBe('reflex');
    expect(body.decision.agents).toEqual(['reflex.smalltalk']);
  });

  it('/chat ejecuta y devuelve el resultado completo', async () => {
    const res = await post('/chat', { input: 'hola' });
    const body = (await res.json()) as { text: string; decision: { tier: string }; usage: { costUsd: number } };
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.decision.tier).toBe('reflex');
    expect(body.usage.costUsd).toBe(0);
  });

  it('/chat/stream manda SSE con los eventos en orden', async () => {
    const res = await post('/chat/stream', { input: 'que es un closure' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const texto = await res.text();
    const tipos = [...texto.matchAll(/^event: (\w[\w-]*)$/gm)].map((m) => m[1]);

    expect(tipos[0]).toBe('analyze');
    expect(tipos[1]).toBe('route');
    expect(tipos).toContain('text');
    expect(tipos.at(-1)).toBe('done');
  });

  it('cada bloque SSE es JSON parseable', async () => {
    const res = await post('/chat/stream', { input: 'hola' });
    const texto = await res.text();
    const datos = [...texto.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    expect(datos.length).toBeGreaterThan(2);
    expect(datos.at(-1)).toMatchObject({ type: 'done' });
  });

  it('guarda y devuelve el historial de una sesion', async () => {
    await post('/chat', { input: 'hola', sessionId: 'test-1' });
    await post('/chat', { input: 'gracias', sessionId: 'test-1' });

    const res = await fetch(`${base}/session/test-1`);
    const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0]!.content).toBe('hola');
    expect(body.messages[2]!.content).toBe('gracias');

    await fetch(`${base}/session/test-1`, { method: 'DELETE' });
    const vacia = (await (await fetch(`${base}/session/test-1`)).json()) as { messages: unknown[] };
    expect(vacia.messages).toEqual([]);
  });

  it('las sesiones no se mezclan', async () => {
    await post('/chat', { input: 'hola', sessionId: 'a1' });
    await post('/chat', { input: 'gracias', sessionId: 'b1' });

    const a = (await (await fetch(`${base}/session/a1`)).json()) as { messages: Array<{ content: string }> };
    expect(a.messages).toHaveLength(2);
    expect(a.messages[0]!.content).toBe('hola');
  });

  it('rechaza un pedido sin input', async () => {
    for (const path of ['/chat', '/inspect', '/chat/stream']) {
      const res = await post(path, {});
      expect(res.status).toBe(400);
    }
  });

  it('404 en lo que no existe', async () => {
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });

  it('sirve la UI de demostracion', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Orchestati');
  });

  it('responde al preflight de CORS', async () => {
    const res = await fetch(`${base}/chat`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
