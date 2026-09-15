import { afterEach, describe, expect, it } from 'vitest';
import { parseTierSpec, PRESETS, modelForTierIn } from '../src/llm/openai-compatible.js';
import { createMixedModel, MixedModel, TIERS } from '../src/llm/mixed.js';
import { MockModel } from '../src/llm/model.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/core/types.js';

const VARS = ['ORCHESTATI_MODEL_LIGHT', 'ORCHESTATI_MODEL_STANDARD', 'ORCHESTATI_MODEL_DEEP', 'ORCHESTATI_MODEL_SWARM'];
const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    if (original[v] === undefined) delete process.env[v];
    else process.env[v] = original[v];
  }
});

const limpiar = (): void => { for (const v of VARS) delete process.env[v]; };

describe('parseTierSpec', () => {
  it('separa proveedor y modelo', () => {
    expect(parseTierSpec('groq:llama-3.3-70b-versatile')).toEqual({
      preset: 'groq', model: 'llama-3.3-70b-versatile',
    });
    expect(parseTierSpec('openai:gpt-4.1')).toEqual({ preset: 'openai', model: 'gpt-4.1' });
  });

  it('sin prefijo es solo un modelo', () => {
    expect(parseTierSpec('gpt-4.1-nano')).toEqual({ model: 'gpt-4.1-nano' });
  });

  it('no confunde un id de ollama con un proveedor', () => {
    // "qwen3:8b" lleva dos puntos pero "qwen3" no es un preset.
    expect(parseTierSpec('qwen3:8b')).toEqual({ model: 'qwen3:8b' });
    expect(parseTierSpec('moonshotai/kimi-k2:free')).toEqual({ model: 'moonshotai/kimi-k2:free' });
  });

  it('el prefijo tiene que ser un preset conocido', () => {
    expect(parseTierSpec('inventado:modelo')).toEqual({ model: 'inventado:modelo' });
  });
});

describe('modelForTierIn', () => {
  it('el override explicito gana sobre el entorno y el preset', () => {
    limpiar();
    process.env.ORCHESTATI_MODEL_LIGHT = 'del-entorno';
    expect(modelForTierIn(PRESETS.openai, 'light', { light: 'explicito' })).toBe('explicito');
  });

  it('el entorno gana sobre el preset, y le saca el prefijo de proveedor', () => {
    limpiar();
    process.env.ORCHESTATI_MODEL_LIGHT = 'groq:llama-3.1-8b-instant';
    // El cliente de groq recibe el id pelado, sin el prefijo.
    expect(modelForTierIn(PRESETS.openai, 'light')).toBe('llama-3.1-8b-instant');
  });

  it('sin nada configurado usa el preset', () => {
    limpiar();
    expect(modelForTierIn(PRESETS.openai, 'deep')).toBe('gpt-4.1');
  });
});

describe('createMixedModel', () => {
  it('no mezcla nada si ningun escalon nombra otro proveedor', async () => {
    limpiar();
    process.env.ORCHESTATI_MODEL_LIGHT = 'gpt-4.1-nano';
    expect(await createMixedModel('openai', new MockModel())).toBeUndefined();
  });

  it('mezcla cuando un escalon apunta a otro proveedor', async () => {
    limpiar();
    process.env.ORCHESTATI_MODEL_LIGHT = 'groq:llama-3.1-8b-instant';
    process.env.ORCHESTATI_MODEL_DEEP = 'openai:gpt-4.1';

    const mixed = await createMixedModel('openai', new MockModel());
    expect(mixed).toBeInstanceOf(MixedModel);

    const mapa = Object.fromEntries(mixed!.describe().map((d) => [d.tier, d.label]));
    expect(mapa.light).toBe('groq:llama-3.1-8b-instant');
    expect(mapa.deep).toBe('openai:gpt-4.1');
    // El escalon sin configurar cae al proveedor base.
    expect(mapa.standard).toContain('openai');
  });

  it('los escalones sin proveedor propio usan el cliente base', async () => {
    limpiar();
    process.env.ORCHESTATI_MODEL_LIGHT = 'groq:llama-3.1-8b-instant';

    const base = new MockModel();
    const mixed = (await createMixedModel('openai', base))!;
    // standard, deep y swarm delegan en el base.
    const res = await mixed.generate({ tier: 'standard', prompt: 'hola' });
    expect(res.model).toContain('mock');
  });
});

describe('MixedModel', () => {
  class Espia implements ModelClient {
    readonly kind: string;
    llamadas: string[] = [];
    constructor(private etiqueta: string) { this.kind = etiqueta; }
    async generate(r: ModelRequest): Promise<ModelResponse> {
      this.llamadas.push(r.tier);
      return { text: this.etiqueta, model: this.etiqueta, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, ms: 0 } };
    }
  }

  it('manda cada escalon a su propio cliente', async () => {
    const barato = new Espia('barato');
    const caro = new Espia('caro');
    const mixed = new MixedModel({
      light: { client: barato, label: 'barato' },
      standard: { client: barato, label: 'barato' },
      deep: { client: caro, label: 'caro' },
      swarm: { client: barato, label: 'barato' },
    });

    expect((await mixed.generate({ tier: 'light', prompt: 'x' })).text).toBe('barato');
    expect((await mixed.generate({ tier: 'deep', prompt: 'x' })).text).toBe('caro');
    expect(barato.llamadas).toEqual(['light']);
    expect(caro.llamadas).toEqual(['deep']);
  });

  it('describe la mezcla en su kind, para que quede en la traza', () => {
    const c = new MockModel();
    const mixed = new MixedModel(
      Object.fromEntries(TIERS.map((t) => [t, { client: c, label: `x:${t}` }])) as never,
    );
    expect(mixed.kind).toContain('mixed(');
    expect(mixed.kind).toContain('deep=x:deep');
  });

  it('cae a generate si el cliente del escalon no sabe streamear', async () => {
    const sinStream = new Espia('sin-stream');
    const mixed = new MixedModel(
      Object.fromEntries(TIERS.map((t) => [t, { client: sinStream, label: 'x' }])) as never,
    );
    const res = await mixed.generateStream({ tier: 'light', prompt: 'x' }, () => {});
    expect(res.text).toBe('sin-stream');
  });
});
