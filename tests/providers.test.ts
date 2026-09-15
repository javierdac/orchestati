import { afterEach, describe, expect, it } from 'vitest';
import { createModelClient, createModelClientSync } from '../src/llm/model.js';
import {
  PRESETS,
  isPresetName,
  modelForTierIn,
  presetsWithCredentials,
} from '../src/llm/openai-compatible.js';

const VARS = [
  'ORCHESTATI_PROVIDER',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'ORCHESTATI_MODEL_LIGHT',
];
const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    if (original[v] === undefined) delete process.env[v];
    else process.env[v] = original[v];
  }
});

function limpiar() {
  for (const v of VARS) delete process.env[v];
}

describe('seleccion de backend', () => {
  it('sin nada configurado usa el mock', async () => {
    limpiar();
    expect((await createModelClient()).kind).toBe('mock');
    expect(createModelClientSync().kind).toBe('mock');
  });

  it('NO autodetecta backends locales', async () => {
    limpiar();
    // Aunque hubiera un ollama escuchando, no se usa sin pedirlo: que un
    // servidor este levantado no significa que se lo quiera usar.
    const client = await createModelClient();
    expect(client.kind).not.toBe('ollama');
    expect(client.kind).not.toBe('lmstudio');
  });

  it('usa el gateway cuando hay credencial', async () => {
    limpiar();
    process.env.AI_GATEWAY_API_KEY = 'x';
    expect((await createModelClient()).kind).toBe('gateway');
  });

  it('usa un endpoint compatible cuando hay key de ese proveedor', async () => {
    limpiar();
    process.env.GEMINI_API_KEY = 'x';
    expect((await createModelClient()).kind).toBe('gemini');

    limpiar();
    process.env.GROQ_API_KEY = 'x';
    expect((await createModelClient()).kind).toBe('groq');
  });

  it('ORCHESTATI_PROVIDER manda sobre la autodeteccion', async () => {
    limpiar();
    process.env.GEMINI_API_KEY = 'x';
    process.env.ORCHESTATI_PROVIDER = 'mock';
    expect((await createModelClient()).kind).toBe('mock');
  });

  it('un proveedor desconocido falla fuerte en vez de caer al mock en silencio', async () => {
    limpiar();
    process.env.ORCHESTATI_PROVIDER = 'inventado';
    await expect(createModelClient()).rejects.toThrow('desconocido');
  });

  it('lo local solo entra si se lo pide explicitamente', async () => {
    limpiar();
    process.env.ORCHESTATI_PROVIDER = 'ollama';
    expect((await createModelClient()).kind).toBe('ollama');
  });
});

describe('presets', () => {
  it('todos declaran los cuatro tiers', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const tier of ['light', 'standard', 'deep', 'swarm'] as const) {
        expect(preset.models[tier], `${name}.${tier}`).toBeTruthy();
      }
    }
  });

  it('los locales no piden credencial y los remotos si', () => {
    for (const preset of Object.values(PRESETS)) {
      if (preset.local) expect(preset.keyEnv).toEqual([]);
      else expect(preset.keyEnv.length).toBeGreaterThan(0);
    }
  });

  it('el entorno pisa el modelo del preset', () => {
    limpiar();
    expect(modelForTierIn(PRESETS.gemini, 'light')).toBe('gemini-2.5-flash-lite');
    process.env.ORCHESTATI_MODEL_LIGHT = 'otro-modelo';
    expect(modelForTierIn(PRESETS.gemini, 'light')).toBe('otro-modelo');
  });

  it('presetsWithCredentials ignora los locales', () => {
    limpiar();
    expect(presetsWithCredentials()).toEqual([]);
    process.env.OPENROUTER_API_KEY = 'x';
    expect(presetsWithCredentials()).toEqual(['openrouter']);
  });

  it('isPresetName distingue lo valido', () => {
    expect(isPresetName('gemini')).toBe(true);
    expect(isPresetName('gpt5')).toBe(false);
  });
});
