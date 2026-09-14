import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { AgentRegistry } from '../src/router/registry.js';
import { Router } from '../src/router/router.js';
import { llmAgent } from '../src/agents/base.js';
import { createDefaultRegistry } from '../src/agents/index.js';
import { MockModel } from '../src/llm/model.js';
import { allowAll } from '../src/tools/confirm.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/core/types.js';

/** Modelo espia: cuenta llamadas para probar que el reflex no gasta nada. */
class SpyModel implements ModelClient {
  readonly kind = 'spy';
  calls: ModelRequest[] = [];
  private inner = new MockModel();

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    return this.inner.generate(req);
  }
}

describe('orchestrator', () => {
  it('responde un saludo sin llamar a ningun modelo', async () => {
    const model = new SpyModel();
    const o = new Orchestrator({ model });
    const res = await o.run('hola');

    expect(model.calls).toHaveLength(0);
    expect(res.usage.costUsd).toBe(0);
    expect(res.decision.tier).toBe('reflex');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('un pedido real si llama al modelo', async () => {
    const model = new SpyModel();
    const o = new Orchestrator({ model });
    const res = await o.run('escribime una funcion que valide un email en typescript');

    expect(model.calls.length).toBeGreaterThan(0);
    expect(res.usage.costUsd).toBeGreaterThan(0);
  });

  it('escala a un agente mas potente cuando el barato se declara insuficiente', async () => {
    const registry = new AgentRegistry();
    registry.register(
      llmAgent({
        id: 'test.barato',
        name: 'Barato',
        description: 'se rinde rapido',
        tier: 'light',
        capabilities: ['knowledge'],
        intents: ['factual_qa'],
        cost: 0.1,
        comfortMax: 0.05, // techo bajisimo: va a pedir escalar
        system: 'x',
      }),
      llmAgent({
        id: 'test.potente',
        name: 'Potente',
        description: 'aguanta todo',
        tier: 'standard',
        capabilities: ['knowledge'],
        intents: ['factual_qa'],
        cost: 0.5,
        comfortMax: 1,
        system: 'x',
      }),
    );

    const o = new Orchestrator({ registry, router: new Router(registry), model: new MockModel() });
    const res = await o.run('que es un closure en javascript');

    expect(res.escalations).toBe(1);
    expect(res.outputs[0]!.agentId).toBe('test.barato');
    expect(res.outputs[0]!.escalate).toBeDefined();
    expect(res.outputs.at(-1)!.agentId).toBe('test.potente');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.trace.some((e) => e.type === 'escalate')).toBe(true);
  });

  it('no escala mas alla del tope configurado', async () => {
    const registry = new AgentRegistry();
    registry.register(
      llmAgent({
        id: 'test.rendidor',
        name: 'Rendidor',
        description: 'siempre escala',
        tier: 'light',
        capabilities: ['knowledge'],
        intents: ['factual_qa'],
        cost: 0.1,
        comfortMax: 0,
        system: 'x',
      }),
    );
    const o = new Orchestrator({
      registry,
      router: new Router(registry),
      model: new MockModel(),
      maxEscalations: 2,
    });
    const res = await o.run('que es un closure en javascript');
    expect(res.escalations).toBeLessThanOrEqual(2);
  });

  it('corta la cadena cuando se acaba el presupuesto', async () => {
    const o = new Orchestrator({ model: new MockModel(), maxCostUsd: 0.000_001 });
    const res = await o.run(
      'disename la arquitectura completa de un sistema de facturacion multi-tenant con auditoria',
    );

    expect(res.decision.strategy).toBe('chain');
    // Se ejecuto menos agentes de los planificados y quedo registrado en la traza.
    expect(res.outputs.length).toBeLessThan(res.decision.agents.length);
    expect(res.trace.some((e) => e.type === 'error' && e.label.includes('presupuesto'))).toBe(true);
  });

  it('en paralelo agrega el uso de todos los agentes y sintetiza', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const res = await o.run(
      'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    );

    expect(res.decision.strategy).toBe('parallel');
    expect(res.outputs.length).toBe(res.decision.agents.length + 1); // workers + sintetizador
    expect(res.outputs.at(-1)!.agentId).toBe('llm.synthesizer');
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });

  it('un agente que falla en paralelo no tumba la corrida', async () => {
    const registry = createDefaultRegistry();
    const roto = registry.get('llm.planner');
    roto.run = async () => {
      throw new Error('boom');
    };

    const o = new Orchestrator({ registry, router: new Router(registry), model: new MockModel() });
    const res = await o.run(
      'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    );

    expect(res.text.length).toBeGreaterThan(0);
    expect(res.trace.some((e) => e.type === 'error' && e.label.includes('boom'))).toBe(true);
  });

  it('las herramientas usadas suben al resultado y a la traza', async () => {
    const o = new Orchestrator({ model: new MockModel(), confirm: allowAll(), root: process.cwd() });
    const res = await o.run('cuanto es (2340 * 15) / 100');

    expect(res.decision.agents).toContain('llm.analyst');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.call.name).toBe('calculator');
    expect(res.toolCalls[0]!.result.content).toBe('351');
    expect(res.trace.some((e) => e.type === 'tool:call')).toBe(true);
  });

  it('con la politica por defecto un agente no puede escribir', async () => {
    const registry = createDefaultRegistry();
    const o = new Orchestrator({ registry, router: new Router(registry), model: new MockModel() });
    // autoSafe es el default: lectura si, escritura no.
    expect((o as unknown as { services: { confirm: { name: string } } }).services.confirm.name).toBe('auto-safe');
  });

  it('inspect no ejecuta nada', async () => {
    const model = new SpyModel();
    const o = new Orchestrator({ model });
    const { decision } = o.inspect('escribime un parser de CSV');
    expect(decision.agents.length).toBeGreaterThan(0);
    expect(model.calls).toHaveLength(0);
  });

  it('la traza cuenta la historia completa, en orden', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const res = await o.run('que es un closure');
    const tipos = res.trace.map((e) => e.type);
    expect(tipos[0]).toBe('analyze');
    expect(tipos[1]).toBe('route');
    expect(tipos.at(-1)).toBe('done');
    expect(res.trace.every((e, i) => i === 0 || e.ms >= res.trace[i - 1]!.ms)).toBe(true);
  });
});
