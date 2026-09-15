import type { ModelClient, ModelRequest, ModelResponse, Tier, ToolCall } from '../core/types.js';

/**
 * Base comun para los clientes que hablan con el AI SDK.
 *
 * Lo unico que cambia entre el gateway y un modelo local es COMO se resuelve
 * el modelo y CUANTO cuesta. Todo el resto —armar la conversacion con el ida
 * y vuelta de herramientas, el streaming, la contabilidad— es identico, asi
 * que vive una sola vez aca.
 */

export type LlmTier = Exclude<Tier, 'reflex'>;

export interface ResolvedModel {
  /** Identificador legible, para la traza. */
  id: string;
  /** Lo que se le pasa al AI SDK: un string o un LanguageModel. */
  model: unknown;
}

export abstract class AiSdkModel implements ModelClient {
  abstract readonly kind: string;

  /** Traduce un tier logico al modelo concreto que lo atiende. */
  protected abstract resolveModel(tier: LlmTier): ResolvedModel;

  /** USD de una llamada. Un modelo local devuelve 0. */
  protected abstract costOf(id: string, inputTokens: number, outputTokens: number): number;

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const { id, model } = this.resolveModel(req.tier);
    const { generateText } = await import('ai');

    const res = await generateText(this.params(req, model) as never);

    return this.toResponse({
      id,
      started,
      text: res.text,
      usage: res.usage,
      rawCalls: res.toolCalls,
    });
  }

  async generateStream(req: ModelRequest, onDelta: (delta: string) => void): Promise<ModelResponse> {
    const started = Date.now();
    const { id, model } = this.resolveModel(req.tier);
    const { streamText } = await import('ai');

    const result = streamText(this.params(req, model) as never);
    for await (const delta of result.textStream) onDelta(delta);

    const [text, usage, rawCalls] = await Promise.all([result.text, result.usage, result.toolCalls]);
    return this.toResponse({ id, started, text, usage, rawCalls });
  }

  // -------------------------------------------------------------------------

  private params(req: ModelRequest, model: unknown): Record<string, unknown> {
    const tools = buildTools(req);
    return {
      model,
      ...(req.system ? { system: req.system } : {}),
      messages: buildMessages(req),
      ...(tools ? { tools } : {}),
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.signal ? { abortSignal: req.signal } : {}),
    };
  }

  private toResponse(args: {
    id: string;
    started: number;
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    rawCalls?: unknown[];
  }): ModelResponse {
    const inputTokens = args.usage?.inputTokens ?? 0;
    const outputTokens = args.usage?.outputTokens ?? 0;

    const toolCalls: ToolCall[] = (args.rawCalls ?? []).map((tc) => ({
      id: (tc as { toolCallId: string }).toolCallId,
      name: (tc as { toolName: string }).toolName,
      args: (tc as { input?: unknown }).input,
    }));

    return {
      text: args.text,
      model: args.id,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: this.costOf(args.id, inputTokens, outputTokens),
        ms: Date.now() - args.started,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

/**
 * Reconstruye el ida y vuelta de herramientas para que el modelo vea lo que
 * pidio y lo que le contestamos.
 */
export function buildMessages(req: ModelRequest): unknown[] {
  const messages: unknown[] = [
    ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: req.prompt },
  ];

  for (const turn of req.toolTurns ?? []) {
    messages.push({
      role: 'assistant',
      content: turn.calls.map((c) => ({
        type: 'tool-call',
        toolCallId: c.id,
        toolName: c.name,
        input: c.args,
      })),
    });
    messages.push({
      role: 'tool',
      content: turn.results.map((r) => ({
        type: 'tool-result',
        toolCallId: r.id,
        toolName: r.name,
        output: { type: 'text', value: r.content },
      })),
    });
  }
  return messages;
}

/**
 * Se pasan sin `execute`: asi el SDK devuelve la intencion de llamada en vez de
 * ejecutarla, y el gate de confirmacion sigue siendo nuestro.
 */
export function buildTools(req: ModelRequest): Record<string, unknown> | undefined {
  if (!req.tools?.length) return undefined;
  return Object.fromEntries(
    req.tools.map((t) => [t.name, { description: t.description, inputSchema: t.schema }]),
  );
}
