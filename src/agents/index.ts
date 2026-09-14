import { AgentRegistry } from '../router/registry.js';
import { createIdentityAgent, smalltalkAgent } from './reflex.js';
import { LLM_AGENTS } from './pool.js';

export * from './base.js';
export * from './reflex.js';
export * from './pool.js';

/** Registry con el pool completo por defecto. */
export function createDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();

  const describePool = (): string =>
    registry
      .all()
      .map((a) => `- **${a.name}** (\`${a.id}\`, tier ${a.tier}) — ${a.description}`)
      .join('\n');

  registry.register(smalltalkAgent, createIdentityAgent(describePool), ...LLM_AGENTS);
  return registry;
}
