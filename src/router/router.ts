import type {
  Agent,
  Capability,
  CandidateScore,
  Decision,
  Signals,
  Strategy,
  Tier,
} from '../core/types.js';
import { TIER_ORDER, tierIndex } from '../core/types.js';
import type { AgentRegistry } from './registry.js';
import type { RouterMemory } from './memory.js';
import { InMemoryRouterMemory } from './memory.js';

/** Pesos del ranking de agentes. */
export interface RouterWeights {
  capability: number;
  intent: number;
  tierFit: number;
  prior: number;
  cost: number;
}

export const DEFAULT_WEIGHTS: RouterWeights = {
  capability: 0.3,
  intent: 0.26,
  tierFit: 0.24,
  prior: 0.12,
  cost: 0.08,
};

export interface RouterOptions {
  weights?: Partial<RouterWeights>;
  memory?: RouterMemory;
  /** Tope duro de tier: nunca subir por encima de esto. */
  maxTier?: Tier;
  /** Cuantos agentes lanzar en paralelo cuando la estrategia es `parallel`. */
  fanOut?: number;
}

export class Router {
  private weights: RouterWeights;
  private memory: RouterMemory;
  private maxTier: Tier;
  private fanOut: number;

  constructor(
    private registry: AgentRegistry,
    opts: RouterOptions = {},
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    this.memory = opts.memory ?? new InMemoryRouterMemory();
    this.maxTier = opts.maxTier ?? 'swarm';
    this.fanOut = opts.fanOut ?? 3;
  }

  /** Puntua a un agente contra las senales del pedido. */
  score(agent: Agent, signals: Signals, targetTier: Tier): CandidateScore {
    const parts: Record<string, number> = {};

    /**
     * Cuanto le creemos a la intencion detectada. Si el analizador no esta
     * seguro, el peso de la intencion se recorta y ese peso pasa a la
     * cobertura de capacidades — que se infiere tambien de evidencia dura
     * (bloques de codigo, stack traces, rutas) y no solo del fraseo.
     *
     * En criollo: ante la duda, un agente con las capacidades correctas le
     * gana a un especialista de una intencion que quiza adivinamos mal.
     */
    const trust = 0.4 + 0.6 * signals.confidence;
    const pesoCedido = this.weights.intent * (1 - trust);

    // 1. Cobertura de capacidades requeridas.
    const required = signals.requiredCapabilities.filter((c) => c !== 'chat');
    const covered = required.filter((c) => agent.capabilities.includes(c)).length;
    const coverage = required.length === 0 ? 1 : covered / required.length;
    parts.capability = coverage * (this.weights.capability + pesoCedido);

    // 2. Match de intencion. El intent primario vale entero; los secundarios, menos.
    let intentMatch = 0;
    if (agent.intents.includes(signals.primaryIntent)) {
      intentMatch = 1;
    } else {
      const top = signals.intents[0]?.score ?? 1;
      const secondary = signals.intents
        .slice(1)
        .filter((i) => i.score >= top * 0.5 && agent.intents.includes(i.intent));
      if (secondary.length > 0) intentMatch = 0.6;
    }
    parts.intent = intentMatch * this.weights.intent * trust;

    // 3. Ajuste de tier: penaliza tanto quedarse corto como pasarse de rosca.
    const distance = Math.abs(tierIndex(agent.tier) - tierIndex(targetTier));
    const tierFit = Math.max(0, 1 - distance / 2);
    parts.tierFit = tierFit * this.weights.tierFit;

    // 4. Aprendizaje: como le fue historicamente a este agente con este intent.
    parts.prior = this.memory.prior(signals.primaryIntent, agent.id) * this.weights.prior;

    // 5. Penalizacion por costo.
    parts.cost = -agent.cost * this.weights.cost;

    // 6. Voto propio del agente (veto duro o ajuste fino).
    let vetoed: string | undefined;
    if (agent.accepts) {
      const verdict = agent.accepts(signals);
      if (verdict === null) {
        vetoed = 'el agente se auto-excluyo para este pedido';
      } else {
        parts.self = verdict * 0.2;
      }
    }

    const total = vetoed ? -Infinity : Object.values(parts).reduce((a, b) => a + b, 0);
    return { agentId: agent.id, total, parts, ...(vetoed ? { vetoed } : {}) };
  }

  /** Elige la forma de ejecucion segun el peso y la forma del pedido. */
  private chooseStrategy(signals: Signals, tier: Tier): { strategy: Strategy; reason: string } {
    if (tier === 'reflex' || tier === 'light') {
      return { strategy: 'direct', reason: 'pedido liviano: un solo agente alcanza' };
    }
    if (tier === 'swarm') {
      return {
        strategy: 'parallel',
        reason: 'pedido amplio: se abre en varios agentes y se sintetiza',
      };
    }
    if (signals.structure.chainedRequests >= 2) {
      return {
        strategy: 'chain',
        reason: `se piden ${signals.structure.chainedRequests + 1} cosas encadenadas: plan -> ejecucion -> revision`,
      };
    }
    if (tier === 'deep') {
      return { strategy: 'chain', reason: 'pedido complejo: conviene planificar y revisar' };
    }
    return { strategy: 'direct', reason: 'pedido de complejidad media: un agente especializado' };
  }

  private cap(tier: Tier): Tier {
    const i = Math.min(tierIndex(tier), tierIndex(this.maxTier));
    return TIER_ORDER[i]!;
  }

  /**
   * Decide quien atiende el pedido.
   * @param minTier fuerza un piso de tier (usado al escalar).
   */
  route(signals: Signals, minTier?: Tier): Decision {
    let target = this.cap(signals.suggestedTier);
    if (minTier && tierIndex(minTier) > tierIndex(target)) {
      target = this.cap(minTier);
    }

    const ranking = this.registry
      .all()
      .map((a) => this.score(a, signals, target))
      .sort((a, b) => b.total - a.total);

    const viable = ranking.filter((r) => Number.isFinite(r.total));
    if (viable.length === 0) {
      throw new Error('Ningun agente puede atender este pedido');
    }

    const { strategy, reason } = this.chooseStrategy(signals, target);

    if (strategy === 'direct') {
      return { strategy, agents: [viable[0]!.agentId], tier: target, ranking, reason };
    }

    if (strategy === 'chain') {
      const agents = this.buildChain(viable, signals, target);
      // Si la cadena colapsa a un solo eslabon, es un `direct` y se nombra asi.
      if (agents.length === 1) {
        return { strategy: 'direct', agents, tier: target, ranking, reason: `${reason} (sin eslabones extra)` };
      }
      return { strategy, agents, tier: target, ranking, reason };
    }

    // parallel
    const workers = this.pickDiverse(viable, this.fanOut, target, signals);
    const synth = this.registry.byRole('synthesizer')[0];
    return {
      strategy,
      agents: workers,
      tier: target,
      ranking,
      reason,
      ...(synth ? { synthesizer: synth.id } : {}),
    };
  }

  /**
   * planner -> mejor worker -> critic, pero cada eslabon solo entra si aporta.
   * Planificar un stack trace no sirve de nada: eso se diagnostica, no se planifica.
   */
  private buildChain(viable: CandidateScore[], signals: Signals, target: Tier): string[] {
    const chain: string[] = [];

    const necesitaPlan =
      ['planning', 'research', 'howto'].includes(signals.primaryIntent) ||
      signals.structure.chainedRequests >= 2;

    if (necesitaPlan) {
      const planner = this.registry
        .byRole('planner')
        .find((a) => tierIndex(a.tier) <= tierIndex(target));
      if (planner) chain.push(planner.id);
    }

    const worker = viable.find((r) => {
      const a = this.registry.get(r.agentId);
      const role = a.role ?? 'worker';
      return role === 'worker' || role === 'responder';
    });
    if (worker) chain.push(worker.agentId);
    else chain.push(viable[0]!.agentId);

    // El critico solo entra si el pedido lo justifica.
    if (signals.complexity >= 0.5 || signals.risk >= 0.5) {
      const critic = this.registry.byRole('critic')[0];
      if (critic) chain.push(critic.id);
    }

    return [...new Set(chain)];
  }

  /**
   * Elige N agentes que se complementen de verdad: cada uno tiene que aportar
   * al menos una capacidad *requerida por el pedido* que todavia no este
   * cubierta. Sin esa condicion el fan-out se llena de agentes irrelevantes
   * que aportan capacidades que nadie pidio.
   */
  private pickDiverse(viable: CandidateScore[], n: number, target: Tier, signals: Signals): string[] {
    const required = new Set<Capability>(signals.requiredCapabilities.filter((c) => c !== 'chat'));
    const picked: string[] = [];
    const covered = new Set<string>();
    const best = viable[0]?.total ?? 0;

    for (const cand of viable) {
      if (picked.length >= n) break;
      const agent = this.registry.get(cand.agentId);

      // Los roles de composicion no compiten en el fan-out: el critico y el
      // sintetizador trabajan *sobre* las salidas, no en paralelo con ellas.
      const role = agent.role ?? 'worker';
      if (role === 'synthesizer' || role === 'critic') continue;

      // Nada muy por debajo del tier objetivo ni muy por debajo del mejor score.
      if (tierIndex(agent.tier) < tierIndex(target) - 2) continue;
      if (picked.length > 0 && cand.total < best * 0.45) continue;

      const aporta = agent.capabilities.filter((c) => required.has(c) && !covered.has(c));
      if (picked.length > 0 && aporta.length === 0) continue;

      picked.push(agent.id);
      for (const c of agent.capabilities) covered.add(c);

      // Si ya cubrimos todo lo que el pedido necesita, no sumamos agentes.
      if ([...required].every((c) => covered.has(c))) break;
    }

    if (picked.length === 0) picked.push(viable[0]!.agentId);
    return picked;
  }

  /**
   * Feedback post-ejecucion para que el ranking aprenda.
   * @param weight cuanto confiar en la señal (ver SIGNAL_WEIGHT).
   */
  feedback(signals: Signals, agentId: string, outcome: number, weight = 1): void {
    this.memory.record(signals.primaryIntent, agentId, outcome, weight);
  }
}
