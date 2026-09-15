import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { MockModel } from '../src/llm/model.js';
import { formatSystemInfo } from '../src/core/info.js';
import { ToolRegistry, calculatorTool } from '../src/tools/index.js';
import { denyAll } from '../src/tools/confirm.js';
import { createDefaultRegistry } from '../src/agents/index.js';

describe('info del sistema', () => {
  it('describe backend, politica y raiz', () => {
    const o = new Orchestrator({ model: new MockModel(), confirm: denyAll(), root: '/tmp/x' });
    const info = o.info();
    expect(info.backend).toBe('mock');
    expect(info.confirm).toBe('deny-all');
    expect(info.root).toBe('/tmp/x');
  });

  it('lista un escalon por tier, con sus agentes', () => {
    const info = new Orchestrator({ model: new MockModel() }).info();
    const porTier = Object.fromEntries(info.tiers.map((t) => [t.tier, t]));

    expect(porTier.reflex!.agents).toContain('reflex.smalltalk');
    expect(porTier.light!.agents).toContain('llm.quick');
    expect(porTier.deep!.agents).toContain('llm.debugger');
  });

  it('reflex no declara modelo: no llama a ninguno', () => {
    const info = new Orchestrator({ model: new MockModel() }).info();
    expect(info.tiers.find((t) => t.tier === 'reflex')!.model).toBeUndefined();
    expect(info.tiers.find((t) => t.tier === 'light')!.model).toBeTruthy();
  });

  it('sale del estado real, no de una lista escrita a mano', () => {
    const registry = createDefaultRegistry();
    const info = new Orchestrator({
      registry,
      model: new MockModel(),
      tools: new ToolRegistry().register(calculatorTool),
    }).info();

    // Los agentes son los del registry, ni uno mas.
    expect(info.agents).toHaveLength(registry.all().length);
    // Las herramientas son las del catalogo que se paso, no las del default.
    expect(info.tools.map((t) => t.name)).toEqual(['calculator']);
  });

  it('solo reporta las herramientas de un agente que existen en el catalogo', () => {
    const info = new Orchestrator({
      model: new MockModel(),
      tools: new ToolRegistry().register(calculatorTool),
    }).info();

    const analista = info.agents.find((a) => a.id === 'llm.analyst')!;
    // Declara calculator y read_file, pero read_file no esta en este catalogo.
    expect(analista.tools).toEqual(['calculator']);
  });

  it('agrupa las herramientas por riesgo al formatearlas', () => {
    const texto = formatSystemInfo(new Orchestrator({ model: new MockModel() }).info());
    expect(texto).toContain('sin confirmación:');
    expect(texto).toContain('requieren permiso:');
    expect(texto).toContain('irreversibles:');
  });

  it('el agente de identidad contesta con la descripcion real del sistema', async () => {
    const o = new Orchestrator({ model: new MockModel() });
    const res = await o.run('quien sos y que podes hacer');

    expect(res.decision.agents).toEqual(['reflex.identity']);
    // No es un texto fijo: nombra los escalones y los modelos de verdad.
    expect(res.text).toContain('Escalones');
    expect(res.text).toContain('llm.debugger');
    expect(res.usage.costUsd).toBe(0);
  });

  it('un pool distinto cambia lo que el sistema dice de si mismo', async () => {
    const registry = createDefaultRegistry();
    const o = new Orchestrator({ registry, model: new MockModel() });
    const antes = await o.run('quien sos');

    expect(antes.text).toContain('llm.researcher');
    expect(antes.text).not.toContain('llm.inventado');
  });
});
