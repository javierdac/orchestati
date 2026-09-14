import type { Intent, ScoredIntent } from '../core/types.js';
import type { SemanticBackend } from './semantic/classifier.js';

/**
 * Arbitro entre el lexico y el clasificador semantico.
 *
 * El lexico manda cuando esta seguro: es exacto, auditable y gratis. El
 * semantico entra solo donde el lexico flaquea — cuando no reconocio nada o
 * cuando dudo entre dos intenciones. No es un reemplazo, es una red.
 */

/** Debajo de esta confianza del lexico se pide segunda opinion. */
export const LEXICON_DOUBT = 0.62;

/**
 * Dos umbrales, porque son dos decisiones distintas.
 *
 * Medido sobre el set de evaluacion, el score del clasificador es una señal
 * bien calibrada: con score >= 0.30 acierta el 100% de las veces, con >= 0.22
 * el 81%, y sin piso el 63%. Entonces:
 *
 * - `FILL`: el lexico no reconocio nada. Un 63% de acierto le gana a un
 *   `unknown`, que no aporta ninguna informacion de ruteo. Piso bajo.
 * - `OVERRIDE`: el lexico si reconocio algo. Para darlo vuelta hace falta el
 *   tramo donde el semantico no se equivoca. Piso alto.
 */
export const SEMANTIC_FLOOR_FILL = 0.15;
export const SEMANTIC_FLOOR_OVERRIDE = 0.3;

/** Distancia minima al segundo para considerar que el semantico esta decidido. */
export const OVERRIDE_MARGIN = 0.05;

export type IntentSource = 'lexicon' | 'semantic' | 'merged';

export interface ArbitrationResult {
  intents: ScoredIntent[];
  source: IntentSource;
  /** 0..1 — confianza en la intencion primaria, ya considerando a las dos fuentes. */
  confidence: number;
  /** Lo que dijo el semantico, aunque no haya ganado. Para poder auditarlo. */
  semanticTop?: ScoredIntent;
}

/**
 * Traduce la similitud del semantico a confianza.
 *
 * Es deliberadamente conservador: cuando el semantico rellena un hueco con un
 * score bajo esta adivinando, y el resto del sistema tiene que enterarse. Una
 * intencion adivinada con 0.28 de confianza rutea distinto que una reconocida.
 */
export function semanticConfidence(score: number): number {
  return Math.min(0.9, Math.max(0.2, 0.2 + ((score - 0.1) / 0.45) * 0.7));
}

/**
 * @param lexiconIntents  salida del lexico, ordenada desc
 * @param lexiconConfidence  0..1, que tan destacada esta la primera
 */
export function arbitrate(
  normalized: string,
  lexiconIntents: ScoredIntent[],
  lexiconConfidence: number,
  semantic: SemanticBackend | undefined,
): ArbitrationResult {
  const primary = lexiconIntents[0];

  // Camino rapido: el lexico esta seguro y reconocio algo. No se consulta nada.
  if (!semantic || (lexiconConfidence >= LEXICON_DOUBT && primary && primary.intent !== 'unknown')) {
    return { intents: lexiconIntents, source: 'lexicon', confidence: lexiconConfidence };
  }

  const semanticIntents = semantic.classify(normalized);
  const top = semanticIntents[0];
  if (!top) return { intents: lexiconIntents, source: 'lexicon', confidence: lexiconConfidence };

  // Coinciden: dos metodos independientes diciendo lo mismo.
  if (primary && top.intent === primary.intent) {
    return {
      intents: lexiconIntents,
      source: 'merged',
      confidence: Math.min(1, lexiconConfidence + 0.15),
      semanticTop: top,
    };
  }

  const sinLexico = !primary || primary.intent === 'unknown';

  // El lexico no reconocio nada: el semantico llena el hueco con piso bajo.
  if (sinLexico) {
    if (top.score < SEMANTIC_FLOOR_FILL) {
      // Ni el lexico ni el semantico saben. Se admite no saber: es informacion.
      return { intents: lexiconIntents, source: 'lexicon', confidence: 0.15, semanticTop: top };
    }
    return {
      intents: promote(top, lexiconIntents, semanticIntents),
      source: 'semantic',
      confidence: semanticConfidence(top.score),
      semanticTop: top,
    };
  }

  // Discrepan y el lexico si tenia una respuesta: la barra sube.
  const margen = top.score - (semanticIntents[1]?.score ?? 0);
  if (top.score >= SEMANTIC_FLOOR_OVERRIDE && margen >= OVERRIDE_MARGIN) {
    return {
      intents: promote(top, lexiconIntents, semanticIntents),
      source: 'semantic',
      confidence: semanticConfidence(top.score),
      semanticTop: top,
    };
  }

  // El semantico no convencio, pero su desacuerdo es una señal: el lexico
  // queda menos confiable de lo que creia.
  return {
    intents: lexiconIntents,
    source: 'lexicon',
    confidence: lexiconConfidence * 0.85,
    semanticTop: top,
  };
}

/**
 * Pone la intencion del semantico al frente, en la escala del lexico para que
 * el resto del pipeline (que compara scores entre si) siga funcionando.
 */
function promote(
  winner: ScoredIntent,
  lexiconIntents: ScoredIntent[],
  semanticIntents: ScoredIntent[],
): ScoredIntent[] {
  const topLexicon = lexiconIntents[0]?.score ?? 0;
  const escala = Math.max(1, topLexicon * 1.1);

  const existing = lexiconIntents.find((i) => i.intent === winner.intent);
  const merged: ScoredIntent = {
    intent: winner.intent,
    score: escala,
    evidence: [...(existing?.evidence ?? []), ...winner.evidence],
  };

  const rest = lexiconIntents.filter((i) => i.intent !== winner.intent && i.intent !== 'unknown');

  // Un segundo semantico fuerte tambien entra: habilita detectar pedidos
  // multiples cuando el lexico solo vio uno.
  const second = semanticIntents[1];
  if (second && second.score >= SEMANTIC_FLOOR_OVERRIDE && !rest.some((r) => r.intent === second.intent)) {
    rest.push({
      intent: second.intent,
      score: escala * (second.score / winner.score) * 0.9,
      evidence: second.evidence,
    });
  }

  return [merged, ...rest].sort((a, b) => b.score - a.score);
}

/** Etiqueta legible para la traza. */
export function describeSource(source: IntentSource, top?: ScoredIntent): string {
  if (source === 'lexicon') return 'lexico';
  if (source === 'merged') return `lexico + semantico (${top?.score.toFixed(2)})`;
  return `semantico (${top?.score.toFixed(2)})`;
}

export type { Intent };
