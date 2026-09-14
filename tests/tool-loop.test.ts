import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runToolLoop } from '../src/runtime/tool-loop.js';
import { analyze } from '../src/analysis/analyzer.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { allowAll, askUser, autoSafe, denyAll } from '../src/tools/confirm.js';
import type { AgentContext, ModelClient, ModelRequest, ModelResponse } from '../src/core/types.js';
import type { ConfirmationPolicy, Tool } from '../src/tools/types.js';

/** Modelo guionado: devuelve exactamente lo que se le indica en cada paso. */
class ScriptedModel implements ModelClient {
  readonly kind = 'scripted';
  requests: ModelRequest[] = [];

  constructor(private steps: Array<Partial<ModelResponse>>) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const step = this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)] ?? {};
    return {
      text: step.text ?? '',
      model: 'scripted',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.000_01, ms: 1 },
      ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
    };
  }
}

const echoTool: Tool<{ msg: string }> = {
  name: 'echo',
  description: 'devuelve lo que se le pasa',
  risk: 'safe',
  schema: z.object({ msg: z.string() }),
  summarize: (a) => `eco de "${a.msg}"`,
  execute: async (a) => ({ ok: true, content: `eco: ${a.msg}` }),
};

function makeCtx(model: ModelClient, confirm: ConfirmationPolicy, tools: Tool[], maxCostUsd = 1): AgentContext {
  return {
    input: 'test',
    signals: analyze('hace algo con la herramienta'),
    history: [],
    priorOutputs: [],
    budget: { maxCostUsd, spentUsd: 0, maxMs: 10_000, startedAt: Date.now(), maxEscalations: 1 },
    services: {
      model,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      tools: new ToolRegistry().register(...tools),
      confirm,
      root: process.cwd(),
    },
    depth: 0,
  };
}

const loop = (ctx: AgentContext, tools: Tool[], maxSteps = 4) =>
  runToolLoop({
    ctx,
    agentId: 'test.agent',
    tools,
    request: { tier: 'standard', prompt: 'hace algo' },
    maxSteps,
  });

describe('tool loop', () => {
  it('ejecuta una herramienta segura y le devuelve el resultado al modelo', async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'echo', args: { msg: 'hola' } }] },
      { text: 'listo' },
    ]);
    const ctx = makeCtx(model, autoSafe(), [echoTool]);
    const res = await loop(ctx, [echoTool]);

    expect(res.text).toBe('listo');
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.approved).toBe(true);
    expect(res.records[0]!.result.content).toBe('eco: hola');
    // La segunda llamada al modelo tiene que llevar el resultado de la primera.
    expect(model.requests[1]!.toolTurns?.[0]!.results[0]!.content).toBe('eco: hola');
  });

  it('suma el uso de todos los pasos', async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'echo', args: { msg: 'a' } }] },
      { text: 'fin' },
    ]);
    const ctx = makeCtx(model, autoSafe(), [echoTool]);
    const res = await loop(ctx, [echoTool]);
    expect(res.usage.inputTokens).toBe(20); // dos llamadas
  });

  it('la politica por defecto no deja escribir', async () => {
    const write: Tool<{ path: string }> = {
      name: 'fake_write',
      description: 'escribe',
      risk: 'confirm',
      schema: z.object({ path: z.string() }),
      summarize: (a) => `escribir ${a.path}`,
      execute: vi.fn(async () => ({ ok: true, content: 'escrito' })),
    };

    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'fake_write', args: { path: 'x.ts' } }] },
      { text: 'no pude' },
    ]);
    const ctx = makeCtx(model, autoSafe(), [write]);
    const res = await loop(ctx, [write]);

    expect(write.execute).not.toHaveBeenCalled();
    expect(res.records[0]!.approved).toBe(false);
    // Al modelo se le explica que falta permiso, no se le miente con un error.
    expect(res.records[0]!.result.content).toContain('permiso');
  });

  it('con autorizacion explicita si ejecuta', async () => {
    const write: Tool<{ path: string }> = {
      name: 'fake_write',
      description: 'escribe',
      risk: 'confirm',
      schema: z.object({ path: z.string() }),
      summarize: (a) => `escribir ${a.path}`,
      execute: vi.fn(async () => ({ ok: true, content: 'escrito' })),
    };
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'fake_write', args: { path: 'x.ts' } }] },
      { text: 'ok' },
    ]);
    const res = await loop(makeCtx(model, allowAll(), [write]), [write]);

    expect(write.execute).toHaveBeenCalledOnce();
    expect(res.records[0]!.approved).toBe(true);
  });

  it('askUser no pregunta por lo seguro y si por lo que tiene efecto', async () => {
    const ask = vi.fn(async () => true);
    const write: Tool<{ path: string }> = {
      name: 'fake_write',
      description: 'escribe',
      risk: 'confirm',
      schema: z.object({ path: z.string() }),
      summarize: (a) => `escribir ${a.path}`,
      execute: async () => ({ ok: true, content: 'escrito' }),
    };

    const model = new ScriptedModel([
      {
        toolCalls: [
          { id: '1', name: 'echo', args: { msg: 'x' } },
          { id: '2', name: 'fake_write', args: { path: 'x.ts' } },
        ],
      },
      { text: 'fin' },
    ]);
    await loop(makeCtx(model, askUser(ask), [echoTool, write]), [echoTool, write]);

    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]![0]!.tool).toBe('fake_write');
  });

  it('valida los argumentos antes de ejecutar nada', async () => {
    const strict: Tool<{ n: number }> = {
      name: 'strict',
      description: 'necesita un numero',
      risk: 'safe',
      schema: z.object({ n: z.number() }),
      summarize: () => 'strict',
      execute: vi.fn(async () => ({ ok: true, content: 'ok' })),
    };
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'strict', args: { n: 'no soy un numero' } }] },
      { text: 'fin' },
    ]);
    const res = await loop(makeCtx(model, allowAll(), [strict]), [strict]);

    expect(strict.execute).not.toHaveBeenCalled();
    expect(res.records[0]!.result.ok).toBe(false);
    expect(res.records[0]!.result.content).toContain('argumentos invalidos');
  });

  it('una herramienta inexistente no rompe el loop', async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'no_existe', args: {} }] },
      { text: 'seguimos' },
    ]);
    const res = await loop(makeCtx(model, allowAll(), [echoTool]), [echoTool]);
    expect(res.text).toBe('seguimos');
    expect(res.records[0]!.result.content).toContain('no existe');
  });

  it('una herramienta que explota se reporta pero no tumba el loop', async () => {
    const boom: Tool<Record<string, never>> = {
      name: 'boom',
      description: 'falla',
      risk: 'safe',
      schema: z.object({}),
      summarize: () => 'boom',
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'boom', args: {} }] },
      { text: 'sobrevivi' },
    ]);
    const res = await loop(makeCtx(model, allowAll(), [boom]), [boom]);
    expect(res.text).toBe('sobrevivi');
    expect(res.records[0]!.result.content).toContain('kaboom');
  });

  it('corta en maxSteps aunque el modelo siga pidiendo herramientas', async () => {
    const model = new ScriptedModel([{ toolCalls: [{ id: '1', name: 'echo', args: { msg: 'a' } }] }]);
    const res = await loop(makeCtx(model, allowAll(), [echoTool]), [echoTool], 3);
    expect(res.steps).toBe(3);
    expect(res.records).toHaveLength(3);
  });

  it('corta cuando se agota el presupuesto', async () => {
    const model = new ScriptedModel([{ toolCalls: [{ id: '1', name: 'echo', args: { msg: 'a' } }] }]);
    // Con el modelo pidiendo herramientas para siempre, lo unico que lo frena
    // es el presupuesto: cada llamada cuesta 0.00001.
    const res = await loop(makeCtx(model, allowAll(), [echoTool], 0.000_015), [echoTool], 10);
    expect(res.steps).toBeLessThan(10);
    expect(res.text).toContain('presupuesto');
  });

  it('denyAll deja ver que *haria* el agente sin ejecutar nada', async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ id: '1', name: 'echo', args: { msg: 'x' } }] },
      { text: 'fin' },
    ]);
    const res = await loop(makeCtx(model, denyAll(), [echoTool]), [echoTool]);
    expect(res.records[0]!.approved).toBe(false);
    expect(res.records[0]!.call.args).toEqual({ msg: 'x' });
  });
});
