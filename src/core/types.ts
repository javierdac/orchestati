import type { ToolCall, ToolCallRecord, ConfirmationPolicy } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';

export type { ToolCall, ToolCallRecord, ConfirmationPolicy };

/**
 * Contratos centrales del orquestador.
 *
 * Flujo:  input -> Analyzer (local, 0 tokens) -> Signals
 *               -> Router (local)             -> Decision (agentes + estrategia)
 *               -> Executor                   -> Result (+ Trace)
 */

// ---------------------------------------------------------------------------
// Analisis
// ---------------------------------------------------------------------------

/** Intenciones que el analizador local sabe detectar. */
export type Intent =
  | 'greeting'
  | 'farewell'
  | 'thanks'
  | 'smalltalk'
  | 'identity'        // "quien sos", "que podes hacer"
  | 'factual_qa'
  | 'howto'
  | 'code_generate'
  | 'code_debug'
  | 'code_explain'
  | 'refactor'
  | 'research'
  | 'planning'
  | 'math'
  | 'translate'
  | 'summarize'
  | 'creative'
  | 'data_analysis'
  | 'tool_action'     // pide ejecutar algo con efecto: deploy, borrar, enviar
  | 'unknown';

/** Capacidades que un agente puede declarar y que el pedido puede requerir. */
export type Capability =
  | 'chat'
  | 'knowledge'
  | 'code'
  | 'debug'
  | 'math'
  | 'web'
  | 'planning'
  | 'synthesis'
  | 'writing'
  | 'analysis'
  | 'tools';

/** Escalones de costo/potencia. Ordenados de menor a mayor. */
export type Tier = 'reflex' | 'light' | 'standard' | 'deep' | 'swarm';

export const TIER_ORDER: readonly Tier[] = ['reflex', 'light', 'standard', 'deep', 'swarm'];

export function tierIndex(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

/** Rasgos superficiales detectados en el texto. */
export interface Artifacts {
  hasCodeBlock: boolean;
  hasInlineCode: boolean;
  hasUrl: boolean;
  hasFilePath: boolean;
  hasStackTrace: boolean;
  hasNumbers: boolean;
  hasJson: boolean;
  hasQuestionMark: boolean;
}

/** Rasgos estructurales: cuantas cosas distintas se estan pidiendo. */
export interface Structure {
  words: number;
  chars: number;
  sentences: number;
  questions: number;
  /** Conectores de secuencia ("y despues", "luego", "ademas"). */
  chainedRequests: number;
  /** Items de lista / bullets / enumeraciones. */
  listItems: number;
  imperatives: number;
}

/** Resultado completo del analisis local. Determinista, sin red, sin tokens. */
export interface Signals {
  raw: string;
  normalized: string;
  lang: 'es' | 'en' | 'unknown';
  /** Intenciones ordenadas por score desc. Siempre al menos una. */
  intents: ScoredIntent[];
  /** Atajo a `intents[0].intent`. */
  primaryIntent: Intent;
  artifacts: Artifacts;
  structure: Structure;
  /** Capacidades requeridas inferidas del pedido. */
  requiredCapabilities: Capability[];
  /** 0..1 — cuanto trabajo cognitivo pide esto. */
  complexity: number;
  /** Desglose de como se compuso `complexity` (para explicabilidad). */
  complexityBreakdown: Record<string, number>;
  /** 0..1 — que tan destructivo/irreversible es lo pedido. */
  risk: number;
  /** 0..1 — que tan seguro esta el analizador de la intencion primaria. */
  confidence: number;
  /** Quien decidio la intencion: el lexico, el semantico, o los dos. */
  intentSource: 'lexicon' | 'semantic' | 'merged';
  /** Lo que dijo el clasificador semantico, gane o pierda. Auditable. */
  semanticTop?: ScoredIntent;
  /** Tier sugerido por el analisis, antes de que el router decida. */
  suggestedTier: Tier;
}

export interface ScoredIntent {
  intent: Intent;
  score: number;
  /** Terminos que dispararon la deteccion (explicabilidad). */
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export interface AgentContext {
  /** Pedido original del usuario. */
  input: string;
  signals: Signals;
  /** Historial de la conversacion, si lo hay. */
  history: Message[];
  /** Salidas de agentes previos en la misma ejecucion (chain / parallel). */
  priorOutputs: AgentOutput[];
  /** Presupuesto restante para esta ejecucion. */
  budget: Budget;
  /** Servicios que el runtime inyecta. */
  services: Services;
  /** Profundidad de escalado actual (0 = primer intento). */
  depth: number;
  signal?: AbortSignal;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentOutput {
  agentId: string;
  text: string;
  /** Si el agente considera que el pedido lo supera, pide escalar. */
  escalate?: {
    reason: string;
    /** Tier minimo sugerido para el reintento. */
    toTier?: Tier;
    /** Capacidades que faltaron. */
    missing?: Capability[];
  };
  /** 0..1 — confianza del agente en su propia respuesta. */
  confidence: number;
  /** Metadata libre por agente. */
  meta?: Record<string, unknown>;
  usage?: Usage;
  /** Herramientas que el agente ejecuto (o intento ejecutar) para responder. */
  toolCalls?: ToolCallRecord[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Costo estimado en USD. */
  costUsd: number;
  ms: number;
}

/** Rol que cumple el agente dentro de una composicion. */
export type AgentRole = 'responder' | 'planner' | 'worker' | 'critic' | 'synthesizer';

/** Definicion de un agente del pool. */
export interface Agent {
  id: string;
  name: string;
  description: string;
  tier: Tier;
  /** Rol en composiciones (chain/parallel). Default: 'worker'. */
  role?: AgentRole;
  capabilities: Capability[];
  /** Intents para los que este agente es candidato natural. */
  intents: Intent[];
  /** Costo relativo 0..1 — usado para penalizar en el ranking. */
  cost: number;
  /**
   * Veto o boost explicito. Devolver:
   *  - `null` para "no aplico a este pedido" (veto duro),
   *  - un numero -1..1 que se suma al score del router.
   */
  accepts?(signals: Signals): number | null;
  run(ctx: AgentContext): Promise<AgentOutput>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type Strategy =
  /** Un solo agente responde. */
  | 'direct'
  /** Cadena secuencial: la salida de uno alimenta al siguiente. */
  | 'chain'
  /** Fan-out en paralelo + sintetizador. */
  | 'parallel';

export interface CandidateScore {
  agentId: string;
  total: number;
  parts: Record<string, number>;
  vetoed?: string;
}

export interface Decision {
  strategy: Strategy;
  /** Agentes elegidos, en orden de ejecucion (para chain) o de fan-out. */
  agents: string[];
  /** Agente que sintetiza cuando la estrategia es `parallel`. */
  synthesizer?: string;
  tier: Tier;
  /** Ranking completo, para explicar por que gano quien gano. */
  ranking: CandidateScore[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Budget {
  /** Costo maximo en USD para la ejecucion completa. */
  maxCostUsd: number;
  /** Cuanto se lleva gastado. */
  spentUsd: number;
  maxMs: number;
  startedAt: number;
  /** Escaladas permitidas. */
  maxEscalations: number;
}

export interface Services {
  model: ModelClient;
  logger: Logger;
  /** Catalogo de herramientas disponibles para los agentes. */
  tools: ToolRegistry;
  /** Quien autoriza las herramientas con efectos. */
  confirm: ConfirmationPolicy;
  /** Raiz del sandbox de archivos. */
  root: string;
}

export interface ModelClient {
  /** Nombre del backend real en uso ("gateway" | "mock"). */
  readonly kind: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** Lo que el modelo necesita saber de una herramienta para poder pedirla. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema de los argumentos. */
  schema: unknown;
}

/** Una vuelta completa del loop: lo que el modelo pidio y lo que le devolvimos. */
export interface ToolTurn {
  calls: ToolCall[];
  results: Array<{ id: string; name: string; content: string; ok: boolean }>;
}

export interface ModelRequest {
  /** Tier logico; el cliente lo mapea a un modelo concreto. */
  tier: Exclude<Tier, 'reflex'>;
  system?: string;
  prompt: string;
  history?: Message[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Herramientas ofrecidas en esta llamada. */
  tools?: ToolSpec[];
  /** Vueltas previas del loop de herramientas, en orden. */
  toolTurns?: ToolTurn[];
}

export interface ModelResponse {
  text: string;
  model: string;
  usage: Usage;
  /** Si viene con contenido, el modelo pidio ejecutar herramientas. */
  toolCalls?: ToolCall[];
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// ---------------------------------------------------------------------------
// Traza
// ---------------------------------------------------------------------------

export interface TraceEvent {
  at: number;
  ms: number;
  type:
    | 'analyze'
    | 'route'
    | 'agent:start'
    | 'agent:end'
    | 'escalate'
    | 'tool:call'
    | 'tool:denied'
    | 'synthesize'
    | 'done'
    | 'error';
  label: string;
  data?: Record<string, unknown>;
}

export interface OrchestrationResult {
  text: string;
  signals: Signals;
  decision: Decision;
  outputs: AgentOutput[];
  trace: TraceEvent[];
  usage: Usage;
  escalations: number;
  /** Todas las herramientas ejecutadas durante la corrida. */
  toolCalls: ToolCallRecord[];
}
