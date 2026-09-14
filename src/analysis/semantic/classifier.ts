import type { Intent, ScoredIntent } from '../../core/types.js';
import { flatPrototypes } from './prototypes.js';
import {
  IdfModel,
  centroid,
  cosine,
  extractFeatures,
  vectorize,
  type SparseVector,
} from './vectorize.js';

/**
 * Backend de clasificacion semantica. La interfaz esta separada de la
 * implementacion a proposito: el clasificador de n-gramas es el default porque
 * no descarga nada y corre en microsegundos, pero alguien puede enchufar acá
 * un modelo de embeddings sin tocar el resto del sistema.
 */
export interface SemanticBackend {
  readonly name: string;
  /** Intenciones ordenadas por similitud desc. Scores en 0..1. */
  classify(normalized: string): ScoredIntent[];
}

interface IntentModel {
  intent: Intent;
  centroid: SparseVector;
  prototypes: Array<{ text: string; vector: SparseVector }>;
}

/**
 * Peso del centroide contra el del prototipo mas parecido.
 *
 * El centroide capta "de que habla en general" esta intencion; el vecino mas
 * cercano capta "esto se parece muchisimo a un caso concreto". Las intenciones
 * con fraseo muy variado (code_debug) se benefician del vecino; las homogeneas
 * (greeting) del centroide. La mezcla cubre las dos.
 */
const W_CENTROID = 0.45;
const W_NEAREST = 0.55;

export class NgramClassifier implements SemanticBackend {
  readonly name = 'ngram-tfidf';
  private models: IntentModel[] = [];
  private idf: IdfModel;

  constructor(prototypes: Array<{ intent: Intent; text: string }> = flatPrototypes()) {
    const corpus = prototypes.map((p) => extractFeatures(p.text));
    this.idf = new IdfModel(corpus);

    const byIntent = new Map<Intent, Array<{ text: string; vector: SparseVector }>>();
    prototypes.forEach((p, i) => {
      const vector = vectorize(corpus[i]!, this.idf);
      const list = byIntent.get(p.intent) ?? [];
      list.push({ text: p.text, vector });
      byIntent.set(p.intent, list);
    });

    for (const [intent, items] of byIntent) {
      this.models.push({
        intent,
        centroid: centroid(items.map((i) => i.vector)),
        prototypes: items,
      });
    }
  }

  classify(normalized: string): ScoredIntent[] {
    if (!normalized.trim()) return [];
    const query = vectorize(extractFeatures(normalized), this.idf);

    const scored = this.models.map((m) => {
      const centroidSim = cosine(query, m.centroid);

      let best = 0;
      let bestText = '';
      for (const p of m.prototypes) {
        const sim = cosine(query, p.vector);
        if (sim > best) {
          best = sim;
          bestText = p.text;
        }
      }

      return {
        intent: m.intent,
        score: W_CENTROID * centroidSim + W_NEAREST * best,
        // La evidencia es el prototipo mas parecido: se puede auditar por que
        // el clasificador dijo lo que dijo.
        evidence: bestText ? [`≈ "${bestText}" (${best.toFixed(2)})`] : [],
      };
    });

    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  }
}

let defaultClassifier: NgramClassifier | undefined;

/** Instancia compartida. Construirla cuesta ~1ms, asi que se hace una sola vez. */
export function getDefaultClassifier(): NgramClassifier {
  defaultClassifier ??= new NgramClassifier();
  return defaultClassifier;
}
