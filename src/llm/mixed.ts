import type { ModelClient, ModelRequest, ModelResponse } from '../core/types.js';
import type { LlmTier } from './ai-sdk-base.js';
import {
  OpenAICompatibleModel,
  PRESETS,
  isPresetName,
  parseTierSpec,
  type PresetName,
} from './openai-compatible.js';

/**
 * Un proveedor distinto por escalon.
 *
 * Medido: entre escalones de un mismo proveedor la diferencia de precio suele
 * ser de ~5x, y como las estrategias `chain` y `parallel` corren dos o tres
 * agentes, el escalon medio termina costando lo mismo que una sola llamada al
 * caro. El ruteo deja de ahorrar.
 *
 * Mezclando proveedores la brecha pasa a ser de 10x a 40x —un Llama de 8B o un
 * Gemini Flash contra un modelo de frontera— y ahi el escalon barato vuelve a
 * tener sentido economico.
 */
export const TIERS: readonly LlmTier[] = ['light', 'standard', 'deep', 'swarm'];

export class MixedModel implements ModelClient {
  readonly kind: string;

  constructor(private porTier: Record<LlmTier, { client: ModelClient; label: string }>) {
    const resumen = TIERS.map((t) => `${t}=${porTier[t].label}`).join(' ');
    this.kind = `mixed(${resumen})`;
  }

  /** Que atiende cada escalon, para mostrarlo. */
  describe(): Array<{ tier: LlmTier; label: string }> {
    return TIERS.map((t) => ({ tier: t, label: this.porTier[t].label }));
  }

  describeTier(tier: LlmTier): { model: string; price?: { in: number; out: number; known: boolean } } {
    const { client, label } = this.porTier[tier];
    return client.describeTier?.(tier) ?? { model: label };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    return this.porTier[req.tier].client.generate(req);
  }

  async generateStream(req: ModelRequest, onDelta: (d: string) => void): Promise<ModelResponse> {
    const { client } = this.porTier[req.tier];
    return client.generateStream ? client.generateStream(req, onDelta) : client.generate(req);
  }
}

/**
 * Arma un cliente mezclado leyendo `ORCHESTATI_MODEL_<TIER>`.
 *
 * Cada escalon acepta `proveedor:modelo` o solo `modelo`, y en ese caso usa el
 * proveedor base. Devuelve `undefined` si ningun escalon nombra un proveedor
 * distinto: ahi no hace falta mezclar nada.
 */
export async function createMixedModel(
  basePreset: PresetName,
  base: ModelClient,
): Promise<MixedModel | undefined> {
  const specs = TIERS.map((t) => ({
    tier: t,
    spec: process.env[`ORCHESTATI_MODEL_${t.toUpperCase()}`]?.trim(),
  }));

  const conProveedor = specs.filter((s) => s.spec && parseTierSpec(s.spec).preset);
  if (conProveedor.length === 0) return undefined;

  // Un cliente por proveedor distinto, no uno por escalon: dos escalones del
  // mismo proveedor comparten conexion y configuracion.
  const clientes = new Map<PresetName, OpenAICompatibleModel>();
  const overrides = new Map<PresetName, Partial<Record<LlmTier, string>>>();

  for (const { tier, spec } of specs) {
    const parsed = spec ? parseTierSpec(spec) : undefined;
    if (!parsed?.preset) continue;
    const previo = overrides.get(parsed.preset) ?? {};
    previo[tier] = parsed.model;
    overrides.set(parsed.preset, previo);
  }

  for (const [preset, mapa] of overrides) {
    if (!isPresetName(preset)) continue;
    clientes.set(preset, await new OpenAICompatibleModel(PRESETS[preset], preset, mapa).init());
  }

  const porTier = {} as Record<LlmTier, { client: ModelClient; label: string }>;
  for (const { tier, spec } of specs) {
    const parsed = spec ? parseTierSpec(spec) : undefined;
    if (parsed?.preset) {
      porTier[tier] = { client: clientes.get(parsed.preset)!, label: `${parsed.preset}:${parsed.model}` };
    } else {
      porTier[tier] = { client: base, label: `${basePreset}:${parsed?.model ?? 'default'}` };
    }
  }

  return new MixedModel(porTier);
}
