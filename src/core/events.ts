import type {
  AgentOutput,
  Decision,
  OrchestrationResult,
  Signals,
  Tier,
  ToolCallRecord,
} from './types.js';

/**
 * Eventos de una orquestacion en curso.
 *
 * El streaming util aca no es solo el texto token a token: una UI necesita
 * saber *que agente* esta trabajando, que herramienta se ejecuto y cuando el
 * sistema decidio escalar. La traza es parte del producto, no un log.
 */
export type OrchestrationEvent =
  | { type: 'analyze'; signals: Signals }
  | { type: 'route'; decision: Decision }
  | { type: 'agent-start'; agentId: string; tier: Tier }
  | { type: 'text'; agentId: string; delta: string }
  | { type: 'tool'; agentId: string; record: ToolCallRecord }
  | { type: 'agent-end'; agentId: string; output: AgentOutput }
  | { type: 'escalate'; from: Tier; to: Tier; reason: string }
  | { type: 'synthesize'; agentId: string; inputs: number }
  | { type: 'done'; result: OrchestrationResult }
  | { type: 'error'; message: string };

export type EventSink = (event: OrchestrationEvent) => void;

/**
 * Cola asincronica para convertir un flujo por callback en un `AsyncIterable`.
 * Sin esto habria que elegir entre la API de callbacks y la de iteracion; con
 * esto el orquestador emite por callback y afuera se consume con `for await`.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    this.failure = err;
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return { value: this.buffer.shift()!, done: false };
        }
        if (this.closed) {
          if (this.failure) throw this.failure;
          return { value: undefined as never, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
