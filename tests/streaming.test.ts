import { describe, expect, it } from 'vitest';
import { EventQueue } from '../src/core/events.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { MockModel } from '../src/llm/model.js';
import { allowAll } from '../src/tools/confirm.js';
import type { OrchestrationEvent } from '../src/core/events.js';

async function collect(input: string, o = new Orchestrator({ model: new MockModel() })) {
  const events: OrchestrationEvent[] = [];
  for await (const ev of o.stream(input)) events.push(ev);
  return events;
}

describe('EventQueue', () => {
  it('entrega lo que se empujo antes de empezar a consumir', async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([1, 2]);
  });

  it('espera a que lleguen valores nuevos', async () => {
    const q = new EventQueue<number>();
    setTimeout(() => {
      q.push(7);
      q.close();
    }, 5);

    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([7]);
  });

  it('propaga el error al consumidor', async () => {
    const q = new EventQueue<number>();
    q.fail(new Error('roto'));
    await expect(async () => {
      for await (const _ of q) void _;
    }).rejects.toThrow('roto');
  });

  it('empujar despues de cerrar no hace nada', async () => {
    const q = new EventQueue<number>();
    q.close();
    q.push(1);
    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([]);
  });
});

describe('stream del orquestador', () => {
  it('emite analyze y route antes de ejecutar ningun agente', async () => {
    const events = await collect('que es un closure');
    const tipos = events.map((e) => e.type);

    expect(tipos[0]).toBe('analyze');
    expect(tipos[1]).toBe('route');
    expect(tipos.indexOf('route')).toBeLessThan(tipos.indexOf('agent-start'));
    expect(tipos.at(-1)).toBe('done');
  });

  it('el texto llega en fragmentos y reconstruye la respuesta final', async () => {
    const events = await collect('que es un closure');
    const deltas = events.filter((e) => e.type === 'text');
    const done = events.at(-1);

    expect(deltas.length).toBeGreaterThan(1);
    if (done?.type !== 'done') throw new Error('falta done');
    const reconstruido = deltas.map((d) => (d.type === 'text' ? d.delta : '')).join('');
    expect(reconstruido).toBe(done.result.text);
  });

  it('avisa de las herramientas mientras corren, no al final', async () => {
    const o = new Orchestrator({ model: new MockModel(), confirm: allowAll(), root: process.cwd() });
    const events = await collect('cuanto es (2340 * 15) / 100', o);
    const tipos = events.map((e) => e.type);

    const tool = tipos.indexOf('tool');
    expect(tool).toBeGreaterThan(-1);
    // La herramienta se reporta antes de que el agente termine.
    expect(tool).toBeLessThan(tipos.indexOf('agent-end'));
  });

  it('cada evento de texto dice de que agente vino', async () => {
    const events = await collect(
      'investiga y compara opciones de base de datos vectorial, despues un plan y ademas estima costos',
    );
    const agentes = new Set(
      events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.agentId : '')),
    );
    // En paralelo escriben varios a la vez: sin el agentId no se podrian separar.
    expect(agentes.size).toBeGreaterThan(1);
  });

  it('el evento done trae el mismo resultado que run()', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const events = await collect('hola', o);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('falta done');

    const directo = await o.run('hola');
    expect(done.result.text).toBe(directo.text);
    expect(done.result.decision.agents).toEqual(directo.decision.agents);
  });

  it('un fallo se emite como evento en vez de romper el for await', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    // @ts-expect-error se rompe a proposito
    o.router = { route: () => { throw new Error('router roto'); } };

    const events = await collect('hola', o);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'router roto' });
  });

  it('onEvent recibe lo mismo que el stream', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const porCallback: string[] = [];
    const porStream: string[] = [];

    for await (const ev of o.stream('hola', { onEvent: (e) => porCallback.push(e.type) })) {
      porStream.push(ev.type);
    }
    expect(porCallback).toEqual(porStream);
  });
});
