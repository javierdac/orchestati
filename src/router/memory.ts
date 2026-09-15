import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Intent } from '../core/types.js';

/**
 * Memoria de ruteo: aprende que agente funciona mejor para cada intent.
 * Es un EWMA simple por par (intent, agentId). Barato y explicable.
 */
export interface RouterMemory {
  prior(intent: Intent, agentId: string): number;
  /**
   * @param outcome 0..1
   * @param weight  cuanto confiar en esta señal (0..1). Una observacion pasiva
   *                mueve poco; lo que dice el usuario mueve entero.
   */
  record(intent: Intent, agentId: string, outcome: number, weight?: number): void;
  snapshot(): Record<string, { score: number; n: number }>;
}

const DEFAULT_PRIOR = 0.5;
const ALPHA = 0.25;

export class InMemoryRouterMemory implements RouterMemory {
  protected store = new Map<string, { score: number; n: number }>();

  protected key(intent: Intent, agentId: string): string {
    return `${intent}::${agentId}`;
  }

  prior(intent: Intent, agentId: string): number {
    const e = this.store.get(this.key(intent, agentId));
    if (!e) return DEFAULT_PRIOR;
    // Con pocas muestras se confia mas en el prior neutro.
    const trust = Math.min(1, e.n / 5);
    return DEFAULT_PRIOR * (1 - trust) + e.score * trust;
  }

  record(intent: Intent, agentId: string, outcome: number, weight = 1): void {
    const k = this.key(intent, agentId);
    const e = this.store.get(k);
    const clamped = Math.min(1, Math.max(0, outcome));
    const alpha = ALPHA * Math.min(1, Math.max(0, weight));
    if (alpha === 0) return;

    if (!e) {
      // Una primera señal debil no debe fijar el prior de una: se mezcla con
      // el neutro en proporcion a cuanto se le cree.
      this.store.set(k, { score: DEFAULT_PRIOR * (1 - weight) + clamped * weight, n: 1 });
    } else {
      e.score = e.score * (1 - alpha) + clamped * alpha;
      e.n += 1;
    }
  }

  snapshot(): Record<string, { score: number; n: number }> {
    return Object.fromEntries(this.store);
  }
}

/** Variante persistida en disco (JSON). */
export class FileRouterMemory extends InMemoryRouterMemory {
  constructor(private path: string) {
    super();
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, { score: number; n: number }>;
      this.store = new Map(Object.entries(data));
    } catch {
      // Primera corrida: arranca vacia.
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.snapshot(), null, 2));
    } catch {
      // La memoria es un extra: si no se puede escribir, no rompemos la corrida.
    }
  }

  override record(intent: Intent, agentId: string, outcome: number, weight = 1): void {
    super.record(intent, agentId, outcome, weight);
    this.save();
  }
}
