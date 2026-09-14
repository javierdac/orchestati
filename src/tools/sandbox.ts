import { resolve, sep } from 'node:path';

/**
 * Confinamiento de rutas. Toda herramienta que toque el filesystem pasa por
 * aca: si la ruta se escapa de la raiz, no se ejecuta.
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** Resuelve `path` dentro de `root` o tira. Bloquea `..`, absolutas y symlink-ish. */
export function resolveInside(root: string, path: string): string {
  if (!path || typeof path !== 'string') {
    throw new SandboxError('ruta vacia');
  }
  if (path.includes('\0')) {
    throw new SandboxError('ruta invalida');
  }

  const base = resolve(root);
  const target = resolve(base, path);

  if (target !== base && !target.startsWith(base + sep)) {
    throw new SandboxError(`ruta fuera del sandbox: ${path}`);
  }
  return target;
}

/** Ruta relativa a la raiz, para mostrarla sin filtrar el path absoluto. */
export function relativeTo(root: string, target: string): string {
  const base = resolve(root);
  return target === base ? '.' : target.slice(base.length + 1);
}

/** Directorios que nunca se recorren. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.orchestati',
]);
