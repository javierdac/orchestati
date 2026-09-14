/**
 * Vectorizador de texto sin dependencias ni descargas.
 *
 * Usa n-gramas de caracteres hasheados con pesos TF-IDF. Los n-gramas de
 * caracteres son los que hacen el trabajo pesado en un clasificador de
 * intenciones: "refactorizame", "refactorizar" y "refactor" comparten casi
 * todos sus trigramas, asi que caen juntos sin que nadie escriba la regla.
 * Tambien absorben errores de tipeo, que es donde el lexico se rompe.
 */

/** Dimension del espacio hasheado. Potencia de dos para poder usar `&`. */
export const DIM = 4096;

/** Vector disperso: indice -> peso. */
export type SparseVector = Map<number, number>;

/** FNV-1a de 32 bits. Deterministico entre corridas y plataformas. */
export function hashFeature(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & (DIM - 1);
}

const N_GRAM_SIZES = [3, 4, 5] as const;

/**
 * Extrae los rasgos de un texto ya normalizado:
 * n-gramas de caracteres (3-5) sobre el texto con bordes marcados, mas las
 * palabras sueltas y los bigramas de palabras.
 */
export function extractFeatures(normalized: string): string[] {
  const features: string[] = [];
  if (!normalized) return features;

  // El `_` de los bordes hace que el inicio y el final de palabra cuenten:
  // distingue "plan" como palabra de "plan" dentro de "planilla".
  const padded = `_${normalized.replace(/\s+/g, '_')}_`;
  for (const n of N_GRAM_SIZES) {
    for (let i = 0; i + n <= padded.length; i++) {
      features.push(padded.slice(i, i + n));
    }
  }

  const words = normalized.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    features.push(`w:${words[i]}`);
    if (i + 1 < words.length) features.push(`w2:${words[i]}_${words[i + 1]}`);
  }

  return features;
}

/** Cuenta de rasgos por documento. */
export function termFrequency(features: string[]): Map<number, number> {
  const tf = new Map<number, number>();
  for (const f of features) {
    const idx = hashFeature(f);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }
  return tf;
}

/**
 * Pesos IDF calculados sobre un corpus. Los rasgos que aparecen en todos los
 * documentos no distinguen nada y quedan cerca de cero.
 */
export class IdfModel {
  private idf = new Map<number, number>();
  private maxIdf: number;

  constructor(corpus: string[][]) {
    const docCount = Math.max(1, corpus.length);
    const docFreq = new Map<number, number>();

    for (const features of corpus) {
      for (const idx of new Set(features.map(hashFeature))) {
        docFreq.set(idx, (docFreq.get(idx) ?? 0) + 1);
      }
    }
    for (const [idx, df] of docFreq) {
      this.idf.set(idx, Math.log((docCount + 1) / (df + 1)) + 1);
    }
    // Un rasgo nunca visto es maximamente informativo, no un error.
    this.maxIdf = Math.log(docCount + 1) + 1;
  }

  weight(idx: number): number {
    return this.idf.get(idx) ?? this.maxIdf;
  }
}

/** Vector TF-IDF normalizado a norma 1, listo para coseno. */
export function vectorize(features: string[], idf: IdfModel): SparseVector {
  const tf = termFrequency(features);
  const vec: SparseVector = new Map();

  let norm = 0;
  for (const [idx, count] of tf) {
    const w = (1 + Math.log(count)) * idf.weight(idx);
    vec.set(idx, w);
    norm += w * w;
  }

  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (const [idx, w] of vec) vec.set(idx, w / norm);
  return vec;
}

/** Coseno entre dos vectores ya normalizados. */
export function cosine(a: SparseVector, b: SparseVector): number {
  // Se recorre el mas chico: el costo depende del texto corto, no del centroide.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [idx, w] of small) {
    const other = big.get(idx);
    if (other !== undefined) dot += w * other;
  }
  return dot;
}

/** Promedio de vectores, renormalizado. */
export function centroid(vectors: SparseVector[]): SparseVector {
  const sum: SparseVector = new Map();
  for (const v of vectors) {
    for (const [idx, w] of v) sum.set(idx, (sum.get(idx) ?? 0) + w);
  }

  let norm = 0;
  for (const w of sum.values()) norm += w * w;
  norm = Math.sqrt(norm);
  if (norm === 0) return sum;
  for (const [idx, w] of sum) sum.set(idx, w / norm);
  return sum;
}
