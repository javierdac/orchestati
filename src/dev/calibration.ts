import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpenAICompatibleModel, PRESETS, parseTierSpec, isPresetName } from '../llm/openai-compatible.js';
import type { LlmTier } from '../llm/ai-sdk-base.js';

/**
 * Calibracion de verbosidad.
 *
 * El afinador calcula costo = tokens x precio. Conoce el precio con exactitud
 * y ESTIMA los tokens suponiendo que no cambian al cambiar de modelo. Ahi
 * estaba todo su error: gpt-oss-120b, un modelo de razonamiento, emitio 3072
 * tokens de salida donde gpt-4.1 emitio 965. Aun costando menos por token,
 * salia mas caro — y el barrido lo recomendaba.
 *
 * Esto mide esa diferencia en vez de suponerla, con unas pocas llamadas por
 * modelo. Es barato porque los tokens de ENTRADA practicamente no cambian: el
 * prompt lo escribimos nosotros. Lo que cambia es cuanto escribe cada modelo.
 */

export const RUTA_CALIBRACION = '.orchestati/calibration.json';

/**
 * Prompts de calibracion: cortos de pedir, con techos de respuesta muy
 * distintos. Un modelo verborragico se delata en el tercero.
 */
export const CALIBRATION_PROMPTS = [
  'Respondé en una sola palabra: ¿cuál es la capital de Francia?',
  'Explicá en dos oraciones qué es una función pura.',
  'Explicá cómo funciona un índice B-tree en una base de datos relacional, con sus implicancias de escritura.',
];

export interface MedicionModelo {
  /** Tokens de salida sumados sobre los prompts de calibracion. */
  outputTokens: number;
  inputTokens: number;
  samples: number;
  at: string;
  /** Fallo al medirlo (sin credencial, modelo inexistente, limite). */
  error?: string;
}

export type Calibracion = Record<string, MedicionModelo>;

export async function cargarCalibracion(): Promise<Calibracion> {
  try {
    return JSON.parse(await readFile(RUTA_CALIBRACION, 'utf8')) as Calibracion;
  } catch {
    return {};
  }
}

export async function guardarCalibracion(c: Calibracion): Promise<void> {
  await mkdir(dirname(RUTA_CALIBRACION), { recursive: true });
  await writeFile(RUTA_CALIBRACION, JSON.stringify(c, null, 2));
}

/** Mide cuanto escribe un modelo sobre los prompts de calibracion. */
export async function medirModelo(spec: string): Promise<MedicionModelo> {
  const { preset, model } = parseTierSpec(spec);
  if (!preset || !isPresetName(preset)) {
    return { outputTokens: 0, inputTokens: 0, samples: 0, at: new Date().toISOString(), error: 'proveedor desconocido' };
  }

  // Todos los tiers apuntan al mismo modelo: lo que se mide es el modelo.
  const overrides = { light: model, standard: model, deep: model, swarm: model } as Record<LlmTier, string>;
  const cliente = await new OpenAICompatibleModel(PRESETS[preset], preset, overrides).init();

  let outputTokens = 0;
  let inputTokens = 0;
  let samples = 0;

  for (const prompt of CALIBRATION_PROMPTS) {
    try {
      const r = await cliente.generate({ tier: 'standard', prompt, temperature: 0 });
      outputTokens += r.usage.outputTokens;
      inputTokens += r.usage.inputTokens;
      samples++;
    } catch (err) {
      return {
        outputTokens,
        inputTokens,
        samples,
        at: new Date().toISOString(),
        error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
      };
    }
  }

  return { outputTokens, inputTokens, samples, at: new Date().toISOString() };
}

/**
 * Cuanto mas (o menos) escribe `candidato` comparado con `referencia`.
 *
 * `undefined` cuando falta alguna de las dos medidas: es mejor que el barrido
 * diga "no lo se" a que aplique un factor inventado.
 */
export function factorVerbosidad(
  cal: Calibracion,
  candidato: string,
  referencia: string,
): { out: number; in: number } | undefined {
  const a = cal[candidato];
  const b = cal[referencia];
  if (!a || !b || a.error || b.error || a.samples === 0 || b.samples === 0) return undefined;
  if (b.outputTokens === 0 || b.inputTokens === 0) return undefined;

  return {
    out: a.outputTokens / b.outputTokens,
    in: a.inputTokens / b.inputTokens,
  };
}
