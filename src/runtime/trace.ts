import type { TraceEvent } from '../core/types.js';

/** Registro ordenado de lo que fue pasando, con tiempos relativos. */
export class Tracer {
  private events: TraceEvent[] = [];
  private t0 = Date.now();

  push(type: TraceEvent['type'], label: string, data?: Record<string, unknown>): void {
    const at = Date.now();
    this.events.push({ at, ms: at - this.t0, type, label, ...(data ? { data } : {}) });
  }

  all(): TraceEvent[] {
    return this.events;
  }

  elapsed(): number {
    return Date.now() - this.t0;
  }
}
