import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { QUALITY_SET } from './quality-set.js';

/**
 * De donde salen los pedidos con los que se ajusta la configuracion.
 *
 * Lo que importa es que sean los pedidos REALES del sistema. Un set curado a
 * mano —como el de calidad— sirve para probar que algo funciona, pero afinar
 * el costo contra el tiene el mismo problema que afinar contra un benchmark:
 * se optimiza para la muestra, no para el trafico.
 */

export interface FuenteDePedidos {
  origen: string;
  pedidos: string[];
}

/** Un pedido por linea. Ignora vacias y comentarios. */
async function desdeArchivo(ruta: string): Promise<string[]> {
  const raw = await readFile(ruta, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Los mensajes de usuario guardados por FileSessionStore. */
async function desdeSesiones(dir = '.orchestati/sessions'): Promise<string[]> {
  const archivos = await readdir(dir).catch(() => [] as string[]);
  const pedidos: string[] = [];

  for (const f of archivos.filter((x) => x.endsWith('.jsonl'))) {
    const raw = await readFile(join(dir, f), 'utf8').catch(() => '');
    for (const linea of raw.split('\n').filter(Boolean)) {
      try {
        const m = JSON.parse(linea) as { role?: string; content?: string };
        if (m.role === 'user' && m.content?.trim()) pedidos.push(m.content.trim());
      } catch {
        // Linea corrupta: se saltea.
      }
    }
  }
  return pedidos;
}

/**
 * `--from=archivo.txt` · `--from=sessions` · nada = el set de calidad.
 * Deduplica: repetir el mismo pedido no aporta informacion y sesga el promedio.
 */
export async function cargarPedidos(spec?: string): Promise<FuenteDePedidos> {
  if (!spec) {
    return { origen: 'set de calidad (curado)', pedidos: QUALITY_SET.map((c) => c.text) };
  }
  if (spec === 'sessions') {
    const pedidos = [...new Set(await desdeSesiones())];
    return { origen: `sesiones guardadas (${pedidos.length} pedidos unicos)`, pedidos };
  }
  const pedidos = [...new Set(await desdeArchivo(spec))];
  return { origen: `${spec} (${pedidos.length} pedidos unicos)`, pedidos };
}
