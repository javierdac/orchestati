import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceOf, pricedModels, PRESETS } from '../src/llm/openai-compatible.js';
import { cargarPedidos } from '../src/dev/requests.js';

describe('priceOf', () => {
  it('encuentra el precio exacto de un modelo conocido', () => {
    const p = priceOf('openai:gpt-4.1-nano');
    expect(p).toMatchObject({ in: 0.1, out: 0.4, known: true });
  });

  it('acepta un modelo sin prefijo usando el proveedor base', () => {
    expect(priceOf('gpt-4.1', 'openai')).toMatchObject({ in: 2, out: 8, known: true });
  });

  it('marca como estimado el precio que sale del fallback', () => {
    const p = priceOf('openai:un-modelo-que-no-existe');
    expect(p?.known).toBe(false);
    // El fallback tiene que ser caro: subestimar gasta de mas y aparece en la factura.
    expect(p!.in).toBeGreaterThan(PRESETS.openai.pricing!['gpt-4.1']!.in);
  });

  it('un modelo local no cuesta nada', () => {
    expect(priceOf('ollama:qwen3:8b')).toMatchObject({ in: 0, out: 0, known: true });
  });

  it('sin proveedor deducible no inventa un precio', () => {
    expect(priceOf('gpt-4.1')).toBeUndefined();
  });
});

describe('pricedModels', () => {
  it('lista modelos con precio, identificados como proveedor:modelo', () => {
    const todos = pricedModels();
    expect(todos.length).toBeGreaterThan(5);
    for (const m of todos) expect(m.spec).toMatch(/^[a-z]+:/);
  });

  it('incluye opciones mas baratas que el default de OpenAI', () => {
    const caro = PRESETS.openai.pricing!['gpt-4.1']!;
    const masBaratos = pricedModels().filter((m) => !m.local && m.price.in < caro.in);
    expect(masBaratos.length).toBeGreaterThan(3);
  });
});

describe('cargarPedidos', () => {
  it('sin fuente usa el set curado', async () => {
    const { pedidos, origen } = await cargarPedidos();
    expect(pedidos.length).toBeGreaterThan(5);
    expect(origen).toContain('curado');
  });

  it('lee un archivo ignorando vacias y comentarios', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tune-'));
    const ruta = join(dir, 'pedidos.txt');
    await writeFile(ruta, '# un comentario\nhola\n\n  que es un closure  \nhola\n');

    const { pedidos } = await cargarPedidos(ruta);
    // Recorta, saltea comentarios y vacias, y deduplica.
    expect(pedidos).toEqual(['hola', 'que es un closure']);
  });

  it('lee los pedidos reales de las sesiones guardadas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tune-sess-'));
    const sesiones = join(dir, '.orchestati', 'sessions');
    await mkdir(sesiones, { recursive: true });
    await writeFile(
      join(sesiones, 'a.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'pedido uno' }),
        JSON.stringify({ role: 'assistant', content: 'una respuesta' }),
        'linea corrupta',
        JSON.stringify({ role: 'user', content: 'pedido dos' }),
      ].join('\n'),
    );

    const previo = process.cwd();
    process.chdir(dir);
    try {
      const { pedidos } = await cargarPedidos('sessions');
      // Solo mensajes de usuario, y la linea corrupta no rompe nada.
      expect(pedidos).toEqual(['pedido uno', 'pedido dos']);
    } finally {
      process.chdir(previo);
    }
  });

  it('sin sesiones devuelve vacio en vez de romper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tune-vacio-'));
    const previo = process.cwd();
    process.chdir(dir);
    try {
      expect((await cargarPedidos('sessions')).pedidos).toEqual([]);
    } finally {
      process.chdir(previo);
    }
  });
});
