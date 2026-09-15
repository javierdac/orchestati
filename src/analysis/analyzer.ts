import {
  INTENT_RULES,
  RISK_PATTERNS,
  CHAIN_PATTERNS,
  INTENT_BASE_COMPLEXITY,
  normalize,
} from './lexicon.js';
import { arbitrate } from './arbiter.js';
import { getDefaultClassifier, type SemanticBackend } from './semantic/classifier.js';
import type {
  Artifacts,
  Capability,
  Intent,
  ScoredIntent,
  Signals,
  Structure,
  Tier,
} from '../core/types.js';

/**
 * Analizador local. Determinista, sincronico, sin red y sin tokens de LLM.
 * Es la pieza que decide "cuanto pesa" un pedido antes de gastar un centavo.
 */

const CODE_BLOCK = /```[\s\S]*?```/;
const INLINE_CODE = /`[^`\n]+`/;
const URL = /https?:\/\/\S+/;
const FILE_PATH = /(^|\s)(\.{0,2}\/)?[\w.-]+\/[\w./-]+\.\w{1,5}\b|\b\w+\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|json|yaml|yml|sql|sh)\b/;
// Ojo: sin `\b` al final — las alternativas terminan en ":" y ahi nunca hay word boundary.
const STACK_TRACE = /(\bat\s+\w+\s*\(|traceback \(most recent|\w*error:|exception in thread|segmentation fault|panic:|\bthrow(n)? )/i;
const JSONISH = /\{[\s\S]*["'][\w-]+["']\s*:/;
const NUMBERS = /\d/;

/** Palabras funcionales caracteristicas de cada idioma. */
const ES_MARKERS = /\b(que|para|como|por|con|una|los|las|del|esto|hacer|quiero|necesito|pero|tambien)\b/g;
const EN_MARKERS = /\b(the|that|for|with|this|need|want|make|should|would|from|about|please)\b/g;

function detectLang(norm: string): 'es' | 'en' | 'unknown' {
  const es = (norm.match(ES_MARKERS) ?? []).length;
  const en = (norm.match(EN_MARKERS) ?? []).length;
  if (es === 0 && en === 0) {
    // Fallback: caracteres exclusivos del espanol en el texto original.
    return /[ñ¿¡]/.test(norm) ? 'es' : 'unknown';
  }
  if (es === en) return 'unknown';
  return es > en ? 'es' : 'en';
}

function detectArtifacts(raw: string, norm: string): Artifacts {
  return {
    hasCodeBlock: CODE_BLOCK.test(raw),
    hasInlineCode: INLINE_CODE.test(raw),
    hasUrl: URL.test(raw),
    hasFilePath: FILE_PATH.test(raw),
    hasStackTrace: STACK_TRACE.test(raw),
    hasNumbers: NUMBERS.test(norm),
    hasJson: JSONISH.test(raw),
    hasQuestionMark: raw.includes('?'),
  };
}

function detectStructure(raw: string, norm: string): Structure {
  const words = norm ? norm.split(' ').filter(Boolean).length : 0;
  const sentences = Math.max(1, (raw.match(/[.!?]+(\s|$)/g) ?? []).length);
  const questions = (raw.match(/\?/g) ?? []).length;
  const listItems = (raw.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;

  let chained = 0;
  for (const re of CHAIN_PATTERNS) {
    chained += (norm.match(re) ?? []).length;
  }

  // Imperativos: verbos de accion al inicio de una oracion o linea.
  const imperatives = (
    norm.match(
      /(^|[.!?\n]\s*)(hace|haz|crea|escribi|escribe|implementa|arregla|analiza|explica|resumi|resume|traduci|traduce|revisa|genera|buscar?|dame|necesito|quiero|build|make|create|write|fix|explain|analy[sz]e|review|generate|give|find)\b/g,
    ) ?? []
  ).length;

  return { words, chars: raw.length, sentences, questions, chainedRequests: chained, listItems, imperatives };
}

function scoreIntents(norm: string): ScoredIntent[] {
  const totalLen = Math.max(norm.length, 1);
  const byIntent = new Map<Intent, ScoredIntent>();

  for (const rule of INTENT_RULES) {
    let hits = 0;
    let matchedChars = 0;
    const evidence: string[] = [];

    for (const pattern of rule.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const m of norm.matchAll(re)) {
        hits++;
        matchedChars += m[0].length;
        if (evidence.length < 4) evidence.push(m[0].trim());
      }
    }
    if (hits === 0) continue;

    // Multiples hits suman, pero con rendimiento decreciente.
    let score = rule.weight * (1 + Math.log2(hits) * 0.35);

    if (rule.conversational) {
      // Cuanto mas del mensaje ocupa el saludo, mas manda el saludo.
      const coverage = Math.min(1, matchedChars / totalLen);
      score *= coverage;
    }

    const prev = byIntent.get(rule.intent);
    if (!prev || score > prev.score) {
      byIntent.set(rule.intent, { intent: rule.intent, score, evidence });
    }
  }

  const list = [...byIntent.values()].sort((a, b) => b.score - a.score);
  if (list.length === 0) {
    return [{ intent: 'unknown', score: 0.2, evidence: [] }];
  }
  return list;
}

/**
 * Correcciones por artefacto: cuando el lexico no reconocio nada pero el texto
 * trae evidencia dura (un stack trace, una ruta de archivo), esa evidencia vale
 * mas que el "no se". No pisa intenciones que si se detectaron con fuerza.
 */
function applyArtifactPriors(intents: ScoredIntent[], artifacts: Artifacts): ScoredIntent[] {
  const primary = intents[0]!;
  const ensure = (intent: Intent, score: number, evidence: string): ScoredIntent[] => {
    const existing = intents.find((i) => i.intent === intent);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
    } else {
      intents.push({ intent, score, evidence: [evidence] });
    }
    return intents.sort((a, b) => b.score - a.score);
  };

  if (artifacts.hasStackTrace) {
    return ensure('code_debug', 1.2, '(stack trace)');
  }
  if (primary.intent === 'unknown' && (artifacts.hasCodeBlock || artifacts.hasFilePath)) {
    return ensure('code_explain', 0.9, artifacts.hasCodeBlock ? '(bloque de codigo)' : '(ruta de archivo)');
  }
  return intents;
}

function inferCapabilities(intents: ScoredIntent[], artifacts: Artifacts): Capability[] {
  const caps = new Set<Capability>(['chat']);
  const byIntent: Partial<Record<Intent, Capability[]>> = {
    greeting: [],
    farewell: [],
    thanks: [],
    smalltalk: [],
    identity: [],
    factual_qa: ['knowledge'],
    howto: ['knowledge', 'writing'],
    code_generate: ['code'],
    code_debug: ['code', 'debug'],
    code_explain: ['code', 'writing'],
    refactor: ['code', 'analysis'],
    research: ['knowledge', 'analysis', 'synthesis'],
    planning: ['planning', 'analysis'],
    math: ['math'],
    translate: ['writing'],
    summarize: ['writing', 'synthesis'],
    creative: ['writing'],
    data_analysis: ['analysis', 'math'],
    tool_action: ['tools'],
    unknown: ['knowledge'],
  };

  // Solo los intents relevantes (>= 40% del top) aportan capacidades.
  const top = intents[0]?.score ?? 0;
  for (const si of intents) {
    if (si.score < top * 0.4) continue;
    for (const c of byIntent[si.intent] ?? []) caps.add(c);
  }

  if (artifacts.hasCodeBlock || artifacts.hasFilePath) caps.add('code');
  if (artifacts.hasStackTrace) caps.add('debug');
  if (artifacts.hasUrl) caps.add('web');
  if (artifacts.hasJson) caps.add('analysis');

  return [...caps];
}

function scoreRisk(norm: string): number {
  let risk = 0;
  for (const { re, weight } of RISK_PATTERNS) {
    if (re.test(norm)) risk = Math.max(risk, weight);
  }
  return risk;
}

/**
 * Modelo de complejidad.
 *
 * La dificultad intrinseca de la tarea (`intent`) actua como PISO, no como un
 * sumando mas: "diseñame la arquitectura de X" es un pedido pesado aunque se
 * diga en doce palabras. El resto de los rasgos son amplificadores que suman
 * sobre ese piso hasta 0.45.
 */
const INTENT_FLOOR = 0.55;

const W = {
  length: 0.09,
  chained: 0.11,
  breadth: 0.07,
  multiIntent: 0.08,
  artifacts: 0.07,
  questions: 0.015,
  lists: 0.015,
} as const;

/** Intents que representan trabajo real (no conversacion). */
const TASK_INTENTS_EXCLUDED: ReadonlySet<Intent> = new Set<Intent>([
  'greeting',
  'farewell',
  'thanks',
  'smalltalk',
  'identity',
  'unknown',
]);

/** Cuantas tareas distintas y fuertes pide el mensaje. */
export function countStrongTaskIntents(intents: ScoredIntent[]): number {
  const top = intents[0]?.score ?? 0;
  if (top === 0) return 0;
  return intents.filter((i) => i.score >= top * 0.6 && !TASK_INTENTS_EXCLUDED.has(i.intent)).length;
}

function scoreComplexity(
  intents: ScoredIntent[],
  structure: Structure,
  artifacts: Artifacts,
  caps: Capability[],
  confidence: number,
): { value: number; breakdown: Record<string, number> } {
  const primary = intents[0]!;

  // Si hay varios intents fuertes, se toma el mas complejo de ellos:
  // un pedido mixto pesa como su parte mas pesada.
  const strong = intents.filter((i) => i.score >= primary.score * 0.6);
  const declarado = Math.max(...strong.map((i) => INTENT_BASE_COMPLEXITY[i.intent]));

  /**
   * Una intencion de la que no estamos seguros no puede aportar su piso de
   * complejidad con todo el peso. Si el clasificador adivino "farewell" para
   * un pedido de refactor, creerle el 0.00 de complejidad manda el pedido al
   * agente reflex y no hay vuelta atras. Ante la duda, se regresa hacia la
   * complejidad de un pedido cualquiera.
   */
  const intentScore =
    declarado * confidence + INTENT_BASE_COMPLEXITY.unknown * (1 - confidence);

  // Longitud en escala log: 5 palabras ~ 0.1, 50 ~ 0.55, 300+ ~ 1.
  const lengthScore = Math.min(1, Math.log10(structure.words + 1) / 2.5);

  const chainedScore = Math.min(1, structure.chainedRequests / 3);

  // Amplitud: cuantos dominios distintos toca (sin contar 'chat').
  const breadthScore = Math.min(1, Math.max(0, caps.length - 1) / 4);

  const artifactScore = Math.min(
    1,
    (Number(artifacts.hasCodeBlock) * 0.5 +
      Number(artifacts.hasStackTrace) * 0.5 +
      Number(artifacts.hasJson) * 0.25 +
      Number(artifacts.hasFilePath) * 0.2 +
      Number(artifacts.hasUrl) * 0.2),
  );

  const questionScore = Math.min(1, structure.questions / 3);
  const listScore = Math.min(1, structure.listItems / 5);

  // Varias tareas distintas en un mismo mensaje pesan por si solas.
  const multiIntentScore = Math.min(1, Math.max(0, countStrongTaskIntents(intents) - 1) / 2);

  const breakdown = {
    intent: intentScore * INTENT_FLOOR,
    length: lengthScore * W.length,
    chained: chainedScore * W.chained,
    breadth: breadthScore * W.breadth,
    multiIntent: multiIntentScore * W.multiIntent,
    artifacts: artifactScore * W.artifacts,
    questions: questionScore * W.questions,
    lists: listScore * W.lists,
  };

  const value = Math.min(1, Object.values(breakdown).reduce((a, b) => a + b, 0));
  return { value, breakdown };
}

const CONVERSATIONAL: ReadonlySet<Intent> = new Set<Intent>([
  'greeting',
  'farewell',
  'thanks',
  'smalltalk',
  'identity',
]);

/**
 * Traduce complejidad + forma del pedido a un escalon de potencia.
 *
 * `swarm` no se alcanza por umbral escalar sino por regla explicita: el pedido
 * tiene que ser pesado Y venir partido en varias tareas. Un solo pedido, por
 * dificil que sea, no gana nada con fan-out.
 */
/**
 * Confianza minima para tomar el atajo reflex. Es el unico camino sin
 * recuperacion posible —responde una frase fija y listo—, asi que exige
 * certeza. Un saludo de verdad la tiene: "hola" da confianza 1.00.
 */
export const REFLEX_MIN_CONFIDENCE = 0.6;

export function suggestTier(
  complexity: number,
  intents: ScoredIntent[],
  structure: Structure,
  risk: number,
  confidence: number,
): Tier {
  const primary = intents[0]!;

  // Atajo reflex: saludo/agradecimiento dominante, mensaje corto y sin dudas.
  // Nada de LLM para responder "hola".
  if (
    CONVERSATIONAL.has(primary.intent) &&
    structure.words <= 12 &&
    complexity < 0.15 &&
    confidence >= REFLEX_MIN_CONFIDENCE
  ) {
    return 'reflex';
  }

  const multiTask = countStrongTaskIntents(intents) >= 2 || structure.chainedRequests >= 2;
  if (complexity >= 0.5 && multiTask) return 'swarm';

  if (complexity < 0.25) return risk >= 0.5 ? 'standard' : 'light';
  if (complexity < 0.45) return 'standard';
  return 'deep';
}

/**
 * Confianza en la intencion primaria.
 *
 * Tiene dos componentes y hacen falta los dos. El margen sobre la segunda dice
 * si hay competencia; la fuerza absoluta dice si el match significa algo.
 *
 * Con solo el margen, un unico match debil quedaba con confianza altisima
 * —no tenia contra quien competir— y eso hacia dos cosas malas: saltearse la
 * consulta al semantico y habilitar el camino reflex. "como se dice 'buenas
 * noches' en aleman" matcheaba `greeting` con 0.16 por la palabra "buenas", y
 * se contestaba con un saludo.
 */
function scoreConfidence(intents: ScoredIntent[]): number {
  const top = intents[0]?.score ?? 0;
  const second = intents[1]?.score ?? 0;

  const margin = top === 0 ? 0 : (top - second) / top;
  const base = 0.35 + margin * 0.5 + Math.min(top, 1.5) * 0.15;

  // Un match por debajo de este score es una pista, no una deteccion.
  const fuerza = Math.min(1, top / 0.8);

  return Math.min(1, Math.max(0.1, base * (0.4 + 0.6 * fuerza)));
}

export interface AnalyzeOptions {
  /**
   * Clasificador semantico usado como segunda opinion. Por defecto el de
   * n-gramas; `false` lo desactiva y deja solo el lexico.
   */
  semantic?: SemanticBackend | false;
}

/** Analiza un pedido y devuelve todas las senales para el router. */
export function analyze(input: string, opts: AnalyzeOptions = {}): Signals {
  const raw = input ?? '';
  const norm = normalize(raw);

  const artifacts = detectArtifacts(raw, norm);
  const structure = detectStructure(raw, norm);

  // 1. Lexico: exacto, auditable, gratis.
  const lexiconIntents = applyArtifactPriors(scoreIntents(norm), artifacts);
  const lexiconConfidence = scoreConfidence(lexiconIntents);

  // 2. Segunda opinion semantica, solo si el lexico dudo.
  const semantic =
    opts.semantic === false ? undefined : (opts.semantic ?? getDefaultClassifier());
  const arb = arbitrate(norm, lexiconIntents, lexiconConfidence, semantic);
  const intents = arb.intents;

  const confidence = arb.confidence;
  const requiredCapabilities = inferCapabilities(intents, artifacts);
  const { value: complexity, breakdown } = scoreComplexity(
    intents,
    structure,
    artifacts,
    requiredCapabilities,
    confidence,
  );
  const risk = scoreRisk(norm);

  return {
    raw,
    normalized: norm,
    lang: detectLang(norm),
    intents,
    primaryIntent: intents[0]!.intent,
    artifacts,
    structure,
    requiredCapabilities,
    complexity,
    complexityBreakdown: breakdown,
    risk,
    confidence,
    intentSource: arb.source,
    ...(arb.semanticTop ? { semanticTop: arb.semanticTop } : {}),
    suggestedTier: suggestTier(complexity, intents, structure, risk, confidence),
  };
}
