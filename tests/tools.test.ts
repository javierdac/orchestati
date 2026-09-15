import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { resolveInside, SandboxError } from '../src/tools/sandbox.js';
import { evaluateExpression, calculatorTool, httpFetchTool } from '../src/tools/builtin/misc.js';
import { isPrivateAddress, checkUrlIsPublic } from '../src/tools/net.js';
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

describe('deteccion de direcciones privadas', () => {
  it('reconoce los rangos que no deben alcanzarse', () => {
    for (const ip of [
      '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('deja pasar direcciones publicas', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.167.1.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('ante algo que no puede interpretar, falla cerrado', () => {
    expect(isPrivateAddress('no-es-una-ip')).toBe(true);
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
  });
});

describe('http_fetch', () => {
  it('no le habla a la red local', async () => {
    for (const url of ['http://localhost:8080/x', 'http://127.0.0.1/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data']) {
      const res = await httpFetchTool.execute({ url }, ctx());
      expect(res.ok, url).toBe(false);
    }
  });

  it('rechaza protocolos que no sean http(s)', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      const res = await httpFetchTool.execute({ url }, ctx());
      expect(res.ok).toBe(false);
    }
  });

  it('valida la IP resuelta, no el texto del hostname', async () => {
    // localtest.me y similares resuelven a 127.0.0.1 siendo nombres publicos:
    // un filtro por texto los dejaria pasar.
    const check = await checkUrlIsPublic('http://localhost/x');
    expect(check.ok).toBe(false);

    // Una IP privada escrita en decimal tampoco pasa.
    expect((await checkUrlIsPublic('http://10.0.0.1/x')).ok).toBe(false);
    expect((await checkUrlIsPublic('http://[::1]/x')).ok).toBe(false);
  });

  it('revalida cada redireccion en vez de seguirlas a ciegas', async () => {
    // 93.184.216.34 es publica (IP literal: no consulta DNS) y responde con un
    // 302 hacia loopback. Si el tool siguiera redirecciones solo, la validacion
    // inicial lo habria dejado pasar y terminaria leyendo la red interna.
    const original = globalThis.fetch;
    const visitadas: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      visitadas.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11434/secret' } });
    }) as typeof fetch;

    try {
      const res = await httpFetchTool.execute({ url: 'http://93.184.216.34/ok' }, ctx());
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/red local|privada/);
      // Llego a pedir la primera, pero nunca la segunda.
      expect(visitadas).toEqual(['http://93.184.216.34/ok']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('corta las cadenas de redireccion infinitas', async () => {
    const original = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/vuelta' } });
    }) as typeof fetch;

    try {
      const res = await httpFetchTool.execute({ url: 'http://93.184.216.34/inicio' }, ctx());
      expect(res.ok).toBe(false);
      expect(res.content).toContain('redirecciones');
      expect(n).toBeLessThanOrEqual(6);
    } finally {
      globalThis.fetch = original;
    }
  });
});
