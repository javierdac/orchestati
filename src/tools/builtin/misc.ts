import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';

/**
 * Evaluador aritmetico por shunting-yard. No usa `eval`: el modelo no deberia
 * poder ejecutar codigo arbitrario por mandar una "cuenta".
 */
const OPS: Record<string, { prec: number; right?: boolean; fn: (a: number, b: number) => number }> = {
  '+': { prec: 1, fn: (a, b) => a + b },
  '-': { prec: 1, fn: (a, b) => a - b },
  '*': { prec: 2, fn: (a, b) => a * b },
  '/': { prec: 2, fn: (a, b) => a / b },
  '%': { prec: 2, fn: (a, b) => a % b },
  '^': { prec: 3, right: true, fn: (a, b) => a ** b },
};

export function evaluateExpression(expr: string): number {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/%^()]/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== expr.replace(/\s/g, '')) {
    throw new Error('la expresion tiene caracteres no permitidos');
  }

  const out: number[] = [];
  const ops: string[] = [];

  const apply = (): void => {
    const op = ops.pop()!;
    const b = out.pop();
    const a = out.pop();
    if (a === undefined || b === undefined) throw new Error('expresion mal formada');
    out.push(OPS[op]!.fn(a, b));
  };

  let expectOperand = true;
  for (const t of tokens) {
    if (/^\d/.test(t)) {
      out.push(Number(t));
      expectOperand = false;
    } else if (t === '(') {
      ops.push(t);
      expectOperand = true;
    } else if (t === ')') {
      while (ops.length && ops.at(-1) !== '(') apply();
      if (!ops.length) throw new Error('parentesis sin abrir');
      ops.pop();
      expectOperand = false;
    } else if (OPS[t]) {
      // Menos unario: "-5" o "3 * -2".
      if (t === '-' && expectOperand) {
        out.push(0);
      }
      const o1 = OPS[t]!;
      while (ops.length && ops.at(-1) !== '(') {
        const o2 = OPS[ops.at(-1)!]!;
        if (o2.prec > o1.prec || (o2.prec === o1.prec && !o1.right)) apply();
        else break;
      }
      ops.push(t);
      expectOperand = true;
    }
  }
  while (ops.length) {
    if (ops.at(-1) === '(') throw new Error('parentesis sin cerrar');
    apply();
  }

  const result = out.pop();
  if (result === undefined || out.length > 0 || !Number.isFinite(result)) {
    throw new Error('expresion mal formada');
  }
  return result;
}

export const calculatorTool: Tool<{ expression: string }> = {
  name: 'calculator',
  description: 'Evalua una expresion aritmetica exacta (+ - * / % ^ y parentesis).',
  risk: 'safe',
  schema: z.object({ expression: z.string().describe('ej: (2340 * 15) / 100') }),
  summarize: (a) => `calcular ${a.expression}`,

  async execute(args): Promise<ToolResult> {
    try {
      const value = evaluateExpression(args.expression);
      return { ok: true, content: String(value), meta: { value } };
    } catch (err) {
      return { ok: false, content: `no pude evaluar "${args.expression}": ${(err as Error).message}` };
    }
  },
};

export const httpFetchTool: Tool<{ url: string }> = {
  name: 'http_fetch',
  description: 'Descarga el contenido de una URL publica (solo GET). Requiere confirmacion.',
  risk: 'confirm',
  schema: z.object({ url: z.string().url().describe('URL https') }),
  summarize: (a) => `descargar ${a.url}`,

  async execute(args, ctx): Promise<ToolResult> {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      return { ok: false, content: 'URL invalida' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, content: 'solo se permiten http(s)' };
    }
    // Nada de hablarle a la red interna desde una herramienta del modelo.
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/.test(url.hostname)) {
      return { ok: false, content: 'no se permiten destinos de red local' };
    }

    const timeout = AbortSignal.timeout(15_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
      });
      const text = (await res.text()).slice(0, 50_000);
      return {
        ok: res.ok,
        content: `HTTP ${res.status}\n\n${text}`,
        meta: { status: res.status, host: url.hostname },
      };
    } catch (err) {
      return { ok: false, content: `fallo la descarga: ${String(err)}` };
    }
  },
};
