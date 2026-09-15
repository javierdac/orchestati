import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga un archivo `.env` si existe.
 *
 * Que probar el proyecto dependa de recordar la sintaxis de export de tu shell
 * es una friccion tonta: `export VAR=x` en bash es `set -x VAR x` en fish. Con
 * esto alcanza con poner la key en `.env` y correr.
 *
 * Lo que ya este en el entorno gana: un `.env` no pisa una variable exportada
 * a proposito.
 */
export function loadEnv(dir = process.cwd()): string | undefined {
  for (const nombre of ['.env.local', '.env']) {
    const ruta = resolve(dir, nombre);
    if (!existsSync(ruta)) continue;
    try {
      // Node >= 20.12 trae el parser incorporado.
      process.loadEnvFile(ruta);
      return ruta;
    } catch {
      // Si no esta disponible o el archivo es invalido, se sigue sin el.
      return undefined;
    }
  }
  return undefined;
}
