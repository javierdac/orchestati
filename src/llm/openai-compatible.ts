import { AiSdkModel, type LlmTier, type ResolvedModel } from './ai-sdk-base.js';

/**
 * Cliente para cualquier endpoint compatible con OpenAI.
 *
 * Eso cubre casi todas las formas gratis o baratas de probar esto: los niveles
 * gratuitos de Gemini —que expone un endpoint compatible—, Groq y OpenRouter,
 * y tambien Ollama o LM Studio si alguna vez se quiere correr en la maquina.
 * Un solo cliente, un preset por destino.
 */

export interface EndpointPreset {
  /** Nombre legible del destino. */
  label: string;
  baseURL: string;
  /** Variables de entorno donde buscar la credencial, en orden. */
  keyEnv: string[];
  /** Modelo por tier. Todos se pueden pisar con ORCHESTATI_MODEL_<TIER>. */
  models: Record<LlmTier, string>;
  /** USD por millon de tokens, cuando se conocen. */
  pricing?: Record<string, { in: number; out: number }>;
  /**
   * Tarifa a asumir para un modelo que no esta en `pricing`. En un proveedor
   * pago, costo 0 desactivaria el corte por presupuesto sin avisar: mejor
   * asumir caro y que corte de mas.
   */
  fallbackPricing?: { in: number; out: number };
  /**
   * Modelos que rechazan `temperature` distinta de 1 (los de razonamiento).
   * Mandarsela igual es un 400, asi que se omite para esos.
   */
  omitTemperature?: RegExp;
  /** Corre en la maquina: sin costo y sin red. */
  local?: boolean;
}

export const PRESETS = {
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    // Por defecto la familia 4.1: es barata y respeta `temperature`, que es
    // como los agentes se diferencian entre si. La familia gpt-5 se puede
    // pedir por entorno y se maneja sola (ver `omitTemperature`).
    models: {
      light: 'gpt-4.1-nano',
      standard: 'gpt-4.1-mini',
      deep: 'gpt-4.1',
      swarm: 'gpt-4.1-mini',
    },
    // USD por millon de tokens. Aproximado, referencia 2026-09.
    pricing: {
      'gpt-4.1-nano': { in: 0.1, out: 0.4 },
      'gpt-4.1-mini': { in: 0.4, out: 1.6 },
      'gpt-4.1': { in: 2, out: 8 },
      'gpt-4o-mini': { in: 0.15, out: 0.6 },
      'gpt-4o': { in: 2.5, out: 10 },
      'gpt-5-nano': { in: 0.05, out: 0.4 },
      'gpt-5-mini': { in: 0.25, out: 2 },
      'gpt-5': { in: 1.25, out: 10 },
    },
    fallbackPricing: { in: 5, out: 20 },
    omitTemperature: /^(gpt-5|o[134])/,
  },
  gemini: {
    label: 'Gemini (nivel gratuito, via endpoint compatible con OpenAI)',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    models: {
      light: 'gemini-2.5-flash-lite',
      standard: 'gemini-2.5-flash',
      deep: 'gemini-2.5-pro',
      swarm: 'gemini-2.5-flash',
    },
  },
  groq: {
    label: 'Groq (nivel gratuito, modelos de pesos abiertos)',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
    models: {
      light: 'llama-3.1-8b-instant',
      standard: 'llama-3.3-70b-versatile',
      deep: 'llama-3.3-70b-versatile',
      swarm: 'llama-3.3-70b-versatile',
    },
  },
  moonshot: {
    label: 'Moonshot / Kimi',
    baseURL: 'https://api.moonshot.ai/v1',
    keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    models: {
      light: 'moonshot-v1-8k',
      standard: 'kimi-k2-0905-preview',
      deep: 'kimi-k2-0905-preview',
      swarm: 'kimi-k2-0905-preview',
    },
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    models: {
      light: 'deepseek-chat',
      standard: 'deepseek-chat',
      deep: 'deepseek-reasoner',
      swarm: 'deepseek-chat',
    },
  },
  cerebras: {
    label: 'Cerebras (modelos abiertos, muy rapido)',
    baseURL: 'https://api.cerebras.ai/v1',
    keyEnv: ['CEREBRAS_API_KEY'],
    models: {
      light: 'llama3.1-8b',
      standard: 'llama-3.3-70b',
      deep: 'llama-3.3-70b',
      swarm: 'llama-3.3-70b',
    },
  },
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    models: {
      light: 'meta-llama/llama-3.1-8b-instruct',
      standard: 'qwen/qwen3-32b',
      deep: 'qwen/qwen3-32b',
      swarm: 'qwen/qwen3-32b',
    },
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: 'http://127.0.0.1:11434/v1',
    keyEnv: [],
    local: true,
    models: {
      light: 'qwen3:1.7b',
      standard: 'qwen2.5:7b-instruct',
      deep: 'qwen2.5:7b-instruct',
      swarm: 'qwen2.5:7b-instruct',
    },
  },
  lmstudio: {
    label: 'LM Studio (local)',
    baseURL: 'http://127.0.0.1:1234/v1',
    keyEnv: [],
    local: true,
    models: {
      light: 'local-model',
      standard: 'local-model',
      deep: 'local-model',
      swarm: 'local-model',
    },
  },
} satisfies Record<string, EndpointPreset>;

export type PresetName = keyof typeof PRESETS;

export function isPresetName(name: string): name is PresetName {
  return name in PRESETS;
}

/**
 * Un escalon puede apuntar a otro proveedor: `groq:llama-3.3-70b-versatile`.
 *
 * Es lo que permite mezclar. La diferencia de precio entre escalones del mismo
 * proveedor suele ser de 5x, y con eso correr tres agentes en el escalon medio
 * cuesta lo mismo que uno en el caro. Entre proveedores la brecha es de 10x a
 * 40x, y ahi el ruteo recupera su sentido economico.
 */
export function parseTierSpec(spec: string): { preset?: PresetName; model: string } {
  const i = spec.indexOf(':');
  if (i === -1) return { model: spec.trim() };

  const posible = spec.slice(0, i).trim();
  // Ojo: un id de Ollama tambien lleva dos puntos ("qwen3:8b"), asi que solo
  // se interpreta como proveedor si es un preset conocido.
  if (!isPresetName(posible)) return { model: spec.trim() };
  return { preset: posible, model: spec.slice(i + 1).trim() };
}

/** El modelo configurado para un tier, con el entorno pisando el default. */
export function modelForTierIn(
  preset: EndpointPreset,
  tier: LlmTier,
  overrides?: Partial<Record<LlmTier, string>>,
): string {
  const propio = overrides?.[tier];
  if (propio) return propio;
  const env = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`];
  return parseTierSpec(env?.trim() || preset.models[tier]).model;
}

export class OpenAICompatibleModel extends AiSdkModel {
  readonly kind: string;
  private provider: ((id: string) => unknown) | undefined;

  constructor(
    private preset: EndpointPreset,
    private name: string,
    /** Modelo fijo por escalon, por encima del preset y del entorno. */
    private overrides?: Partial<Record<LlmTier, string>>,
  ) {
    super();
    this.kind = name;
  }

  protected resolveModel(tier: LlmTier): ResolvedModel {
    if (!this.provider) throw new Error(`${this.name}: falta llamar a init()`);
    const id = modelForTierIn(this.preset, tier, this.overrides);
    return {
      id: `${this.name}:${id}`,
      model: this.provider(id),
      // Los modelos de razonamiento tiran 400 si les mandas temperature.
      omitTemperature: this.preset.omitTemperature?.test(id) ?? false,
    };
  }

  protected costOf(id: string, inputTokens: number, outputTokens: number): number {
    if (this.preset.local) return 0;
    const bare = id.slice(this.name.length + 1);
    const p = this.preset.pricing?.[bare] ?? this.preset.fallbackPricing;
    // Sin tarifa conocida se asume cara: en un proveedor pago, costo 0
    // desactivaria el corte por presupuesto sin avisar.
    return p ? (inputTokens * p.in + outputTokens * p.out) / 1_000_000 : 0;
  }

  private apiKey(): string | undefined {
    return this.preset.keyEnv.map((v) => process.env[v]).find(Boolean);
  }

  private url(): string {
    return process.env.ORCHESTATI_BASE_URL?.trim() || this.preset.baseURL;
  }

  async init(): Promise<this> {
    if (this.provider) return this;
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');

    const provider = createOpenAICompatible({
      name: this.name,
      baseURL: this.url(),
      // Un servidor local no pide credencial, pero algunos clientes rechazan
      // la peticion sin el header: un valor cualquiera alcanza.
      apiKey: this.apiKey() ?? 'local',
      // Sin esto, un endpoint compatible no reporta tokens al streamear y la
      // traza miente diciendo 0.
      includeUsage: true,
    });
    this.provider = (id: string) => provider(id);
    return this;
  }

  /** Modelos que el endpoint declara tener. */
  async listModels(): Promise<string[]> {
    try {
      const key = this.apiKey();
      const res = await fetch(`${this.url()}/models`, {
        signal: AbortSignal.timeout(3000),
        ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      });
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }
}

/** Presets con credencial configurada en el entorno. Los locales no cuentan. */
export function presetsWithCredentials(): PresetName[] {
  return (Object.entries(PRESETS) as Array<[PresetName, EndpointPreset]>)
    .filter(([, p]) => !p.local && p.keyEnv.some((v) => process.env[v]))
    .map(([name]) => name);
}
