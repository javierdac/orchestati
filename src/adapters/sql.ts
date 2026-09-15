import { DEFAULT_MAX_TURNS, type SessionStore } from '../runtime/session.js';
import type { RouterMemory } from '../router/memory.js';
import type { Intent, Message } from '../core/types.js';

/**
 * Adaptadores SQL (probados contra la sintaxis de Postgres).
 *
 * No se importa ningun driver: se recibe un cliente que sepa hacer `query`.
 * Asi el paquete no arrastra `pg` para quien no lo usa, y funciona igual con
 * un Pool, un Client, o lo que tengas envuelto.
 */

export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SqlTables {
  sessions?: string;
  memory?: string;
}

const DEFAULT_TABLES = { sessions: 'orchestati_sessions', memory: 'orchestati_router_memory' } as const;

/** DDL de las tablas. Se ejecuta a mano o con `ensureSchema`. */
export function sqlSchema(tables: SqlTables = {}): string {
  const s = tables.sessions ?? DEFAULT_TABLES.sessions;
  const m = tables.memory ?? DEFAULT_TABLES.memory;
  return `
CREATE TABLE IF NOT EXISTS ${s} (
  seq        bigserial PRIMARY KEY,
  session_id text        NOT NULL,
  role       text        NOT NULL,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${s}_session_seq ON ${s} (session_id, seq);

CREATE TABLE IF NOT EXISTS ${m} (
  intent   text             NOT NULL,
  agent_id text             NOT NULL,
  score    double precision NOT NULL,
  n        integer          NOT NULL DEFAULT 1,
  PRIMARY KEY (intent, agent_id)
);`.trim();
}

export async function ensureSchema(client: SqlClient, tables: SqlTables = {}): Promise<void> {
  for (const stmt of sqlSchema(tables).split(';').map((x) => x.trim()).filter(Boolean)) {
    await client.query(stmt);
  }
}

// ---------------------------------------------------------------------------

export class SqlSessionStore implements SessionStore {
  private tabla: string;

  constructor(
    private client: SqlClient,
    private maxTurns = DEFAULT_MAX_TURNS,
    tables: SqlTables = {},
  ) {
    this.tabla = tables.sessions ?? DEFAULT_TABLES.sessions;
  }

  /**
   * Conserva el arranque y la cola, igual que los otros stores.
   *
   * Se hace en la consulta y no trayendo todo a memoria: una sesion larga no
   * tiene por que viajar entera para quedarse con veinte mensajes.
   */
  async history(sessionId: string): Promise<Message[]> {
    if (this.maxTurns <= 2) {
      const { rows } = await this.client.query(
        `SELECT role, content FROM ${this.tabla} WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`,
        [sessionId, this.maxTurns],
      );
      return rows.reverse().map(toMessage);
    }

    const { rows } = await this.client.query(
      `(SELECT seq, role, content FROM ${this.tabla} WHERE session_id = $1 ORDER BY seq ASC LIMIT 2)
       UNION
       (SELECT seq, role, content FROM ${this.tabla} WHERE session_id = $1 ORDER BY seq DESC LIMIT $2)
       ORDER BY seq ASC`,
      [sessionId, this.maxTurns - 2],
    );
    return rows.map(toMessage);
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    // Un solo INSERT con todas las filas: un round-trip por turno, no por mensaje.
    const values: unknown[] = [sessionId];
    const tuplas = messages.map((m, i) => {
      values.push(m.role, m.content);
      return `($1, $${i * 2 + 2}, $${i * 2 + 3})`;
    });
    await this.client.query(
      `INSERT INTO ${this.tabla} (session_id, role, content) VALUES ${tuplas.join(', ')}`,
      values,
    );
  }

  async clear(sessionId: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.tabla} WHERE session_id = $1`, [sessionId]);
  }
}

function toMessage(r: Record<string, unknown>): Message {
  return { role: r.role as Message['role'], content: String(r.content ?? '') };
}

// ---------------------------------------------------------------------------

const DEFAULT_PRIOR = 0.5;
const ALPHA = 0.25;

/**
 * Memoria del router en SQL.
 *
 * `prior()` es sincronico por contrato —se llama una vez por agente en cada
 * pedido, en el camino caliente del ruteo—, asi que no puede ir a la red. Se
 * resuelve con un cache local que se calienta al arrancar y se actualiza al
 * escribir; la persistencia va por detras.
 *
 * El EWMA se calcula DENTRO del UPDATE para que dos instancias que escriben a
 * la vez no se pisen: leer, calcular y escribir desde el proceso perderia una
 * de las dos actualizaciones.
 */
export class SqlRouterMemory implements RouterMemory {
  private cache = new Map<string, { score: number; n: number }>();
  private tabla: string;
  private pendientes = new Set<Promise<unknown>>();

  constructor(
    private client: SqlClient,
    tables: SqlTables = {},
    private onError: (err: unknown) => void = () => {},
  ) {
    this.tabla = tables.memory ?? DEFAULT_TABLES.memory;
  }

  /** Carga todo a memoria. Llamalo una vez, antes de atender pedidos. */
  async load(): Promise<this> {
    const { rows } = await this.client.query(`SELECT intent, agent_id, score, n FROM ${this.tabla}`);
    this.cache = new Map(
      rows.map((r) => [`${String(r.intent)}::${String(r.agent_id)}`, { score: Number(r.score), n: Number(r.n) }]),
    );
    return this;
  }

  /** Espera las escrituras en vuelo. Util al apagar el proceso o en tests. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendientes]);
  }

  prior(intent: Intent, agentId: string): number {
    const e = this.cache.get(`${intent}::${agentId}`);
    if (!e) return DEFAULT_PRIOR;
    const trust = Math.min(1, e.n / 5);
    return DEFAULT_PRIOR * (1 - trust) + e.score * trust;
  }

  record(intent: Intent, agentId: string, outcome: number, weight = 1): void {
    const clamped = Math.min(1, Math.max(0, outcome));
    const w = Math.min(1, Math.max(0, weight));
    const alpha = ALPHA * w;
    if (alpha === 0) return;

    const key = `${intent}::${agentId}`;
    const prev = this.cache.get(key);
    this.cache.set(
      key,
      prev
        ? { score: prev.score * (1 - alpha) + clamped * alpha, n: prev.n + 1 }
        : { score: DEFAULT_PRIOR * (1 - w) + clamped * w, n: 1 },
    );

    const primera = DEFAULT_PRIOR * (1 - w) + clamped * w;
    const p = this.client
      .query(
        `INSERT INTO ${this.tabla} (intent, agent_id, score, n) VALUES ($1, $2, $3, 1)
         ON CONFLICT (intent, agent_id) DO UPDATE
         SET score = ${this.tabla}.score * (1 - $5) + $4 * $5, n = ${this.tabla}.n + 1`,
        [intent, agentId, primera, clamped, alpha],
      )
      .catch(this.onError)
      .finally(() => this.pendientes.delete(p));
    this.pendientes.add(p);
  }

  snapshot(): Record<string, { score: number; n: number }> {
    return Object.fromEntries(this.cache);
  }
}
