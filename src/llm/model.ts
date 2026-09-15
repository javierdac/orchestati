import { AiSdkModel, type LlmTier, type ResolvedModel } from './ai-sdk-base.js';
import { OpenAICompatibleModel, PRESETS, isPresetName, presetsWithCredentials } from './openai-compatible.js';
import { createMixedModel } from './mixed.js';
import type { PresetName } from './openai-compatible.js';
import type { ModelClient, ModelRequest, ModelResponse, Tier, ToolCall } from '../core/types.js';

/**
 * Capa de modelo. El orquestador nunca habla con un proveedor directamente:
 * pide un `tier` logico y esta capa lo mapea a un modelo concreto.
 */

const DEFAULT_MODELS: Record<LlmTier, string> = {
  light: 'anthropic/claude-haiku-4-5',
  standard: 'anthropic/claude-sonnet-5',
  deep: 'anthropic/claude-opus-5',
  swarm: 'anthropic/claude-sonnet-5',
};

/**
 * USD por millon de tokens (entrada, salida). Tarifas de primera parte de
 * Anthropic, referencia 2026-06. Bedrock y Vertex cobran distinto.
 *
 * Esto alimenta el corte por presupuesto, asi que un numero inflado no es
 * inofensivo: corta corridas que en realidad entraban en el budget.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic/claude-sonnet-5': { in: 2, out: 10 },
  'anthropic/claude-sonnet-4-6': { in: 3, out: 15 },
  'anthropic/claude-opus-5': { in: 5, out: 25 },
  'anthropic/claude-opus-4-8': { in: 5, out: 25 },
  'anthropic/claude-fable-5-1': { in: 10, out: 50 },
};

/**
 * Para un modelo que no esta en la tabla se asume caro. En un control de
 * presupuesto, sobrestimar corta de mas y subestimar gasta de mas: la primera
 * se nota y se corrige, la segunda aparece en la factura.
 */
const PRICING_DESCONOCIDO = { in: 10, out: 50 };

export function modelForTier(tier: LlmTier): string {
  const env = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`];
  return env && env.trim() ? env.trim() : DEFAULT_MODELS[tier];
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING_DESCONOCIDO;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/**
 * Cliente real via Vercel AI Gateway. Usa strings "provider/model", asi que
 * cambiar de proveedor es cambiar una variable de entorno.
 */
export class GatewayModel extends AiSdkModel {
  readonly kind = 'gateway';

  protected resolveModel(tier: LlmTier): ResolvedModel {
    // El gateway acepta el string "provider/model" directamente, asi que
    // cambiar de proveedor es cambiar una variable de entorno.
    const id = modelForTier(tier);
    return { id, model: id };
  }

  protected costOf(id: string, inputTokens: number, outputTokens: number): number {
    return estimateCost(id, inputTokens, outputTokens);
  }

  describeTier(tier: LlmTier): { model: string; price?: { in: number; out: number; known: boolean } } {
    const model = modelForTier(tier);
    const p = PRICING[model];
    return { model, ...(p ? { price: { ...p, known: true } } : {}) };
  }
}

/**
 * Cliente falso, determinista. Permite correr y testear el orquestador entero
 * sin API key y sin gastar un peso: lo que importa aca es el ruteo.
 */
export class MockModel implements ModelClient {
  readonly kind = 'mock';

  constructor(private latencyMs = 0) {}

  describeTier(tier: LlmTier): { model: string } {
    return { model: `mock:${modelForTier(tier)}` };
  }

  /** Corta la respuesta en fragmentos para ejercitar el camino de streaming. */
  async generateStream(req: ModelRequest, onDelta: (delta: string) => void): Promise<ModelResponse> {
    const res = await this.generate(req);
    const CHUNK = 16;
    for (let i = 0; i < res.text.length; i += CHUNK) {
      onDelta(res.text.slice(i, i + CHUNK));
      if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    return res;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const model = `mock:${modelForTier(req.tier)}`;

    // Si hay herramientas y todavia no se uso ninguna, elige una de forma
    // deterministica. Alcanza para ejercitar el loop completo sin API key.
    const toolCall = (req.toolTurns ?? []).length === 0 ? planToolCall(req) : undefined;
    if (toolCall) {
      const usedIn = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4);
      return {
        text: '',
        model,
        usage: {
          inputTokens: usedIn,
          outputTokens: 20,
          costUsd: estimateCost(modelForTier(req.tier), usedIn, 20),
          ms: Date.now() - started,
        },
        toolCalls: [toolCall],
      };
    }

    const resultados = (req.toolTurns ?? [])
      .flatMap((t) => t.results)
      .map((r) => `${r.name} → ${r.content.split('\n')[0]}`)
      .join(' | ');

    const head = req.prompt.replace(/\s+/g, ' ').slice(0, 160);
    const text = resultados
      ? `[${model}] segun las herramientas: ${resultados}`
      : `[${model}] ${head}${req.prompt.length > 160 ? '…' : ''}`;

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

/**
 * Elige una herramienta a partir del texto del pedido. Es tosco a proposito:
 * el objetivo no es razonar bien sino que el loop de herramientas sea
 * ejecutable y testeable sin proveedor.
 */
function planToolCall(req: ModelRequest): ToolCall | undefined {
  const names = new Set((req.tools ?? []).map((t) => t.name));
  if (names.size === 0) return undefined;
  const prompt = req.prompt;

  if (names.has('calculator')) {
    const expr = prompt.match(/[\d(][\d\s+\-*/%^().]*\d\s*\)?/g)?.find((e) => /[+\-*/%^]/.test(e));
    if (expr) return { id: 'mock-1', name: 'calculator', args: { expression: expr.trim() } };
  }

  if (names.has('read_file')) {
    const path = prompt.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|ya?ml|sql)\b/)?.[0];
    if (path) return { id: 'mock-1', name: 'read_file', args: { path } };
  }

  if (names.has('search_code')) {
    const quoted = prompt.match(/["'`]([^"'`\n]{3,40})["'`]/)?.[1];
    if (quoted) return { id: 'mock-1', name: 'search_code', args: { pattern: quoted } };
  }

  if (names.has('run_command') && /\b(corre|ejecuta|corre(r|me)?|run|ejecutame)\b/.test(prompt)) {
    const cmd = prompt.match(/\b(git|pnpm|npm|npx|node|tsc|vitest|ls|cat)\s+[\w.:/-]+(\s+[\w.:/-]+)?/)?.[0];
    if (cmd) return { id: 'mock-1', name: 'run_command', args: { command: cmd.trim() } };
  }

  if (names.has('list_dir')) return { id: 'mock-1', name: 'list_dir', args: { path: '.' } };
  return undefined;
}

/**
 * Elige el backend.
 *
 * Orden: lo que diga `ORCHESTATI_PROVIDER`, si no el gateway con credenciales,
 * si no el primer endpoint compatible que tenga key (Gemini, Groq, OpenRouter),
 * si no el mock.
 *
 * Los backends locales (ollama, lmstudio) NO se autodetectan: hay que pedirlos
 * explicitamente con `ORCHESTATI_PROVIDER=ollama`. Que un servidor este
 * escuchando no significa que se lo quiera usar.
 */
export async function createModelClient(): Promise<ModelClient> {
  const forzado = process.env.ORCHESTATI_PROVIDER?.trim().toLowerCase();

  if (forzado === 'mock') return new MockModel();
  if (forzado === 'gateway') return new GatewayModel();
  if (forzado && !isPresetName(forzado)) {
    throw new Error(`ORCHESTATI_PROVIDER desconocido: ${forzado}`);
  }

  const base: PresetName | undefined = forzado && isPresetName(forzado) ? forzado : presetsWithCredentials()[0];

  if (base) {
    const cliente = await new OpenAICompatibleModel(PRESETS[base], base).init();
    // Si algun escalon nombra otro proveedor, se arma un cliente mezclado.
    return (await createMixedModel(base, cliente)) ?? cliente;
  }

  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) return new GatewayModel();
  return new MockModel();
}

/** Version sincronica, para constructores que no pueden esperar. */
export function createModelClientSync(): ModelClient {
  const forzado = process.env.ORCHESTATI_PROVIDER?.trim().toLowerCase();
  if (forzado === 'gateway') return new GatewayModel();
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) return new GatewayModel();
  return new MockModel();
}
