import type { OrchestrationResult } from '../core/types.js';

/**
 * Como se juzga una corrida ya terminada.
 *
 * El error que esto corrige: antes el router se alimentaba de la `confidence`
 * que el agente se auto-asignaba, y esa confianza era una funcion de la
 * complejidad y del `comfortMax` — dos valores conocidos ANTES de ejecutar.
 * El router aprendia de su propia decision previa: un lazo cerrado sin señal
 * externa, que no puede converger a nada.
 *
 * Aca solo entran hechos que no se podian saber de antemano.
 */

export interface ObservedOutcome {
  /** 0..1 */
  score: number;
  /** Por que dio eso. */
  reasons: string[];
  /**
   * `true` cuando lo unico observado es "no fallo".
   *
   * Ausencia de falla no es evidencia de calidad: una respuesta mediocre y una
   * excelente se ven igual desde afuera. Por eso esta señal pesa poco y la del
   * usuario, cuando existe, pesa entero.
   */
  weak: boolean;
}

/** Puntaje de una corrida sin opinion del usuario: detecta fracaso, no calidad. */
export function observeOutcome(result: OrchestrationResult): ObservedOutcome {
  const reasons: string[] = [];
  let score = 0.6; // linea base de "termino sin romperse"
  let concreto = false;

  if (result.escalations > 0) {
    score -= 0.3 * result.escalations;
    reasons.push(`escalo ${result.escalations} vez(ces)`);
    concreto = true;
  }

  const errores = result.trace.filter((e) => e.type === 'error');
  if (errores.length > 0) {
    score -= 0.25 * errores.length;
    reasons.push(`${errores.length} error(es) en la traza`);
    concreto = true;
  }

  const texto = result.text.trim();
  if (texto.length === 0) {
    score = 0;
    reasons.push('no produjo respuesta');
    concreto = true;
  } else if (texto.length < 20 && result.decision.tier !== 'reflex') {
    score -= 0.2;
    reasons.push('respuesta sospechosamente corta');
    concreto = true;
  }

  // Herramientas: una que falla es señal de que el agente eligio mal o uso mal
  // la herramienta. Una denegada no es culpa suya, asi que no cuenta.
  const ejecutadas = result.toolCalls.filter((t) => t.approved);
  const fallidas = ejecutadas.filter((t) => !t.result.ok);
  if (ejecutadas.length > 0) {
    const ratio = fallidas.length / ejecutadas.length;
    if (ratio > 0) {
      score -= ratio * 0.25;
      reasons.push(`${fallidas.length}/${ejecutadas.length} herramienta(s) fallaron`);
      concreto = true;
    } else {
      score += 0.1;
      reasons.push('las herramientas que uso funcionaron');
      concreto = true;
    }
  }

  if (reasons.length === 0) reasons.push('termino sin incidentes');

  return {
    score: Math.min(1, Math.max(0, score)),
    reasons,
    weak: !concreto,
  };
}

/**
 * Cuanto mueve el prior cada tipo de señal.
 *
 * Una observacion pasiva mueve poco; que el usuario diga que estuvo mal mueve
 * entero. Sin esta distincion, el ruido de "no fallo" ahogaria la señal real.
 */
export const SIGNAL_WEIGHT = {
  /** Solo se observo que no se rompio. */
  weak: 0.25,
  /** Se observo algo concreto: escalado, error, herramienta fallida. */
  observed: 0.6,
  /** El usuario reformulo el pedido: sintoma de que la respuesta no sirvio. */
  reformulation: 0.7,
  /** El usuario lo dijo explicitamente. */
  explicit: 1,
} as const;
