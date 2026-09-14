import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { z } from 'zod';
import { IGNORED_DIRS, relativeTo, resolveInside } from '../sandbox.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

const MAX_READ_BYTES = 200_000;
const MAX_MATCHES = 60;

export const readFileTool: Tool<{ path: string }> = {
  name: 'read_file',
  description:
    'Lee un archivo de texto del proyecto. La ruta es relativa a la raiz del proyecto.',
  risk: 'safe',
  schema: z.object({ path: z.string().describe('ruta relativa, ej: src/index.ts') }),
  summarize: (a) => `leer ${a.path}`,

  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.root, args.path);
    const info = await stat(target);
    if (!info.isFile()) return { ok: false, content: `${args.path} no es un archivo` };
    if (info.size > MAX_READ_BYTES) {
      return { ok: false, content: `${args.path} es demasiado grande (${info.size} bytes)` };
    }
    const text = await readFile(target, 'utf8');
    const numbered = text
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}\t${l}`)
      .join('\n');
    return { ok: true, content: numbered, meta: { bytes: info.size } };
  },
};

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description: 'Lista los archivos y carpetas de un directorio del proyecto.',
  risk: 'safe',
  schema: z.object({ path: z.string().optional().describe('ruta relativa; por defecto la raiz') }),
  summarize: (a) => `listar ${a.path ?? '.'}`,

  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.root, args.path ?? '.');
    const entries = await readdir(target, { withFileTypes: true });
    const lines = entries
      .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return { ok: true, content: lines.join('\n') || '(vacio)', meta: { count: lines.length } };
  },
};

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.css', '.html', '.yml', '.yaml', '.sql', '.sh',
]);

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (TEXT_EXT.has(extname(e.name))) yield full;
  }
}

export const searchCodeTool: Tool<{ pattern: string; path?: string }> = {
  name: 'search_code',
  description:
    'Busca una expresion regular en los archivos de texto del proyecto. Devuelve archivo:linea y el contenido.',
  risk: 'safe',
  schema: z.object({
    pattern: z.string().describe('expresion regular'),
    path: z.string().optional().describe('subdirectorio donde buscar'),
  }),
  summarize: (a) => `buscar /${a.pattern}/ en ${a.path ?? '.'}`,

  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.root, args.path ?? '.');
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, 'i');
    } catch (err) {
      return { ok: false, content: `regex invalida: ${String(err)}` };
    }

    const hits: string[] = [];
    for await (const file of walk(target)) {
      if (hits.length >= MAX_MATCHES) break;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${relativeTo(ctx.root, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      }
    }

    return {
      ok: true,
      content: hits.length ? hits.join('\n') : 'sin coincidencias',
      meta: { matches: hits.length, truncated: hits.length >= MAX_MATCHES },
    };
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Escribe (o sobrescribe) un archivo del proyecto. Requiere confirmacion del usuario.',
  risk: 'confirm',
  schema: z.object({
    path: z.string().describe('ruta relativa'),
    content: z.string().describe('contenido completo del archivo'),
  }),
  summarize: (a) => `escribir ${a.path} (${a.content.length} caracteres)`,

  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.root, args.path);

    // Antes de pisar algo, dejamos registrado que habia.
    let previo: number | null = null;
    try {
      previo = (await stat(target)).size;
    } catch {
      previo = null;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.content, 'utf8');

    return {
      ok: true,
      content: `escrito ${args.path} (${args.content.length} caracteres${previo !== null ? `, sobrescribio ${previo} bytes` : ', archivo nuevo'})`,
      meta: { path: args.path, overwrote: previo },
    };
  },
};

export const FS_TOOLS = [readFileTool, listDirTool, searchCodeTool, writeFileTool];
