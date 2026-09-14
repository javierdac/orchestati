import type { Intent } from '../core/types.js';

/**
 * Lexico bilingue (es/en) para deteccion de intencion.
 * Todas las patterns asumen texto ya normalizado: minusculas y sin acentos.
 */

export interface IntentRule {
  intent: Intent;
  /** Peso base del match. */
  weight: number;
  /**
   * Intents "de conversacion": su score se escala por la fraccion del mensaje
   * que ocupan. Asi "hola" gana, pero "hola, refactorizame esto" no.
   */
  conversational?: boolean;
  patterns: RegExp[];
}

/** Quita acentos, colapsa espacios y pasa a minusculas. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const INTENT_RULES: IntentRule[] = [
  {
    intent: 'greeting',
    weight: 1,
    conversational: true,
    patterns: [
      /\b(hola|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|que onda|como va|como andas|como estas)\b/,
      /\b(hi|hello|hey|yo|good morning|good evening|howdy|sup|what'?s up)\b/,
    ],
  },
  {
    intent: 'farewell',
    weight: 1,
    conversational: true,
    patterns: [
      /\b(chau|adios|nos vemos|hasta luego|hasta manana|me voy)\b/,
      /\b(bye|goodbye|see you|later|cya)\b/,
    ],
  },
  {
    intent: 'thanks',
    weight: 1,
    conversational: true,
    patterns: [
      /\b(gracias|muchas gracias|te agradezco|genial gracias|buenisimo)\b/,
      /\b(thanks|thank you|thx|appreciated|cheers)\b/,
    ],
  },
  {
    intent: 'smalltalk',
    weight: 0.8,
    conversational: true,
    patterns: [
      /\b(como estas|todo bien|que hacias|contame algo|estas ahi)\b/,
      /\b(how are you|you there|nice|cool|ok|okay|dale)\b/,
    ],
  },
  {
    intent: 'identity',
    weight: 0.9,
    conversational: true,
    patterns: [
      /\b(quien sos|quien eres|que sos|que podes hacer|que puedes hacer|para que servis|como funcionas)\b/,
      /\b(who are you|what can you do|what are you|how do you work)\b/,
    ],
  },
  {
    intent: 'factual_qa',
    weight: 0.7,
    patterns: [
      /\b(que es|quien es|cuando|donde|cual es|cuanto (es|cuesta|mide|pesa)|define|definicion de)\b/,
      /\b(what is|who is|when (is|was|did)|where is|which is|how much|how many|define)\b/,
    ],
  },
  {
    intent: 'howto',
    weight: 0.8,
    patterns: [
      /\b(como (hago|puedo|se hace|configuro|instalo|conecto)|pasos para|tutorial|guia para)\b/,
      /\b(how (do|to|can) i|steps to|guide to|walk me through|tutorial)\b/,
    ],
  },
  {
    intent: 'code_generate',
    weight: 1,
    patterns: [
      /\b(escribi|escribime|crea|creame|generame|implementa|implementame|programa|codea|hace(me)? (una|un) (funcion|clase|script|endpoint|componente))\b/,
      /\b(write|create|generate|implement|build|scaffold|code)\b.*\b(function|class|script|endpoint|component|module|api|test)\b/,
      /\b(funcion|clase|endpoint|componente|script|modulo|tipado|interfaz)\b/,
    ],
  },
  {
    intent: 'code_debug',
    weight: 1.2,
    patterns: [
      /\b(no funciona|falla|bug|rompe|se rompe|tira|excepcion|no anda|debuggea|arregla|no entiendo por que|por que (falla|pasa|da|tira))\b/,
      /\b(doesn'?t work|fails|failing|bug|crash|exception|stack ?trace|broken|fix (this|it|the))\b/,
      // "error", "TypeError:", "NullPointerException" — con o sin prefijo pegado.
      /\b\w*(error|exception)\b/,
      /\b(undefined|null|nan) (is not|of undefined)|cannot read (property|properties)/,
    ],
  },
  {
    intent: 'code_explain',
    weight: 0.9,
    patterns: [
      /\b(explicame (este|el) (codigo|snippet)|que hace (este|el) (codigo|funcion)|entender (este|el) codigo)\b/,
      /\b(explain (this|the) (code|snippet|function)|what does (this|the) (code|function) do|walk through the code)\b/,
    ],
  },
  {
    intent: 'refactor',
    weight: 1.1,
    patterns: [
      /\b(refactor(iza|izame|izar)?|mejora(r|me)? (el|este) codigo|limpia(r|me)?|optimiza(r|me)?|migra(r|me)?|reescribi)\b/,
      /\b(refactor|clean ?up|optimi[sz]e|migrate|rewrite|restructure|modernize)\b/,
    ],
  },
  {
    intent: 'research',
    weight: 1.3,
    patterns: [
      /\b(investiga|investigar|compara|comparacion|analiza el mercado|estado del arte|relevamiento|benchmark|pros y contras|ventajas y desventajas|evalua(r|me)? (las )?opciones)\b/,
      /\b(research|investigate|compare|comparison|state of the art|benchmark|pros and cons|trade-?offs|evaluate options)\b/,
    ],
  },
  {
    intent: 'planning',
    weight: 1.3,
    patterns: [
      /\b(plan|planifica|planificar|arquitectura|disena(r|me)?|estrategia|roadmap|como encaro|como estructuro|paso a paso el proyecto)\b/,
      /\b(plan|architect|architecture|design (a|the) system|strategy|roadmap|break (this )?down)\b/,
    ],
  },
  {
    intent: 'math',
    weight: 0.9,
    patterns: [
      /\b(calcula|calcular|cuanto da|resolve|resolver|ecuacion|derivada|integral|porcentaje|promedio)\b/,
      /\b(estima(r|me)?|estimacion|cuanto (sale|saldria|costaria)|costos?|presupuesto|roi)\b/,
      /\b(estimate|how much (would|will) it cost|costs?|budget|roi)\b/,
      /\b(calculate|compute|solve|equation|derivative|integral|percentage|average)\b/,
      /\d+\s*[+\-*/^]\s*\d+/,
      /\d+([.,]\d+)?\s*%/,
      /\bcuanto (es|da|suma|resta|queda)\b/,
    ],
  },
  {
    intent: 'translate',
    weight: 1,
    patterns: [
      /\b(traduc(i|e|ime|ir)|pasa(lo)? a (ingles|espanol|portugues|frances)|en ingles por favor)\b/,
      /\b(translate|in (english|spanish|french|portuguese) please)\b/,
    ],
  },
  {
    intent: 'summarize',
    weight: 1,
    patterns: [
      /\b(resumi(r|me)?|resumen|sintetiza(r|me)?|en pocas palabras|tldr|punteo)\b/,
      /\b(summari[sz]e|summary|tl;?dr|key points|condense)\b/,
    ],
  },
  {
    intent: 'creative',
    weight: 0.9,
    patterns: [
      /\b(escribi (un|una) (cuento|poema|historia|post|guion)|inventa|imagina|creativo|brainstorm|ideas para)\b/,
      /\b(write (a|an) (story|poem|post|script)|brainstorm|come up with ideas|creative)\b/,
    ],
  },
  {
    intent: 'data_analysis',
    weight: 1.1,
    patterns: [
      /\b(analiza (los|estos) datos|dataset|csv|metrica|metricas|tendencia|correlacion|grafico|estadistica)\b/,
      /\b(analy[sz]e (the )?data|dataset|csv|metrics|trend|correlation|chart|statistics)\b/,
    ],
  },
  {
    intent: 'tool_action',
    weight: 1.2,
    patterns: [
      /\b(deploy(a|ar)?|publica(r)?|borra(r|me)?|elimina(r)?|manda(r)? (un )?mail|envia(r)?|commite(a|ar)?|pushea(r)?|corre(r)? (el|los) tests?)\b/,
      /\b(deploy|publish|delete|remove|send (an )?email|commit|push|run (the )?tests?)\b/,
    ],
  },
];

/** Verbos con efecto irreversible: elevan el `risk`. */
export const RISK_PATTERNS: Array<{ re: RegExp; weight: number }> = [
  { re: /\b(borra(r|me)?|elimina(r)?|drop|truncate|rm -rf|delete|destru(i|ir)|wipe|purge)\b/, weight: 0.8 },
  { re: /\b(deploy(a|ar)? a? ?(prod|produccion|production)|publica(r)? en prod|release)\b/, weight: 0.7 },
  { re: /\b(force ?push|reset --hard|revert|rollback)\b/, weight: 0.5 },
  { re: /\b(manda(r)? (un )?mail|envia(r)? (el )?mail|send (an )?email|notifica(r)? a todos)\b/, weight: 0.4 },
  { re: /\b(pago|cobra(r)?|charge|refund|transferi(r)?)\b/, weight: 0.6 },
];

/** Conectores que indican que se pide mas de una cosa. */
export const CHAIN_PATTERNS: RegExp[] = [
  /\b(y despues|y luego|despues de eso|ademas|tambien|por otro lado|a su vez|y por ultimo|primero.*luego)\b/g,
  /\b(and then|after that|also|additionally|furthermore|finally|first.*then)\b/g,
  // Conectores sueltos: cuentan igual, aunque no vengan con "y".
  /(^|[,;.]\s*)(despues|luego|finalmente|por ultimo|then|next|finally)\b/g,
];

/** Complejidad intrinseca de cada intent (0..1). */
export const INTENT_BASE_COMPLEXITY: Record<Intent, number> = {
  greeting: 0,
  farewell: 0,
  thanks: 0,
  smalltalk: 0.05,
  identity: 0.08,
  factual_qa: 0.3,
  howto: 0.45,
  code_explain: 0.45,
  code_generate: 0.6,
  code_debug: 0.7,
  refactor: 0.68,
  research: 0.85,
  planning: 0.85,
  math: 0.4,
  translate: 0.25,
  summarize: 0.35,
  creative: 0.5,
  data_analysis: 0.7,
  tool_action: 0.55,
  unknown: 0.35,
};
