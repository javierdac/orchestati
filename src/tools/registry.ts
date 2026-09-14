import type { Tool } from './types.js';

/** Catalogo de herramientas disponibles. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Herramienta duplicada: ${t.name}`);
      this.tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Subconjunto por nombre, ignorando los que no existen. */
  pick(names: readonly string[]): Tool[] {
    return names.map((n) => this.tools.get(n)).filter((t): t is Tool => Boolean(t));
  }
}
