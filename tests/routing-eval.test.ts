import { describe, expect, it } from 'vitest';
import { evaluateRouting } from '../src/dev/eval-routing.js';
import { ROUTING_SET } from '../src/dev/routing-set.js';
import { TIER_ORDER } from '../src/core/types.js';

const out = evaluateRouting();
const n = out.length;
const ratio = (p: (o: (typeof out)[number]) => boolean): number => out.filter(p).length / n;

describe('calidad del ruteo', () => {
  it('acierta el escalon exacto en la gran mayoria de los casos', () => {
    expect(ratio((o) => o.tierOk)).toBeGreaterThanOrEqual(0.9);
  });

  it('nunca se equivoca por mas de un escalon', () => {
    const lejos = out.filter((o) => Math.abs(o.drift) > 1);
    expect(lejos.map((o) => `${o.case.text} → ${o.tier}`)).toEqual([]);
  });

  it('elige el agente esperado cuando hay uno esperado', () => {
    const conAgente = out.filter((o) => o.agentOk !== undefined);
    const ok = conAgente.filter((o) => o.agentOk).length;
    expect(ok / conAgente.length).toBeGreaterThanOrEqual(0.9);
  });

  /**
   * Los dos errores no cuestan lo mismo: pasarse de caro tira plata, quedarse
   * corto arriesga la calidad de la respuesta. El sesgo tiene que estar del
   * lado barato, que es el que el sistema promete.
   */
  it('no se pasa de caro: eso seria tirar plata', () => {
    const caros = out.filter((o) => o.drift > 0);
    expect(caros.map((o) => `${o.case.text} → ${o.tier} (esperado ${o.case.tier})`)).toEqual([]);
  });

  it('se queda corto pocas veces', () => {
    expect(ratio((o) => o.drift < 0)).toBeLessThanOrEqual(0.1);
  });
});

describe('el set de ruteo en si', () => {
  it('cubre todos los escalones', () => {
    for (const tier of TIER_ORDER) {
      expect(ROUTING_SET.some((c) => c.tier === tier), tier).toBe(true);
    }
  });

  it('cada caso dice por que corresponde ese escalon', () => {
    for (const c of ROUTING_SET) expect(c.why, c.text).toBeTruthy();
  });

  it('no repite frases', () => {
    const textos = ROUTING_SET.map((c) => c.text);
    expect(new Set(textos).size).toBe(textos.length);
  });

  it('los agentes esperados existen en el pool', async () => {
    const { createDefaultRegistry } = await import('../src/agents/index.js');
    const registry = createDefaultRegistry();
    for (const c of ROUTING_SET) {
      for (const a of c.agents ?? []) expect(registry.has(a), `${c.text} → ${a}`).toBe(true);
    }
  });

  it('tiene casos en los dos idiomas', () => {
    const ingles = ROUTING_SET.filter((c) => /\b(the|write|research|compare|what|only)\b/.test(c.text));
    expect(ingles.length).toBeGreaterThanOrEqual(5);
  });
});
