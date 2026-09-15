import { AiSdkModel, type LlmTier, type ResolvedModel } from './ai-sdk-base.js';

/**
 * Cliente para cualquier endpoint compatible con OpenAI.
 *
 * Eso cubre casi todas las formas gratis o baratas de probar esto: los niveles
 * gratuitos de Gemini —que expone un endpoint compatible—, Groq y OpenRouter,
 * y tambien Ollama o LM Studio si alguna vez se quiere correr en la maquina.
 * Un solo cliente, un preset por destino.
 */

export interface ModelLimits {
  /** Peticiones por minuto. */
  rpm?: number;
  /** Tokens por minuto. Suele ser el que ata primero. */
  tpm?: number;
  /** Peticiones por dia. */
  rpd?: number;
  /** Tokens por dia. */
  tpd?: number;
}

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
  /**
   * Limites de uso por modelo, cuando se conocen.
   *
   * No es un detalle administrativo: una configuracion mas barata que no
   * aguanta tu concurrencia no es mas barata, es inviable. El limite de tokens
   * por minuto suele atar antes que el de peticiones.
   */
  limits?: Record<string, ModelLimits>;
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
    // Aproximado, referencia 2026-09.
    pricing: {
      'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
      'gemini-2.5-flash': { in: 0.3, out: 2.5 },
      'gemini-2.5-pro': { in: 1.25, out: 10 },
    },
    fallbackPricing: { in: 2, out: 10 },
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
    // El catalogo de Groq cambia seguido: estos ids salieron de su propia API
    // (`pnpm models groq`), no de memoria. Si algo falla con "model not found",
    // volve a correr ese comando antes que suponer.
    models: {
      light: 'openai/gpt-oss-20b',
      standard: 'qwen/qwen3.8-27b',
      deep: 'openai/gpt-oss-120b',
      swarm: 'openai/gpt-oss-20b',
    },
    // Sin tabla de precios propia: no la se y no la voy a inventar. El
    // fallback conservador hace que el barrido los marque como estimados.
    fallbackPricing: { in: 0.5, out: 1 },
    // Limites del nivel gratuito, leidos de la consola de Groq (2026-09).
    limits: {
      'openai/gpt-oss-120b': { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 },
      'openai/gpt-oss-20b': { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 },
      'qwen/qwen3.8-27b': { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 },
      'groq/compound': { rpm: 30, tpm: 70_000, rpd: 250 },
      'allam-2-7b': { rpm: 30, tpm: 6_000, rpd: 7_000, tpd: 500_000 },
    },
  },
  xai: {
    label: 'xAI / Grok',
    baseURL: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    models: {
      light: 'grok-3-mini',
      standard: 'grok-3',
      deep: 'grok-4',
      swarm: 'grok-3',
    },
    fallbackPricing: { in: 5, out: 15 },
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
    // Aproximado, referencia 2026-09.
    pricing: {
      'deepseek-chat': { in: 0.27, out: 1.1 },
      'deepseek-reasoner': { in: 0.55, out: 2.19 },
    },
    fallbackPricing: { in: 1, out: 4 },
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

  describeTier(tier: LlmTier): {
    model: string;
    price?: { in: number; out: number; known: boolean };
    limits?: ModelLimits;
  } {
    const id = modelForTierIn(this.preset, tier, this.overrides);
    const price = priceOf(`${this.name}:${id}`);
    const limits = this.preset.limits?.[id];
    return { model: `${this.name}:${id}`, ...(price ? { price } : {}), ...(limits ? { limits } : {}) };
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

/** ¿Se puede usar este preset ahora mismo? */
export function presetUsable(nombre: PresetName): boolean {
  const p: EndpointPreset = PRESETS[nombre];
  return p.local ? false : p.keyEnv.some((v) => process.env[v]);
}

/** Presets con credencial configurada en el entorno. Los locales no cuentan. */
export function presetsWithCredentials(): PresetName[] {
  return (Object.entries(PRESETS) as Array<[PresetName, EndpointPreset]>)
    .filter(([, p]) => !p.local && p.keyEnv.some((v) => process.env[v]))
    .map(([name]) => name);
}

export interface PriceInfo {
  in: number;
  out: number;
  /** El precio salio de la tabla o es el fallback conservador del preset. */
  known: boolean;
}

/** Precio de un `proveedor:modelo` (o de un modelo del preset indicado). */
export function priceOf(spec: string, fallbackPreset?: PresetName): PriceInfo | undefined {
  const { preset, model } = parseTierSpec(spec);
  const nombre = preset ?? fallbackPreset;
  if (!nombre) return undefined;

  // `satisfies` conserva el tipo literal de cada preset, asi que el acceso
  // por indice da una union donde no todos los miembros tienen `pricing`.
  const p: EndpointPreset = PRESETS[nombre];
  if (p.local) return { in: 0, out: 0, known: true };

  const exacto = p.pricing?.[model];
  if (exacto) return { ...exacto, known: true };
  return p.fallbackPricing ? { ...p.fallbackPricing, known: false } : undefined;
}

export interface PricedModel {
  spec: string;
  price: { in: number; out: number };
  local: boolean;
  /**
   * Escalones para los que algun preset designa este modelo.
   *
   * Es el proxy de capacidad que tenemos sin evaluarlos: quien escribio el
   * preset decidio que modelo sirve para que escalon. Sin esto, ordenar por
   * precio propone un modelo de 8B para el escalon `deep`, que es justamente
   * el que existe para los pedidos que ese modelo no puede resolver.
   */
  tiers: LlmTier[];
  /** El precio salio del fallback del preset, no de una tabla. */
  estimated: boolean;
}

/** Todos los modelos con precio conocido, como `proveedor:modelo`. */
export function pricedModels(): PricedModel[] {
  const out: PricedModel[] = [];

  for (const [nombre, preset] of Object.entries(PRESETS) as Array<[PresetName, EndpointPreset]>) {
    const tiersDe = (modelo: string): LlmTier[] =>
      (Object.entries(preset.models) as Array<[LlmTier, string]>)
        .filter(([, m]) => m === modelo)
        .map(([t]) => t);

    if (preset.local) {
      for (const m of new Set(Object.values(preset.models))) {
        out.push({ spec: `${nombre}:${m}`, price: { in: 0, out: 0 }, local: true, tiers: tiersDe(m), estimated: false });
      }
      continue;
    }

    for (const [m, price] of Object.entries(preset.pricing ?? {})) {
      out.push({ spec: `${nombre}:${m}`, price, local: false, tiers: tiersDe(m), estimated: false });
    }

    /**
     * Los modelos que el preset designa por escalon entran igual aunque no
     * tengan precio propio, usando el fallback y marcados como estimados.
     *
     * Sin esto, un proveedor con precios desconocidos quedaba invisible para
     * el afinador aunque estuviera configurado y andando: no se lo podia ni
     * considerar, que es peor que considerarlo con un precio conservador.
     */
    if (preset.fallbackPricing) {
      for (const m of new Set(Object.values(preset.models))) {
        if (preset.pricing?.[m]) continue;
        out.push({ spec: `${nombre}:${m}`, price: preset.fallbackPricing, local: false, tiers: tiersDe(m), estimated: true });
      }
    }
  }
  return out;
}

/** Limites conocidos de un `proveedor:modelo`. */
export function limitsOf(spec: string, fallbackPreset?: PresetName): ModelLimits | undefined {
  const { preset, model } = parseTierSpec(spec);
  const nombre = preset ?? fallbackPreset;
  if (!nombre) return undefined;
  const p: EndpointPreset = PRESETS[nombre];
  return p.limits?.[model];
}
