import type { Agent, AgentContext, AgentOutput, Intent, Signals } from '../core/types.js';

/**
 * Agentes reflex: responden sin tocar un LLM. Costo cero, latencia ~0.
 * Aca vive el caso "hola".
 */

type Lang = 'es' | 'en';

const RESPONSES: Record<string, Record<Lang, string[]>> = {
  greeting: {
    es: ['¡Hola! ¿En qué te doy una mano?', '¡Buenas! Contame qué necesitás.', '¡Hola! ¿Qué hacemos hoy?'],
    en: ['Hey! What can I help you with?', 'Hi there — what do you need?', 'Hello! What are we building?'],
  },
  farewell: {
    es: ['¡Chau! Cuando quieras seguimos.', 'Nos vemos 👋'],
    en: ['See you! Ping me anytime.', 'Bye 👋'],
  },
  thanks: {
    es: ['¡De nada! Cualquier cosa avisame.', 'A mandar 💪'],
    en: ["You're welcome! Anytime.", 'Glad it helped 💪'],
  },
  smalltalk: {
    es: ['Todo bien por acá. ¿Arrancamos con algo?', 'Acá andamos. ¿Qué te traigo?'],
    en: ['All good here. What do you want to tackle?', "I'm around — what's up?"],
  },
};

function pick(list: string[], seed: string): string {
  // Deterministico: el mismo input siempre da la misma respuesta.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return list[Math.abs(h) % list.length]!;
}

function lang(signals: Signals): Lang {
  return signals.lang === 'en' ? 'en' : 'es';
}

const REFLEX_INTENTS: Intent[] = ['greeting', 'farewell', 'thanks', 'smalltalk'];

/** Saludos, despedidas y agradecimientos. Sin LLM. */
export const smalltalkAgent: Agent = {
  id: 'reflex.smalltalk',
  name: 'Reflejo conversacional',
  description: 'Responde saludos, despedidas y agradecimientos sin llamar a ningun modelo.',
  tier: 'reflex',
  role: 'responder',
  capabilities: ['chat'],
  intents: REFLEX_INTENTS,
  cost: 0,

  accepts(signals) {
    // Veto duro: si el mensaje trae un pedido real, este agente no va.
    if (!REFLEX_INTENTS.includes(signals.primaryIntent)) return null;
    if (signals.complexity >= 0.2) return null;
    if (signals.structure.words > 14) return null;
    // Y si la intencion fue adivinada, tampoco: responder "¡chau!" a un
    // pedido de refactor no tiene arreglo posible aguas abajo.
    if (signals.confidence < 0.6) return null;
    return 0.5;
  },

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const started = Date.now();
    const bucket = RESPONSES[ctx.signals.primaryIntent] ?? RESPONSES.greeting!;
    const text = pick(bucket[lang(ctx.signals)], ctx.signals.normalized);

    return {
      agentId: smalltalkAgent.id,
      text,
      confidence: 0.95,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: Date.now() - started },
      meta: { llm: false },
    };
  },
};

/** "¿Quién sos?" / "¿qué podés hacer?" — respuesta fija sobre el propio sistema. */
export function createIdentityAgent(describePool: () => string): Agent {
  return {
    id: 'reflex.identity',
    name: 'Identidad',
    description: 'Explica que es el orquestador y que agentes tiene disponibles.',
    tier: 'reflex',
    role: 'responder',
    capabilities: ['chat'],
    intents: ['identity'],
    cost: 0,

    accepts(signals) {
      if (signals.primaryIntent !== 'identity') return null;
      if (signals.confidence < 0.6) return null;
      return 0.6;
    },

    async run(ctx: AgentContext): Promise<AgentOutput> {
      const started = Date.now();
      const es = lang(ctx.signals) === 'es';
      const head = es
        ? 'Soy un orquestador: analizo tu pedido localmente (sin gastar tokens) y lo derivo al agente adecuado.'
        : 'I am an orchestrator: I analyze your request locally (no tokens spent) and route it to the right agent.';

      // Si el runtime sabe describirse entero —modelos, precios, herramientas—
      // se usa eso; si no, al menos el pool.
      const cuerpo = ctx.services.describeSystem?.() ?? describePool();

      return {
        agentId: 'reflex.identity',
        text: `${head}\n\n${cuerpo}`,
        confidence: 0.95,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: Date.now() - started },
        meta: { llm: false },
      };
    },
  };
}
