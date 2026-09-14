import type { ModelClient, ModelRequest, ModelResponse, Tier } from '../core/types.js';

/**
 * Capa de modelo. El orquestador nunca habla con un proveedor directamente:
 * pide un `tier` logico y esta capa lo mapea a un modelo concreto.
 */

type LlmTier = Exclude<Tier, 'reflex'>;

const DEFAULT_MODELS: Record<LlmTier, string> = {
  light: 'anthropic/claude-haiku-4-5',
  standard: 'anthropic/claude-sonnet-5',
  deep: 'anthropic/claude-opus-5',
  swarm: 'anthropic/claude-sonnet-5',
};

/** USD por millon de tokens (entrada, salida). Aproximado, solo para el budget. */
const PRICING: Record<string, { in: number; out: number }> = {
  'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic/claude-sonnet-5': { in: 3, out: 15 },
  'anthropic/claude-opus-5': { in: 15, out: 75 },
};

export function modelForTier(tier: LlmTier): string {
  const env = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`];
  return env && env.trim() ? env.trim() : DEFAULT_MODELS[tier];
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { in: 3, out: 15 };
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/**
 * Cliente real via Vercel AI Gateway. Usa strings "provider/model", asi que
 * cambiar de proveedor es cambiar una variable de entorno.
 */
export class GatewayModel implements ModelClient {
  readonly kind = 'gateway';

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const model = modelForTier(req.tier);

    const { generateText } = await import('ai');
    const messages = [
      ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: req.prompt },
    ];

    const res = await generateText({
      model,
      ...(req.system ? { system: req.system } : {}),
      messages: messages as never,
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.signal ? { abortSignal: req.signal } : {}),
    });

    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;

    return {
      text: res.text,
      model,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(model, inputTokens, outputTokens),
        ms: Date.now() - started,
      },
    };
  }
}

/**
 * Cliente falso, determinista. Permite correr y testear el orquestador entero
 * sin API key y sin gastar un peso: lo que importa aca es el ruteo.
 */
export class MockModel implements ModelClient {
  readonly kind = 'mock';

  constructor(private latencyMs = 0) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const model = `mock:${modelForTier(req.tier)}`;
    const head = req.prompt.replace(/\s+/g, ' ').slice(0, 160);
    const text = `[${model}] ${head}${req.prompt.length > 160 ? '…' : ''}`;

    const inputTokens = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4);
    const outputTokens = Math.ceil(text.length / 4);

    return {
      text,
      model,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(modelForTier(req.tier), inputTokens, outputTokens),
        ms: Date.now() - started,
      },
    };
  }
}

/** Devuelve el cliente real si hay credenciales; si no, el mock. */
export function createModelClient(): ModelClient {
  const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  return hasKey ? new GatewayModel() : new MockModel();
}
