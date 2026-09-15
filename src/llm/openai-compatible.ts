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
  /** Corre en la maquina: sin costo y sin red. */
  local?: boolean;
}

export const PRESETS = {
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

/** El modelo configurado para un tier, con el entorno pisando el default. */
export function modelForTierIn(preset: EndpointPreset, tier: LlmTier): string {
  const env = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`];
  return env?.trim() || preset.models[tier];
}

export class OpenAICompatibleModel extends AiSdkModel {
  readonly kind: string;
  private provider: ((id: string) => unknown) | undefined;

  constructor(
    private preset: EndpointPreset,
    private name: string,
  ) {
    super();
    this.kind = name;
  }

  protected resolveModel(tier: LlmTier): ResolvedModel {
    if (!this.provider) throw new Error(`${this.name}: falta llamar a init()`);
    const id = modelForTierIn(this.preset, tier);
    return { id: `${this.name}:${id}`, model: this.provider(id) };
  }

  protected costOf(id: string, inputTokens: number, outputTokens: number): number {
    if (this.preset.local) return 0;
    const bare = id.slice(this.name.length + 1);
    const p = this.preset.pricing?.[bare];
    // Sin tarifa conocida no se inventa un numero: el corte por presupuesto no
    // puede basarse en una cifra imaginaria.
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
