import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyzer.js';
import { createDefaultRegistry } from '../src/agents/index.js';
import { Router } from '../src/router/router.js';
import { InMemoryRouterMemory } from '../src/router/memory.js';

function route(input: string) {
  const registry = createDefaultRegistry();
  const router = new Router(registry);
  return router.route(analyze(input));
}

describe('router', () => {
  it('manda los saludos al agente reflex, sin LLM', () => {
    const d = route('hola');
    expect(d.agents).toEqual(['reflex.smalltalk']);
    expect(d.tier).toBe('reflex');
  });

  it('el agente reflex se auto-veta cuando hay un pedido real', () => {
    const d = route('escribime un parser de CSV en typescript');
    expect(d.agents).not.toContain('reflex.smalltalk');
    const reflex = d.ranking.find((r) => r.agentId === 'reflex.smalltalk');
    expect(reflex?.vetoed).toBeDefined();
  });

  it('elige al depurador cuando hay un stack trace', () => {
    const d = route('me tira TypeError: cannot read property map of undefined, arregla esto');
    expect(d.agents).toContain('llm.debugger');
  });

  it('elige al operador en acciones riesgosas', () => {
    const d = route('deploya esto a produccion ahora');
    expect(d.agents).toContain('llm.tools');
  });

  it('en fan-out elige agentes complementarios, no redundantes', () => {
    const d = route(
      'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    );
    expect(d.strategy).toBe('parallel');
    expect(d.synthesizer).toBe('llm.synthesizer');
    expect(new Set(d.agents).size).toBe(d.agents.length);
    // Nada de traer al depurador a un pedido de investigacion.
    expect(d.agents).not.toContain('llm.debugger');
    expect(d.agents).toContain('llm.researcher');
    expect(d.agents).toContain('llm.planner');
  });

  it('arma la cadena plan -> ejecucion -> revision en pedidos complejos', () => {
    const registry = createDefaultRegistry();
    const router = new Router(registry);
    const d = router.route(analyze('diseñame la arquitectura completa de un sistema de facturacion multi-tenant con auditoria'));
    expect(d.strategy).toBe('chain');
    expect(d.agents[0]).toBe('llm.planner');
  });

  it('respeta el tope de tier', () => {
    const registry = createDefaultRegistry();
    const router = new Router(registry, { maxTier: 'light' });
    const d = router.route(analyze('investiga y compara todas las opciones y despues plan y ademas costos'));
    expect(d.tier).toBe('light');
  });

  it('el feedback mueve el ranking', () => {
    const registry = createDefaultRegistry();
    const memory = new InMemoryRouterMemory();
    const router = new Router(registry, { memory });
    const signals = analyze('que es un closure en javascript');

    const antes = router.score(registry.get('llm.quick'), signals, 'light').total;
    for (let i = 0; i < 10; i++) router.feedback(signals, 'llm.quick', 1);
    const despues = router.score(registry.get('llm.quick'), signals, 'light').total;

    expect(despues).toBeGreaterThan(antes);
  });

  it('escalar fuerza un tier mas alto', () => {
    const registry = createDefaultRegistry();
    const router = new Router(registry);
    const signals = analyze('que es un closure');
    const normal = router.route(signals);
    const escalado = router.route(signals, 'deep');
    expect(escalado.tier).toBe('deep');
    expect(escalado.agents).not.toEqual(normal.agents);
  });
});
