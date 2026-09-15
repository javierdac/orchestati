import { describe, expect, it, vi } from 'vitest';
import { isRetriable, withRetry } from '../src/llm/retry.js';

describe('isRetriable', () => {
  it('reintenta lo transitorio', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetriable({ statusCode: status }), String(status)).toBe(true);
    }
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(isRetriable({ code }), code).toBe(true);
    }
    expect(isRetriable(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRetriable(new Error('model is overloaded'))).toBe(true);
  });

  it('no reintenta lo que no se va a arreglar solo', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetriable({ statusCode: status }), String(status)).toBe(false);
    }
    expect(isRetriable(new Error('invalid api key'))).toBe(false);
  });

  it('no reintenta una cancelacion', () => {
    const abort = new Error('cancelado');
    abort.name = 'AbortError';
    expect(isRetriable(abort)).toBe(false);
  });
});

describe('withRetry', () => {
  it('devuelve el resultado sin reintentar cuando sale bien', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('reintenta hasta que funciona', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw { statusCode: 429 };
      return 'ok';
    });
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('se rinde despues de agotar los intentos', async () => {
    const fn = vi.fn(async () => {
      throw { statusCode: 503 };
    });
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toMatchObject({ statusCode: 503 });
    expect(fn).toHaveBeenCalledTimes(3); // 1 inicial + 2 reintentos
  });

  it('no reintenta un error permanente', async () => {
    const fn = vi.fn(async () => {
      throw { statusCode: 401 };
    });
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toMatchObject({ statusCode: 401 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('respeta el veto de canRetry', async () => {
    // Es el caso del streaming: una vez que se emitio texto, rehacerlo se lo
    // mostraria al usuario duplicado.
    let emitido = false;
    const fn = vi.fn(async () => {
      emitido = true;
      throw { statusCode: 429 };
    });

    await expect(
      withRetry(fn, { baseDelayMs: 1, canRetry: () => !emitido }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('avisa cada reintento', async () => {
    const onRetry = vi.fn();
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw { statusCode: 429 };
        return 'ok';
      },
      { baseDelayMs: 1, onRetry },
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1 });
  });

  it('respeta el retry-after que manda el proveedor', async () => {
    let n = 0;
    const t0 = Date.now();
    await withRetry(
      async () => {
        if (++n < 2) throw { statusCode: 429, responseHeaders: { 'retry-after': '0.05' } };
        return 'ok';
      },
      { baseDelayMs: 5000 }, // el backoff propio seria muchisimo mayor
    );
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
