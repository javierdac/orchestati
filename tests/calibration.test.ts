import { describe, expect, it } from 'vitest';
import { factorVerbosidad, CALIBRATION_PROMPTS, type Calibracion } from '../src/dev/calibration.js';

const medicion = (out: number, inp = 100, over = {}) => ({
  outputTokens: out,
  inputTokens: inp,
  samples: 3,
  at: new Date().toISOString(),
  ...over,
});

describe('factorVerbosidad', () => {
  const cal: Calibracion = {
    'openai:gpt-4.1': medicion(965),
    'groq:openai/gpt-oss-120b': medicion(3072),
    'openai:gpt-4.1-nano': medicion(480),
  };

  it('mide cuanto mas escribe un modelo que otro', () => {
    // El caso real: un modelo de razonamiento emitio 3.2x mas tokens.
    const f = factorVerbosidad(cal, 'groq:openai/gpt-oss-120b', 'openai:gpt-4.1');
    expect(f!.out).toBeCloseTo(3.18, 1);
  });

  it('tambien detecta al que escribe menos', () => {
    const f = factorVerbosidad(cal, 'openai:gpt-4.1-nano', 'openai:gpt-4.1');
    expect(f!.out).toBeLessThan(1);
  });

  it('comparar un modelo consigo mismo da 1', () => {
    expect(factorVerbosidad(cal, 'openai:gpt-4.1', 'openai:gpt-4.1')!.out).toBe(1);
  });

  it('sin medicion devuelve undefined en vez de inventar un factor', () => {
    expect(factorVerbosidad(cal, 'openai:gpt-4.1', 'inexistente')).toBeUndefined();
    expect(factorVerbosidad(cal, 'inexistente', 'openai:gpt-4.1')).toBeUndefined();
  });

  it('una medicion fallida no se usa como si fuera valida', () => {
    const conError: Calibracion = {
      ...cal,
      'groq:roto': medicion(0, 0, { error: 'rate limit', samples: 0 }),
    };
    expect(factorVerbosidad(conError, 'groq:roto', 'openai:gpt-4.1')).toBeUndefined();
  });

  it('una referencia en cero no produce una division absurda', () => {
    const cero: Calibracion = { a: medicion(100), b: medicion(0, 0) };
    expect(factorVerbosidad(cero, 'a', 'b')).toBeUndefined();
  });
});

describe('prompts de calibracion', () => {
  it('cubren techos de respuesta muy distintos', () => {
    expect(CALIBRATION_PROMPTS).toHaveLength(3);
    // Del que pide una palabra al que pide una explicacion larga: un modelo
    // verborragico se delata en el tercero.
    expect(CALIBRATION_PROMPTS[0]).toMatch(/una sola palabra/i);
    expect(CALIBRATION_PROMPTS.at(-1)!.length).toBeGreaterThan(CALIBRATION_PROMPTS[0]!.length);
  });

  it('son autocontenidos: no dependen de contexto externo', () => {
    for (const p of CALIBRATION_PROMPTS) {
      expect(p).not.toMatch(/\beste\b|\besta\b|\bel anterior\b/i);
    }
  });
});
