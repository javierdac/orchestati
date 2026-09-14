import type { z } from 'zod';
import type { Budget, Logger, Signals } from '../core/types.js';

/**
 * Nivel de riesgo de una herramienta. Define que hace falta para ejecutarla.
 *
 * - `safe`        solo lee. Se ejecuta sin preguntar.
 * - `confirm`     escribe o sale a la red. Requiere confirmacion.
 * - `destructive` irreversible. Requiere confirmacion explicita, siempre,
 *                 aunque la politica sea permisiva.
 */
export type RiskLevel = 'safe' | 'confirm' | 'destructive';

export interface ToolContext {
  /** Raiz del sandbox: ninguna herramienta de archivos sale de aca. */
  root: string;
  signals: Signals;
  budget: Budget;
  logger: Logger;
  agentId: string;
  signal?: AbortSignal;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  risk: RiskLevel;
  /** Esquema de los argumentos. Es lo que se le manda al modelo. */
  schema: z.ZodType<A>;
  /** Resumen legible de lo que se va a ejecutar, para la confirmacion. */
  summarize(args: A): string;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  /** Contenido que se le devuelve al modelo. */
  content: string;
  /** Metadata para la traza (no va al modelo). */
  meta?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolCallRecord {
  call: ToolCall;
  result: ToolResult;
  risk: RiskLevel;
  approved: boolean;
  ms: number;
}

// ---------------------------------------------------------------------------
// Confirmacion
// ---------------------------------------------------------------------------

export interface ConfirmationRequest {
  tool: string;
  risk: RiskLevel;
  /** Lo que la herramienta dice que va a hacer, en castellano. */
  summary: string;
  args: unknown;
  agentId: string;
  /** Riesgo que el analizador le vio al pedido original (0..1). */
  requestRisk: number;
}

export interface ConfirmationDecision {
  approved: boolean;
  reason?: string;
}

export interface ConfirmationPolicy {
  readonly name: string;
  confirm(req: ConfirmationRequest): Promise<ConfirmationDecision>;
}
