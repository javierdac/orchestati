import { llmAgent } from './base.js';
import type { Agent } from '../core/types.js';

/**
 * Pool por defecto. Cada agente declara que sabe hacer, cuanto cuesta y
 * hasta que complejidad se anima; el router usa eso para elegir.
 */

export const quickAgent: Agent = llmAgent({
  id: 'llm.quick',
  name: 'Respuesta rapida',
  description: 'Preguntas directas, definiciones, traducciones cortas. Modelo chico.',
  tier: 'light',
  role: 'responder',
  capabilities: ['chat', 'knowledge', 'writing'],
  intents: ['factual_qa', 'translate', 'summarize', 'smalltalk', 'unknown', 'identity'],
  cost: 0.15,
  comfortMax: 0.35,
  temperature: 0.3,
  maxOutputTokens: 600,
  system:
    'Sos un asistente directo y breve. Responde en el idioma del usuario. ' +
    'Si la pregunta es simple, responde en 1-3 oraciones sin preambulos. ' +
    'Si el pedido es claramente mas complejo de lo que parecia, decilo explicitamente ' +
    'empezando tu respuesta con "ESCALAR:" y explicando que hace falta.',
});

export const writerAgent: Agent = llmAgent({
  id: 'llm.writer',
  name: 'Redaccion',
  description: 'Texto creativo, resumenes largos, explicaciones didacticas.',
  tier: 'standard',
  capabilities: ['chat', 'writing', 'synthesis'],
  intents: ['creative', 'summarize', 'howto', 'translate'],
  cost: 0.4,
  comfortMax: 0.7,
  temperature: 0.7,
  system:
    'Sos un redactor experto. Escribi en el idioma del usuario, con estructura clara ' +
    'y sin relleno. Priorizá que el texto sea util por sobre que sea largo.',
});

export const coderAgent: Agent = llmAgent({
  id: 'llm.coder',
  name: 'Programador',
  description: 'Escribe, explica y refactoriza codigo.',
  tier: 'standard',
  capabilities: ['code', 'analysis', 'writing'],
  intents: ['code_generate', 'code_explain', 'refactor', 'howto'],
  cost: 0.45,
  comfortMax: 0.72,
  temperature: 0.2,
  tools: ['read_file', 'list_dir', 'search_code', 'write_file'],
  system:
    'Sos un ingeniero de software senior. Antes de escribir, leé el codigo que vas a tocar. ' +
    'Para modificar un archivo usá write_file: requiere permiso del usuario, no lo asumas. Entregá codigo correcto, tipado y ejecutable. ' +
    'Explicá solo lo que no sea evidente en el codigo. Respetá el estilo del codigo que te pasen.',
  accepts(signals) {
    if (signals.artifacts.hasCodeBlock) return 0.3;
    return 0;
  },
});

export const debuggerAgent: Agent = llmAgent({
  id: 'llm.debugger',
  name: 'Depurador',
  description: 'Diagnostica errores, stack traces y comportamiento roto.',
  tier: 'deep',
  capabilities: ['code', 'debug', 'analysis'],
  intents: ['code_debug'],
  cost: 0.8,
  comfortMax: 0.95,
  temperature: 0.1,
  tools: ['read_file', 'list_dir', 'search_code', 'run_command'],
  maxToolSteps: 6,
  system:
    'Sos un especialista en debugging. Buscá el codigo real antes de opinar. Procedé asi: (1) hipotesis de causa raiz, ' +
    '(2) evidencia que la sostiene, (3) fix concreto, (4) como verificarlo. ' +
    'No inventes lineas de codigo que no viste.',
  accepts(signals) {
    if (signals.artifacts.hasStackTrace) return 0.6;
    if (signals.primaryIntent === 'code_debug') return 0.3;
    return 0;
  },
});

export const analystAgent: Agent = llmAgent({
  id: 'llm.analyst',
  name: 'Analista',
  description: 'Calculos, metricas, lectura de datos y tendencias.',
  tier: 'standard',
  capabilities: ['analysis', 'math'],
  intents: ['math', 'data_analysis', 'factual_qa'],
  cost: 0.45,
  comfortMax: 0.7,
  temperature: 0.1,
  tools: ['calculator', 'read_file'],
  system:
    'Sos un analista cuantitativo. Usá calculator para cualquier cuenta: no estimes de cabeza. Mostrá el razonamiento numerico paso a paso y ' +
    'sé explicito con los supuestos. Si faltan datos, decí exactamente cuales.',
});

export const researcherAgent: Agent = llmAgent({
  id: 'llm.researcher',
  name: 'Investigador',
  description: 'Comparaciones, estado del arte, trade-offs, evaluacion de opciones.',
  tier: 'deep',
  capabilities: ['knowledge', 'analysis', 'synthesis', 'web'],
  intents: ['research', 'data_analysis', 'factual_qa', 'planning'],
  cost: 0.85,
  comfortMax: 1,
  temperature: 0.4,
  tools: ['search_code', 'read_file', 'http_fetch'],
  system:
    'Sos un investigador riguroso. Cubri las opciones relevantes, contrastalas con ' +
    'criterios explicitos y cerrá con una recomendacion. Separá hecho de opinion.',
});

export const plannerAgent: Agent = llmAgent({
  id: 'llm.planner',
  name: 'Planificador',
  description: 'Descompone pedidos grandes en un plan de pasos accionables.',
  tier: 'deep',
  role: 'planner',
  capabilities: ['planning', 'analysis'],
  intents: ['planning', 'research', 'howto'],
  cost: 0.7,
  comfortMax: 1,
  temperature: 0.3,
  maxOutputTokens: 900,
  system:
    'Sos un planificador. Devolvé un plan numerado y corto (3-7 pasos), cada paso con ' +
    'su entregable concreto. No ejecutes el plan: solo planificalo. Marcá dependencias.',
});

export const criticAgent: Agent = llmAgent({
  id: 'llm.critic',
  name: 'Revisor',
  description: 'Revisa el trabajo previo y senala errores, huecos y riesgos.',
  tier: 'standard',
  role: 'critic',
  capabilities: ['analysis'],
  intents: [],
  cost: 0.35,
  comfortMax: 1,
  temperature: 0.2,
  maxOutputTokens: 700,
  tools: ['read_file', 'search_code'],
  system:
    'Sos un revisor critico. Recibis el trabajo de otros agentes. Devolvé la respuesta ' +
    'final corregida, integrando lo bueno y arreglando lo que este mal. Si no hay nada ' +
    'que corregir, devolvé el trabajo previo tal cual, sin comentar que lo revisaste.',
});

export const synthesizerAgent: Agent = llmAgent({
  id: 'llm.synthesizer',
  name: 'Sintetizador',
  description: 'Fusiona las salidas de varios agentes en una sola respuesta.',
  tier: 'standard',
  role: 'synthesizer',
  capabilities: ['synthesis', 'writing'],
  intents: [],
  cost: 0.35,
  comfortMax: 1,
  temperature: 0.3,
  system:
    'Recibis respuestas parciales de varios agentes al mismo pedido. Fusionalas en UNA ' +
    'respuesta coherente, sin repetir, sin mencionar que hubo varios agentes. ' +
    'Si se contradicen, resolvé la contradiccion y decí por que.',
});

export const toolAgent: Agent = llmAgent({
  id: 'llm.tools',
  name: 'Operador',
  description: 'Acciones con efecto (deploy, borrar, enviar). Confirma antes de proponer.',
  tier: 'standard',
  capabilities: ['tools', 'analysis'],
  intents: ['tool_action'],
  cost: 0.5,
  comfortMax: 0.85,
  temperature: 0.1,
  tools: ['run_command', 'write_file', 'read_file', 'list_dir', 'search_code'],
  maxToolSteps: 6,
  system:
    'Ejecutás acciones con efectos reales. Cada herramienta que pidas pasa por una ' +
    'confirmacion del usuario que vos no controlás: si te la deniegan, no insistas — ' +
    'explicá que hace falta su permiso y por que. Antes de cambiar algo, miralo primero ' +
    '(read_file / list_dir). Decí siempre que es reversible y que no.',
  accepts(signals) {
    if (signals.risk >= 0.5) return 0.4;
    return 0;
  },
});

export const LLM_AGENTS: Agent[] = [
  quickAgent,
  writerAgent,
  coderAgent,
  debuggerAgent,
  analystAgent,
  researcherAgent,
  plannerAgent,
  criticAgent,
  synthesizerAgent,
  toolAgent,
];
