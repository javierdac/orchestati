import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { resolveInside, SandboxError } from '../src/tools/sandbox.js';
import { evaluateExpression, calculatorTool, httpFetchTool } from '../src/tools/builtin/misc.js';
import { parseCommand } from '../src/tools/builtin/shell.js';
import { readFileTool, writeFileTool, searchCodeTool, listDirTool } from '../src/tools/builtin/fs.js';
import { analyze } from '../src/analysis/analyzer.js';
import type { ToolContext } from '../src/tools/types.js';

let root: string;

const ctx = (): ToolContext => ({
  root,
  signals: analyze('test'),
  budget: { maxCostUsd: 1, spentUsd: 0, maxMs: 10_000, startedAt: Date.now(), maxEscalations: 1 },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  agentId: 'test',
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orchestati-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const saludo = "hola";\nexport const n = 42;\n');
  await writeFile(join(root, 'secreto.txt'), 'no deberia poder salir del sandbox');
});

describe('sandbox', () => {
  it('permite rutas dentro de la raiz', () => {
    expect(resolveInside('/tmp/x', 'a/b.ts')).toBe('/tmp/x/a/b.ts');
    expect(resolveInside('/tmp/x', './a.ts')).toBe('/tmp/x/a.ts');
  });

  it('bloquea el escape por ..', () => {
    expect(() => resolveInside('/tmp/x', '../../etc/passwd')).toThrow(SandboxError);
    expect(() => resolveInside('/tmp/x', 'a/../../../etc/passwd')).toThrow(SandboxError);
  });

  it('bloquea rutas absolutas fuera de la raiz', () => {
    expect(() => resolveInside('/tmp/x', '/etc/passwd')).toThrow(SandboxError);
  });

  it('bloquea bytes nulos', () => {
    expect(() => resolveInside('/tmp/x', 'a\0b')).toThrow(SandboxError);
  });

  it('no confunde un prefijo de nombre con estar adentro', () => {
    expect(() => resolveInside('/tmp/x', '../xy/z.ts')).toThrow(SandboxError);
  });
});

describe('calculator', () => {
  it('respeta precedencia y parentesis', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('(2340 * 15) / 100')).toBe(351);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512); // asociativo a derecha
    expect(evaluateExpression('-5 + 3')).toBe(-2);
  });

  it('no evalua codigo: rechaza cualquier cosa que no sea aritmetica', async () => {
    expect(() => evaluateExpression('process.exit(1)')).toThrow();
    expect(() => evaluateExpression('1; console.log(9)')).toThrow();
    expect(() => evaluateExpression('require("fs")')).toThrow();

    const res = await calculatorTool.execute({ expression: 'process.exit(1)' }, ctx());
    expect(res.ok).toBe(false);
  });

  it('rechaza expresiones mal formadas', () => {
    expect(() => evaluateExpression('(2 + 3')).toThrow();
    expect(() => evaluateExpression('2 +')).toThrow();
  });
});

describe('run_command', () => {
  it('acepta binarios de la lista', () => {
    expect(parseCommand('git status')).toMatchObject({ ok: true });
    expect(parseCommand('pnpm test')).toMatchObject({ ok: true });
  });

  it('rechaza binarios fuera de la lista', () => {
    expect(parseCommand('rm -rf /')).toMatchObject({ ok: false });
    expect(parseCommand('sudo reboot')).toMatchObject({ ok: false });
    expect(parseCommand('curl http://x.com')).toMatchObject({ ok: false });
  });

  it('rechaza metacaracteres que permitirian encadenar comandos', () => {
    expect(parseCommand('ls; rm -rf /')).toMatchObject({ ok: false });
    expect(parseCommand('ls && rm -rf /')).toMatchObject({ ok: false });
    expect(parseCommand('echo $(whoami)')).toMatchObject({ ok: false });
    expect(parseCommand('cat a > b')).toMatchObject({ ok: false });
    expect(parseCommand('ls | sh')).toMatchObject({ ok: false });
  });

  it('rechaza los subcomandos de git que escriben o publican', () => {
    expect(parseCommand('git push origin main')).toMatchObject({ ok: false });
    expect(parseCommand('git reset --hard')).toMatchObject({ ok: false });
    expect(parseCommand('git log --oneline')).toMatchObject({ ok: true });
  });
});

describe('herramientas de archivos', () => {
  it('lee un archivo con numeros de linea', async () => {
    const res = await readFileTool.execute({ path: 'src/a.ts' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain('saludo');
    expect(res.content).toMatch(/^\s+1\t/);
  });

  it('no lee fuera del sandbox', async () => {
    await expect(readFileTool.execute({ path: '../../etc/passwd' }, ctx())).rejects.toThrow(SandboxError);
  });

  it('busca en el codigo y devuelve archivo:linea', async () => {
    const res = await searchCodeTool.execute({ pattern: 'saludo' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain('src/a.ts:1');
  });

  it('lista un directorio', async () => {
    const res = await listDirTool.execute({ path: '.' }, ctx());
    expect(res.content).toContain('src/');
  });

  it('escribe y avisa si sobrescribio', async () => {
    const nuevo = await writeFileTool.execute({ path: 'src/b.ts', content: 'export const x = 1;' }, ctx());
    expect(nuevo.ok).toBe(true);
    expect(nuevo.content).toContain('archivo nuevo');
    expect(await readFile(join(root, 'src/b.ts'), 'utf8')).toBe('export const x = 1;');

    const pisado = await writeFileTool.execute({ path: 'src/b.ts', content: 'export const x = 2;' }, ctx());
    expect(pisado.content).toContain('sobrescribio');
  });

  it('declara el riesgo correcto', () => {
    expect(readFileTool.risk).toBe('safe');
    expect(searchCodeTool.risk).toBe('safe');
    expect(writeFileTool.risk).toBe('confirm');
  });
});

describe('http_fetch', () => {
  it('no le habla a la red local', async () => {
    for (const url of ['http://localhost:8080/x', 'http://127.0.0.1/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data']) {
      const res = await httpFetchTool.execute({ url }, ctx());
      expect(res.ok).toBe(false);
      expect(res.content).toContain('red local');
    }
  });

  it('rechaza protocolos que no sean http(s)', async () => {
    const res = await httpFetchTool.execute({ url: 'file:///etc/passwd' }, ctx());
    expect(res.ok).toBe(false);
  });
});
