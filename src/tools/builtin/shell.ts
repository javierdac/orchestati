import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';

const run = promisify(execFile);

/**
 * Binarios que se pueden invocar. Todo lo demas se rechaza: es una lista de
 * permitidos, no de prohibidos, asi que lo que no esta previsto no pasa.
 */
export const ALLOWED_BINARIES: ReadonlySet<string> = new Set([
  'git', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo', 'pwd',
  'node', 'npm', 'pnpm', 'npx', 'tsc', 'vitest', 'jest', 'eslint', 'prettier',
  'python3', 'go', 'cargo',
]);

/** Subcomandos de git que escriben o publican: no pasan por esta herramienta. */
const GIT_FORBIDDEN = new Set(['push', 'reset', 'clean', 'rebase', 'commit', 'merge', 'tag']);

/** Metacaracteres de shell: habilitan encadenar comandos y burlar la allowlist. */
const SHELL_METACHARS = /[;&|`$><(){}\n\\]/;

export interface ParsedCommand {
  bin: string;
  args: string[];
}

/** Valida y tokeniza. Devuelve el motivo del rechazo si no pasa. */
export function parseCommand(command: string): { ok: true; cmd: ParsedCommand } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'comando vacio' };
  if (SHELL_METACHARS.test(trimmed)) {
    return { ok: false, reason: 'el comando contiene metacaracteres de shell (; | & $ > <)' };
  }

  // Tokenizacion simple respetando comillas.
  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const parts = tokens.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t,
  );

  const bin = parts[0];
  if (!bin) return { ok: false, reason: 'comando vacio' };
  if (!ALLOWED_BINARIES.has(bin)) {
    return { ok: false, reason: `"${bin}" no esta en la lista de binarios permitidos` };
  }
  if (bin === 'git' && parts[1] && GIT_FORBIDDEN.has(parts[1])) {
    return { ok: false, reason: `git ${parts[1]} no se ejecuta desde una herramienta` };
  }

  return { ok: true, cmd: { bin, args: parts.slice(1) } };
}

export const runCommandTool: Tool<{ command: string }> = {
  name: 'run_command',
  description:
    'Ejecuta un comando de solo lectura del proyecto (git status, ls, pnpm test, tsc --noEmit). ' +
    'Sin pipes ni redirecciones. Requiere confirmacion.',
  risk: 'destructive',
  schema: z.object({ command: z.string().describe('comando completo, ej: pnpm test') }),
  summarize: (a) => `ejecutar: ${a.command}`,

  async execute(args, ctx): Promise<ToolResult> {
    const parsed = parseCommand(args.command);
    if (!parsed.ok) return { ok: false, content: `rechazado: ${parsed.reason}` };

    try {
      const { stdout, stderr } = await run(parsed.cmd.bin, parsed.cmd.args, {
        cwd: ctx.root,
        timeout: 30_000,
        maxBuffer: 1_000_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      return { ok: true, content: out.slice(0, 20_000) || '(sin salida)', meta: { bin: parsed.cmd.bin } };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
      // Un exit code distinto de cero es informacion util, no un fallo de la herramienta.
      return { ok: false, content: out.slice(0, 20_000), meta: { exitCode: e.code } };
    }
  },
};
