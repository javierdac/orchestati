import { withRetry } from './retry.js';
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
  /** El modelo rechaza `temperature`: no se la mandamos. */
  omitTemperature?: boolean;
}

export abstract class AiSdkModel implements ModelClient {
  abstract readonly kind: string;

  /** Reintentos ante fallas transitorias del proveedor. */
  protected retries = Number(process.env.ORCHESTATI_RETRIES ?? 3);

  /** Traduce un tier logico al modelo concreto que lo atiende. */
  protected abstract resolveModel(tier: LlmTier): ResolvedModel;

  /** USD de una llamada. Un modelo local devuelve 0. */
  protected abstract costOf(id: string, inputTokens: number, outputTokens: number): number;

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const resolved = this.resolveModel(req.tier);
    const { id } = resolved;
    const { generateText } = await import('ai');

    const res = await withRetry(() => generateText(this.params(req, resolved) as never), {
      attempts: this.retries,
      ...(req.signal ? { signal: req.signal } : {}),
    });

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
    const resolved = this.resolveModel(req.tier);
    const { id } = resolved;
    const { streamText } = await import('ai');

    /**
     * Los deltas se emiten apenas llegan —bufferearlos para poder reintentar
     * anularia el streaming, que es el punto—, asi que solo se reintenta
     * mientras no se haya emitido nada. Una vez que el usuario vio texto,
     * rehacer la llamada se lo mostraria duplicado.
     *
     * No es una perdida grande: 429 y 503 llegan al abrir la peticion, antes
     * del primer token, que es exactamente el caso que esto cubre.
     */
    let emitido = false;
    const { text, usage, rawCalls } = await withRetry(
      async () => {
        const result = streamText(this.params(req, resolved) as never);
        for await (const delta of result.textStream) {
          emitido = true;
          onDelta(delta);
        }
        const [t, u, c] = await Promise.all([result.text, result.usage, result.toolCalls]);
        return { text: t, usage: u, rawCalls: c };
      },
      {
        attempts: this.retries,
        canRetry: () => !emitido,
        ...(req.signal ? { signal: req.signal } : {}),
      },
    );
    return this.toResponse({ id, started, text, usage, rawCalls });
  }

  // -------------------------------------------------------------------------

  private params(req: ModelRequest, resolved: ResolvedModel): Record<string, unknown> {
    const tools = buildTools(req);
    const mandaTemperature = req.temperature !== undefined && !resolved.omitTemperature;
    return {
      model: resolved.model,
      ...(req.system ? { system: req.system } : {}),
      messages: buildMessages(req),
      ...(tools ? { tools } : {}),
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(mandaTemperature ? { temperature: req.temperature } : {}),
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
