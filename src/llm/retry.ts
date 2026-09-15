/**
 * Reintentos con backoff exponencial.
 *
 * Un 429 o un 503 transitorio no deberia matar una corrida entera: son la
 * falla mas comun contra un proveedor real y casi siempre se resuelven sola
 * esperando un poco.
 */

export interface RetryOptions {
  /** Cuantos reintentos ademas del intento inicial. */
  attempts?: number;
  /** Espera base en ms; se duplica en cada intento. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /**
   * Veto adicional antes de reintentar. Sirve para operaciones con efectos
   * parciales ya visibles: si el stream empezo a emitir texto, rehacerlo se lo
   * mostraria al usuario dos veces.
   */
  canRetry?: () => boolean;
}

const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Encabezados de la respuesta, vengan con el nombre que vengan. */
function headersOf(err: unknown): Record<string, string> | undefined {
  const e = err as { responseHeaders?: Record<string, string>; headers?: Record<string, string> };
  return e.responseHeaders ?? e.headers;
}

/**
 * Limites que no se arreglan esperando.
 *
 * Un 429 por "demasiadas peticiones" pasa solo; uno por "esta peticion es
 * mas grande que el limite" no: la misma peticion va a fallar siempre. El
 * proveedor lo dice de dos formas y conviene escuchar las dos.
 */
function esRechazoPermanente(err: unknown): boolean {
  if (headersOf(err)?.['x-should-retry'] === 'false') return true;
  const msg = ((err as { message?: string }).message ?? '').toLowerCase();
  return /request too large|reduce max_?tokens|exceed the enforced limit|context length/.test(msg);
}

/** Errores de red y respuestas que vale la pena reintentar. */
export function isRetriable(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;

  // Antes que nada: si el proveedor avisa que reintentar no sirve, no se
  // reintenta. Repetir una peticion que excede un limite por tamaño solo
  // gasta tiempo y cuota.
  if (esRechazoPermanente(err)) return false;

  const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
  const status = e.statusCode ?? e.status;
  if (typeof status === 'number') return RETRIABLE_STATUS.has(status);

  if (typeof e.code === 'string') {
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.code)) {
      return true;
    }
  }

  // Ultimo recurso: algunos SDKs solo dejan el texto.
  const msg = (e.message ?? '').toLowerCase();
  return /rate.?limit|too many requests|overloaded|timeout|temporarily unavailable|502|503|504/.test(msg);
}

/** Espera que el proveedor pidio explicitamente, si la mando. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = headersOf(err);
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const segundos = Number(raw);
  return Number.isFinite(segundos) ? segundos * 1000 : undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;

  let ultimo: unknown;
  for (let intento = 0; intento <= attempts; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (intento === attempts || !isRetriable(err)) throw err;
      if (opts.signal?.aborted) throw err;
      if (opts.canRetry && !opts.canRetry()) throw err;

      // Jitter para no sincronizar todos los reintentos del fan-out.
      const exponencial = Math.min(max, base * 2 ** intento);
      const delay = retryAfterMs(err) ?? exponencial * (0.5 + Math.random() * 0.5);

      opts.onRetry?.({ attempt: intento + 1, delayMs: Math.round(delay), error: err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw ultimo;
}
