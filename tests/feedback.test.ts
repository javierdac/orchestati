import { describe, expect, it, vi } from 'vitest';
import { observeOutcome, SIGNAL_WEIGHT } from '../src/runtime/outcome.js';
import { InMemoryRouterMemory } from '../src/router/memory.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { Router } from '../src/router/router.js';
import { createDefaultRegistry } from '../src/agents/index.js';
import { MockModel } from '../src/llm/model.js';
import { InMemorySessionStore } from '../src/runtime/session.js';
import { featureSimilarity } from '../src/analysis/semantic/vectorize.js';
import { analyze } from '../src/analysis/analyzer.js';
import type { OrchestrationResult } from '../src/core/types.js';

const base = (over: Partial<OrchestrationResult> = {}): OrchestrationResult =>
  ({
    id: 'run-1',
    text: 'una respuesta razonablemente larga que parece util',
    signals: analyze('que es un closure'),
    decision: { strategy: 'direct', agents: ['llm.quick'], tier: 'light', ranking: [], reason: '' },
    outputs: [],
    trace: [],
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0, ms: 1 },
    escalations: 0,
    toolCalls: [],
    ...over,
  }) as OrchestrationResult;

describe('observeOutcome', () => {
  it('una corrida limpia da señal debil: no fallar no es lo mismo que estar bien', () => {
    const o = observeOutcome(base());
    expect(o.weak).toBe(true);
    expect(o.score).toBeGreaterThan(0.5);
    expect(o.score).toBeLessThan(0.8);
  });

  it('escalar baja la nota', () => {
    const o = observeOutcome(base({ escalations: 1 }));
    expect(o.score).toBeLessThan(observeOutcome(base()).score);
    expect(o.weak).toBe(false);
    expect(o.reasons.join(' ')).toContain('escalo');
  });

  it('no producir respuesta es cero', () => {
    const o = observeOutcome(base({ text: '' }));
    expect(o.score).toBe(0);
    expect(o.weak).toBe(false);
  });

  it('los errores de la traza bajan la nota', () => {
    const o = observeOutcome(
      base({ trace: [{ at: 0, ms: 0, type: 'error', label: 'algo se rompio' }] }),
    );
    expect(o.score).toBeLessThan(0.5);
  });

  it('distingue herramientas que fallaron de herramientas denegadas', () => {
    const fallida = observeOutcome(
      base({
        toolCalls: [
          { call: { id: '1', name: 'x', args: {} }, risk: 'safe', approved: true, ms: 1, result: { ok: false, content: 'boom' } },
        ],
      }),
    );
    const denegada = observeOutcome(
      base({
        toolCalls: [
          { call: { id: '1', name: 'x', args: {} }, risk: 'confirm', approved: false, ms: 1, result: { ok: false, content: 'sin permiso' } },
        ],
      }),
    );
    // Que el usuario no autorice algo no es culpa del agente.
    expect(denegada.score).toBeGreaterThan(fallida.score);
  });

  it('herramientas que funcionaron suben la nota', () => {
    const o = observeOutcome(
      base({
        toolCalls: [
          { call: { id: '1', name: 'x', args: {} }, risk: 'safe', approved: true, ms: 1, result: { ok: true, content: '351' } },
        ],
      }),
    );
    expect(o.score).toBeGreaterThan(observeOutcome(base()).score);
    expect(o.weak).toBe(false);
  });
});

describe('memoria pesada por señal', () => {
  it('una señal debil mueve menos que una explicita', () => {
    const debil = new InMemoryRouterMemory();
    const fuerte = new InMemoryRouterMemory();

    for (let i = 0; i < 5; i++) {
      debil.record('factual_qa', 'a', 1, SIGNAL_WEIGHT.weak);
      fuerte.record('factual_qa', 'a', 1, SIGNAL_WEIGHT.explicit);
    }
    expect(fuerte.prior('factual_qa', 'a')).toBeGreaterThan(debil.prior('factual_qa', 'a'));
  });

  it('peso cero no registra nada', () => {
    const m = new InMemoryRouterMemory();
    m.record('factual_qa', 'a', 1, 0);
    expect(m.snapshot()).toEqual({});
  });

  it('la primera señal debil no fija el prior de una', () => {
    const m = new InMemoryRouterMemory();
    m.record('factual_qa', 'a', 1, SIGNAL_WEIGHT.weak);
    // Muy lejos del 1 que se registro: se mezclo con el neutro.
    expect(m.snapshot()['factual_qa::a']!.score).toBeLessThan(0.7);
  });
});

describe('el lazo de aprendizaje no es circular', () => {
  /**
   * Regresion del error original: el router se alimentaba de la `confidence`
   * que el agente calculaba a partir de la complejidad y su comfortMax, o sea
   * de datos conocidos ANTES de ejecutar. Dos corridas con el mismo ruteo pero
   * distinto desenlace tienen que dejar priors distintos.
   */
  it('dos corridas con el mismo ruteo y distinto resultado dejan priors distintos', async () => {
    const pedido = 'que es un closure en javascript';

    const bien = new InMemoryRouterMemory();
    const mal = new InMemoryRouterMemory();

    const registryOk = createDefaultRegistry();
    const oOk = new Orchestrator({
      registry: registryOk,
      router: new Router(registryOk, { memory: bien }),
      model: new MockModel(),
    });

    const registryMal = createDefaultRegistry();
    // Mismo agente, mismo ruteo, pero no devuelve nada.
    registryMal.get('llm.quick').run = async () => ({
      agentId: 'llm.quick',
      text: '',
      confidence: 0.95, // se auto-declara seguro: no debe alcanzar para nada
    });
    const oMal = new Orchestrator({
      registry: registryMal,
      router: new Router(registryMal, { memory: mal }),
      model: new MockModel(),
      maxEscalations: 0,
    });

    await oOk.run(pedido);
    await oMal.run(pedido);

    const intent = analyze(pedido).primaryIntent;
    expect(bien.prior(intent, 'llm.quick')).toBeGreaterThan(mal.prior(intent, 'llm.quick'));
  });
});

describe('feedback explicito', () => {
  it('puntuar una corrida mueve el prior de sus agentes', async () => {
    const memory = new InMemoryRouterMemory();
    const registry = createDefaultRegistry();
    const o = new Orchestrator({ registry, router: new Router(registry, { memory }), model: new MockModel() });

    const res = await o.run('que es un closure en javascript');
    const intent = res.signals.primaryIntent;
    const antes = memory.prior(intent, res.decision.agents[0]!);

    expect(o.recordFeedback(res.id, 1)).toBe(true);
    expect(memory.prior(intent, res.decision.agents[0]!)).toBeGreaterThan(antes);
  });

  it('una corrida desconocida se reporta, no se traga en silencio', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    expect(o.recordFeedback('run-inexistente', 1)).toBe(false);
  });

  it('cada corrida tiene su propio id', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const a = await o.run('hola');
    const b = await o.run('hola');
    expect(a.id).not.toBe(b.id);
  });
});

describe('deteccion de reformulacion', () => {
  it('reconoce cuando se vuelve a pedir lo mismo', () => {
    expect(featureSimilarity('como configuro un dominio en vercel', 'como configuro un dominio en vercel')).toBe(1);
    expect(
      featureSimilarity('como configuro un dominio en vercel', 'como se configura un dominio en vercel'),
    ).toBeGreaterThan(0.55);
    expect(
      featureSimilarity('como configuro un dominio en vercel', 'escribime un parser de csv'),
    ).toBeLessThan(0.2);
  });

  it('volver a preguntar lo mismo penaliza al agente que contesto antes', async () => {
    const memory = new InMemoryRouterMemory();
    const registry = createDefaultRegistry();
    const o = new Orchestrator({
      registry,
      router: new Router(registry, { memory }),
      model: new MockModel(),
      sessions: new InMemorySessionStore(),
    });

    const primera = await o.run('que es exactamente un closure en javascript', { sessionId: 's' });
    const intent = primera.signals.primaryIntent;
    const antes = memory.prior(intent, primera.decision.agents[0]!);

    // Casi el mismo pedido: sintoma de que la respuesta no sirvio.
    await o.run('que es exactamente un closure en javascript?', { sessionId: 's' });

    expect(memory.prior(intent, primera.decision.agents[0]!)).toBeLessThan(antes);
  });

  it('un pedido distinto no penaliza al anterior', async () => {
    const memory = new InMemoryRouterMemory();
    const registry = createDefaultRegistry();
    const o = new Orchestrator({
      registry,
      router: new Router(registry, { memory }),
      model: new MockModel(),
      sessions: new InMemorySessionStore(),
    });

    const primera = await o.run('que es un closure en javascript', { sessionId: 's' });
    const intent = primera.signals.primaryIntent;
    const antes = memory.prior(intent, primera.decision.agents[0]!);

    await o.run('escribime un parser de csv en python', { sessionId: 's' });

    expect(memory.prior(intent, primera.decision.agents[0]!)).toBe(antes);
  });

  it('sin sesion no hay deteccion: no hay con que comparar', async () => {
    const memory = new InMemoryRouterMemory();
    const registry = createDefaultRegistry();
    const o = new Orchestrator({ registry, router: new Router(registry, { memory }), model: new MockModel() });

    const primera = await o.run('que es un closure en javascript');
    const antes = memory.prior(primera.signals.primaryIntent, primera.decision.agents[0]!);
    await o.run('que es un closure en javascript');
    expect(memory.prior(primera.signals.primaryIntent, primera.decision.agents[0]!)).not.toBe(0);
    expect(antes).toBeGreaterThan(0);
  });
});

describe('aislamiento del registry', () => {
  it('dos registries no comparten instancias de agente', () => {
    const a = createDefaultRegistry();
    const b = createDefaultRegistry();

    const original = b.get('llm.quick').run;
    a.get('llm.quick').run = async () => ({ agentId: 'llm.quick', text: 'mutado', confidence: 1 });

    // Tocar uno no debe tocar el otro.
    expect(b.get('llm.quick').run).toBe(original);
  });
});
