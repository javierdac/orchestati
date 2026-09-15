import { DEFAULT_MAX_TURNS, trimHistory, type SessionStore } from '../runtime/session.js';
import type { RouterMemory } from '../router/memory.js';
import type { Intent, Message } from '../core/types.js';

/**
 * Adaptadores Redis.
 *
 * Como en el de SQL, no se importa ningun cliente: se recibe uno que cumpla
 * una interfaz minima. Funciona con node-redis y con ioredis, que difieren en
 * detalles pero coinciden en estos comandos.
 */

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  rPush?(key: string, values: string[]): Promise<unknown>;
  rpush?(key: string, ...values: string[]): Promise<unknown>;
  lRange?(key: string, start: number, stop: number): Promise<string[]>;
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
  hGetAll?(key: string): Promise<Record<string, string>>;
  hgetall?(key: string): Promise<Record<string, string>>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hSet?(key: string, field: string, value: string): Promise<unknown>;
  hset?(key: string, field: string, value: string): Promise<unknown>;
}

/** node-redis usa camelCase y ioredis minúsculas: se acepta cualquiera. */
function metodo<T>(c: RedisLike, camel: keyof RedisLike, lower: keyof RedisLike): T {
  const fn = (c[camel] ?? c[lower]) as T | undefined;
  if (!fn) throw new Error(`El cliente de Redis no expone ${String(camel)} ni ${String(lower)}`);
  return fn;
}

// ---------------------------------------------------------------------------

export class RedisSessionStore implements SessionStore {
  constructor(
    private client: RedisLike,
    private maxTurns = DEFAULT_MAX_TURNS,
    private prefix = 'orchestati:session:',
  ) {}

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  async history(sessionId: string): Promise<Message[]> {
    const lrange = metodo<(k: string, a: number, b: number) => Promise<string[]>>(this.client, 'lRange', 'lrange');
    const raw = await lrange.call(this.client, this.key(sessionId), 0, -1);

    const mensajes = raw
      .map((l) => {
        try {
          return JSON.parse(l) as Message;
        } catch {
          return undefined;
        }
      })
      .filter((m): m is Message => Boolean(m?.role && typeof m.content === 'string'));

    return trimHistory(mensajes, this.maxTurns);
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const payload = messages.map((m) => JSON.stringify(m));

    // node-redis toma un array; ioredis, argumentos sueltos.
    if (this.client.rPush) await this.client.rPush(this.key(sessionId), payload);
    else if (this.client.rpush) await this.client.rpush(this.key(sessionId), ...payload);
    else throw new Error('El cliente de Redis no expone rPush ni rpush');
  }

  async clear(sessionId: string): Promise<void> {
    await this.client.del(this.key(sessionId));
  }
}

// ---------------------------------------------------------------------------

const DEFAULT_PRIOR = 0.5;
const ALPHA = 0.25;

/** Ver la nota en el adaptador SQL: el silencio total esconde el problema. */
function avisarUnaVez(quien: string): (err: unknown) => void {
  let avisado = false;
  return (err: unknown) => {
    if (avisado) return;
    avisado = true;
    console.warn(
      `[orchestati] ${quien}: falló una escritura y no se pasó un onError, así que este es el único aviso. ` +
        `El ruteo sigue funcionando con el caché local, pero no está aprendiendo nada. Causa: ${String(err).slice(0, 200)}`,
    );
  };
}

/**
 * El EWMA aplicado del lado de Redis.
 *
 * Leer, calcular y escribir desde el proceso pierde actualizaciones cuando dos
 * instancias escriben a la vez. Este script corre entero y atomico.
 */
const EWMA_LUA = `
local key, field = KEYS[1], ARGV[1]
local outcome, alpha, primera = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local raw = redis.call('HGET', key, field)
local score, n
if raw then
  local sep = string.find(raw, ':')
  score = tonumber(string.sub(raw, 1, sep - 1))
  n = tonumber(string.sub(raw, sep + 1))
  score = score * (1 - alpha) + outcome * alpha
  n = n + 1
else
  score, n = primera, 1
end
redis.call('HSET', key, field, score .. ':' .. n)
return score .. ':' .. n
`.trim();

/**
 * Memoria del router en Redis.
 *
 * `prior()` es sincronico por contrato, asi que lee de un cache local que se
 * calienta con `load()`. Las escrituras van por detras y son atomicas.
 */
export class RedisRouterMemory implements RouterMemory {
  private cache = new Map<string, { score: number; n: number }>();
  private pendientes = new Set<Promise<unknown>>();

  constructor(
    private client: RedisLike,
    private key = 'orchestati:router-memory',
    private onError: (err: unknown) => void = avisarUnaVez('RedisRouterMemory'),
  ) {}

  /** Trae todo a memoria. Llamalo antes de atender pedidos. */
  async load(): Promise<this> {
    const hgetall = metodo<(k: string) => Promise<Record<string, string>>>(this.client, 'hGetAll', 'hgetall');
    const todo = (await hgetall.call(this.client, this.key)) ?? {};

    this.cache = new Map(
      Object.entries(todo).map(([field, raw]) => {
        const [score, n] = raw.split(':');
        return [field, { score: Number(score), n: Number(n) }] as const;
      }),
    );
    return this;
  }

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

    const field = `${intent}::${agentId}`;
    const prev = this.cache.get(field);
    const primera = DEFAULT_PRIOR * (1 - w) + clamped * w;
    this.cache.set(
      field,
      prev ? { score: prev.score * (1 - alpha) + clamped * alpha, n: prev.n + 1 } : { score: primera, n: 1 },
    );

    if (!this.client.eval) {
      this.onError(new Error('El cliente de Redis no expone eval: la escritura no es atomica'));
      return;
    }
    const p = this.client
      .eval(EWMA_LUA, { keys: [this.key], arguments: [field, String(clamped), String(alpha), String(primera)] })
      .catch(this.onError)
      .finally(() => this.pendientes.delete(p));
    this.pendientes.add(p);
  }

  snapshot(): Record<string, { score: number; n: number }> {
    return Object.fromEntries(this.cache);
  }
}
