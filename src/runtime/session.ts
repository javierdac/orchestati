import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../core/types.js';

/**
 * Memoria conversacional. Guarda el ida y vuelta para que un pedido como
 * "ahora hacelo en python" tenga de que agarrarse.
 */
export interface SessionStore {
  history(sessionId: string): Promise<Message[]>;
  append(sessionId: string, messages: Message[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/** Cuantos mensajes se conservan por sesion. */
export const DEFAULT_MAX_TURNS = 20;

/**
 * Recorta conservando el arranque y la cola.
 *
 * Quedarse solo con los ultimos mensajes pierde el primer intercambio, que es
 * donde casi siempre se establece de que se esta hablando: despues de veinte
 * turnos, "ahora pasalo a python" ya no tiene a que referirse. Se guarda el
 * primer par y se completa con lo mas reciente.
 */
export function trimHistory(messages: Message[], maxTurns = DEFAULT_MAX_TURNS): Message[] {
  if (messages.length <= maxTurns) return messages;
  if (maxTurns <= 2) return messages.slice(-maxTurns);

  const cabeza = messages.slice(0, 2);
  const cola = messages.slice(-(maxTurns - 2));
  return [...cabeza, ...cola];
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Message[]>();

  constructor(private maxTurns = DEFAULT_MAX_TURNS) {}

  async history(sessionId: string): Promise<Message[]> {
    return trimHistory(this.sessions.get(sessionId) ?? [], this.maxTurns);
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    const prev = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, trimHistory([...prev, ...messages], this.maxTurns * 2));
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

/**
 * Persistencia en JSONL, un archivo por sesion. Append-only: escribir un turno
 * no reescribe el historial, asi que dos procesos no se pisan.
 */
export class FileSessionStore implements SessionStore {
  constructor(
    private dir = '.orchestati/sessions',
    private maxTurns = DEFAULT_MAX_TURNS,
  ) {}

  private path(sessionId: string): string {
    // El id va en un nombre de archivo: se sanitiza siempre.
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
    return join(this.dir, `${safe}.jsonl`);
  }

  async history(sessionId: string): Promise<Message[]> {
    try {
      const raw = await readFile(this.path(sessionId), 'utf8');
      const messages = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Message;
          } catch {
            return undefined;
          }
        })
        .filter((m): m is Message => Boolean(m?.role && typeof m.content === 'string'));
      return trimHistory(messages, this.maxTurns);
    } catch {
      return [];
    }
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = messages.map((m) => JSON.stringify(m)).join('\n');
    await appendFile(this.path(sessionId), `${lines}\n`, 'utf8');
  }

  async clear(sessionId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.path(sessionId), '', 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(this.path(sessionId), '', 'utf8');
  }
}
