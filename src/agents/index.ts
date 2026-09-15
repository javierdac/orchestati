import { AgentRegistry } from '../router/registry.js';
import type { Agent } from '../core/types.js';
import { createIdentityAgent, smalltalkAgent } from './reflex.js';
import { LLM_AGENTS } from './pool.js';

export * from './base.js';
export * from './reflex.js';
export * from './pool.js';

/**
 * Registry con el pool completo por defecto.
 *
 * Los agentes del pool son constantes de modulo, asi que se registran copias:
 * de lo contrario dos registries compartirian las mismas instancias y tocar un
 * agente en uno lo tocaria en el otro. Se nota enseguida en los tests, pero el
 * problema real es la sorpresa para quien arma dos orquestadores distintos.
 */
export function createDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();

  // Por defecto describe solo el pool; el orquestador le pasa la descripcion
  // completa del sistema —modelos, precios, herramientas— cuando la tiene.
  const describePool = (): string =>
    registry
      .all()
      .map((a) => `- **${a.name}** (\`${a.id}\`, tier ${a.tier}) — ${a.description}`)
      .join('\n');

  const copia = (a: Agent): Agent => ({ ...a });

  registry.register(
    copia(smalltalkAgent),
    createIdentityAgent(describePool),
    ...LLM_AGENTS.map(copia),
  );
  return registry;
}
