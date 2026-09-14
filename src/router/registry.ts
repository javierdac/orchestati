import type { Agent, AgentRole, Capability, Tier } from '../core/types.js';

/** Pool de agentes disponibles. */
export class AgentRegistry {
  private agents = new Map<string, Agent>();

  register(...agents: Agent[]): this {
    for (const a of agents) {
      if (this.agents.has(a.id)) throw new Error(`Agente duplicado: ${a.id}`);
      this.agents.set(a.id, a);
    }
    return this;
  }

  get(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Agente desconocido: ${id}`);
    return a;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  all(): Agent[] {
    return [...this.agents.values()];
  }

  byRole(role: AgentRole): Agent[] {
    return this.all().filter((a) => (a.role ?? 'worker') === role);
  }

  byTier(tier: Tier): Agent[] {
    return this.all().filter((a) => a.tier === tier);
  }

  withCapability(cap: Capability): Agent[] {
    return this.all().filter((a) => a.capabilities.includes(cap));
  }
}
