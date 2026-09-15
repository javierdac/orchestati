import { analyze } from '../analysis/analyzer.js';
import { createDefaultRegistry } from '../agents/index.js';
import { Router } from '../router/router.js';
import type { RouterOptions } from '../router/router.js';
import { AgentRegistry } from '../router/registry.js';
import { createModelClientSync } from '../llm/model.js';
import { ToolRegistry } from '../tools/registry.js';
import { EventQueue } from '../core/events.js';
import { InMemorySessionStore, type SessionStore } from './session.js';
import { observeOutcome, SIGNAL_WEIGHT } from './outcome.js';
import { describeAgent, formatSystemInfo, type SystemInfo, type TierInfo } from '../core/info.js';
import { featureSimilarity } from '../analysis/semantic/vectorize.js';
import type { EventSink, OrchestrationEvent } from '../core/events.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import { autoSafe } from '../tools/confirm.js';
import type { ConfirmationPolicy, ToolCallRecord } from '../tools/types.js';
import { Tracer } from './trace.js';
import { TIER_ORDER, tierIndex } from '../core/types.js';
import type {
  Agent,
  AgentContext,
  AgentOutput,
  Budget,
  Decision,
  Logger,
  Message,
  ModelClient,
  OrchestrationResult,
  Services,
  Signals,
  Tier,
  Usage,
} from '../core/types.js';

export interface OrchestratorOptions {
  registry?: AgentRegistry;
  router?: Router;
  routerOptions?: RouterOptions;
  model?: ModelClient;
  logger?: Logger;
  /** Catalogo de herramientas. Por defecto, el completo. */
  tools?: ToolRegistry;
  /**
   * Quien autoriza las herramientas con efectos. El default (`autoSafe`) deja
   * leer sin preguntar y no escribe nada sin permiso explicito.
   */
  confirm?: ConfirmationPolicy;
  /** Raiz del sandbox de archivos. Por defecto, el directorio actual. */
  root?: string;
  /** Memoria conversacional. Por defecto, en memoria del proceso. */
  sessions?: SessionStore;
  /** Presupuesto por defecto de cada corrida. */
  maxCostUsd?: number;
  maxMs?: number;
  maxEscalations?: number;
}

export interface RunOptions {
  history?: Message[];
  /** Si viene, el historial se lee y se escribe en esa sesion. */
  sessionId?: string;
  signal?: AbortSignal;
  maxCostUsd?: number;
  maxMs?: number;
  /** Recibe cada evento de la orquestacion mientras ocurre. */
  onEvent?: EventSink;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
}

function addUsage(a: Usage, b?: Usage): Usage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    ms: a.ms + b.ms,
  };
}

export class Orchestrator {
  readonly registry: AgentRegistry;
  readonly router: Router;
  private model: ModelClient;
  private logger: Logger;
  private services: Services;
  private maxCostUsd: number;
  private maxMs: number;
  private maxEscalations: number;
  readonly sessions: SessionStore;

  /** Corridas recientes, para poder adjuntarles feedback despues. */
  private recientes = new Map<string, { signals: Signals; agentIds: string[]; input: string }>();
  /** Ultima corrida de cada sesion, para detectar reformulaciones. */
  private ultimaPorSesion = new Map<string, string>();

  constructor(opts: OrchestratorOptions = {}) {
    this.registry = opts.registry ?? createDefaultRegistry();
    this.router = opts.router ?? new Router(this.registry, opts.routerOptions ?? {});
    // El constructor es sincronico: para autodetectar un modelo local hay que
    // pasar el cliente ya resuelto con `await createModelClient()`.
    this.model = opts.model ?? createModelClientSync();
    this.logger = opts.logger ?? silentLogger;
    this.services = {
      model: this.model,
      logger: this.logger,
      tools: opts.tools ?? createDefaultToolRegistry(),
      confirm: opts.confirm ?? autoSafe(),
      root: opts.root ?? process.cwd(),
      describeSystem: () => formatSystemInfo(this.info(), { markdown: true }),
    };
    this.maxCostUsd = opts.maxCostUsd ?? 0.5;
    this.maxMs = opts.maxMs ?? 120_000;
    this.maxEscalations = opts.maxEscalations ?? 2;
    this.sessions = opts.sessions ?? new InMemorySessionStore();
  }

  /**
   * Igual que `run`, pero consumible con `for await`. La traza es parte del
   * producto: una UI necesita ver que agente trabaja y que herramienta corre,
   * no solo el texto final.
   */
  stream(input: string, opts: RunOptions = {}): AsyncIterable<OrchestrationEvent> {
    const queue = new EventQueue<OrchestrationEvent>();
    const userSink = opts.onEvent;

    void this.run(input, {
      ...opts,
      onEvent: (event) => {
        queue.push(event);
        userSink?.(event);
      },
    })
      .then(() => queue.close())
      .catch((err: unknown) => {
        queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        queue.close();
      });

    return queue;
  }

  /** Cuantas corridas se recuerdan para poder puntuarlas mas tarde. */
  private static readonly MAX_RECIENTES = 200;

  /**
   * Similitud a partir de la cual se considera que el usuario volvio a pedir
   * lo mismo. Calibrado para no disparar con un pedido genuinamente nuevo.
   */
  private static readonly UMBRAL_REFORMULACION = 0.55;

  private recordarCorrida(
    runId: string,
    datos: { signals: Signals; agentIds: string[]; input: string },
    sessionId?: string,
  ): void {
    this.recientes.set(runId, datos);
    if (this.recientes.size > Orchestrator.MAX_RECIENTES) {
      this.recientes.delete(this.recientes.keys().next().value!);
    }
    if (sessionId) this.ultimaPorSesion.set(sessionId, runId);
  }

  /**
   * Si el pedido nuevo se parece mucho al anterior de la misma sesion, es
   * sintoma de que la respuesta anterior no sirvio. Es la unica señal de
   * calidad que se puede leer sin preguntarle nada al usuario.
   */
  private detectarReformulacion(input: string, sessionId?: string): void {
    if (!sessionId) return;
    const anteriorId = this.ultimaPorSesion.get(sessionId);
    if (!anteriorId) return;
    const anterior = this.recientes.get(anteriorId);
    if (!anterior) return;

    const similitud = featureSimilarity(input, anterior.input);
    if (similitud < Orchestrator.UMBRAL_REFORMULACION) return;

    for (const id of anterior.agentIds) {
      this.router.feedback(anterior.signals, id, 0.2, SIGNAL_WEIGHT.reformulation);
    }
    this.logger.debug('reformulacion detectada', { similitud, runId: anteriorId });
  }

  /**
   * Opinion explicita del usuario sobre una corrida. Es la señal mas fuerte:
   * las otras solo detectan fracaso, esta es la unica que habla de calidad.
   *
   * @param score 0 = no sirvio, 1 = resolvio el pedido
   * @returns si se encontro la corrida
   */
  recordFeedback(runId: string, score: number): boolean {
    const corrida = this.recientes.get(runId);
    if (!corrida) return false;
    for (const id of corrida.agentIds) {
      this.router.feedback(corrida.signals, id, score, SIGNAL_WEIGHT.explicit);
    }
    return true;
  }

  /**
   * Lo que el sistema puede decir de si mismo: backend, modelo y precio por
   * escalon, agentes, herramientas y politica activa.
   *
   * Se calcula desde el estado real —el registry, el catalogo de herramientas,
   * el cliente de modelo— y no desde una lista escrita a mano, para que no
   * pueda quedar desactualizado respecto de lo que el sistema hace.
   */
  info(): SystemInfo {
    const agentes = this.registry.all();

    const tiers: TierInfo[] = TIER_ORDER.map((tier) => {
      const delTier = agentes.filter((a) => a.tier === tier).map((a) => a.id);
      if (tier === 'reflex') return { tier, agents: delTier };
      const resuelto = this.model.describeTier?.(tier);
      return {
        tier,
        agents: delTier,
        ...(resuelto?.model ? { model: resuelto.model } : {}),
        ...(resuelto?.price ? { price: resuelto.price } : {}),
        ...(resuelto?.limits ? { limits: resuelto.limits } : {}),
      };
    });

    return {
      backend: this.model.kind,
      confirm: this.services.confirm.name,
      root: this.services.root,
      tiers,
      agents: agentes.map((a) => describeAgent(a, this.toolsOf(a.id))),
      tools: this.services.tools.all().map((t) => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
      })),
    };
  }

  /** Herramientas que un agente declaro, filtradas a las que existen. */
  private toolsOf(agentId: string): string[] {
    const declaradas = (this.registry.get(agentId) as { tools?: string[] }).tools ?? [];
    return declaradas.filter((n) => this.services.tools.has(n));
  }

  /** Solo analiza, sin ejecutar nada. Util para inspeccionar el ruteo. */
  inspect(input: string): { signals: Signals; decision: Decision } {
    const signals = analyze(input);
    return { signals, decision: this.router.route(signals) };
  }

  async run(input: string, opts: RunOptions = {}): Promise<OrchestrationResult> {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tracer = new Tracer();
    const emit: EventSink = opts.onEvent ?? (() => {});
    const signals = analyze(input);

    // Antes de nada: si esto es una reformulacion del pedido anterior, la
    // corrida anterior se lleva una mala nota.
    this.detectarReformulacion(input, opts.sessionId);

    // El historial explicito gana; si no, se lee de la sesion.
    const history =
      opts.history ?? (opts.sessionId ? await this.sessions.history(opts.sessionId) : []);

    tracer.push('analyze', `intent=${signals.primaryIntent} complejidad=${signals.complexity.toFixed(2)}`, {
      tier: signals.suggestedTier,
      lang: signals.lang,
      risk: Number(signals.risk.toFixed(2)),
      confidence: Number(signals.confidence.toFixed(2)),
      capabilities: signals.requiredCapabilities,
    });
    emit({ type: 'analyze', signals });

    const budget: Budget = {
      maxCostUsd: opts.maxCostUsd ?? this.maxCostUsd,
      spentUsd: 0,
      maxMs: opts.maxMs ?? this.maxMs,
      startedAt: Date.now(),
      maxEscalations: this.maxEscalations,
    };

    let minTier: Tier | undefined;
    let escalations = 0;
    let decision = this.router.route(signals);
    let outputs: AgentOutput[] = [];
    let text = '';

    // Bucle de escalado: un agente puede declararse insuficiente y devolver
    // el pedido al router pidiendo mas potencia.
    for (;;) {
      tracer.push(
        'route',
        `${decision.strategy} -> ${decision.agents.join(' + ')}${decision.synthesizer ? ` | sintetiza ${decision.synthesizer}` : ''}`,
        { tier: decision.tier, reason: decision.reason, top: decision.ranking.slice(0, 3) },
      );
      emit({ type: 'route', decision });

      const run = await this.execute(decision, {
        input,
        signals,
        budget,
        tracer,
        escalations,
        emit,
        ...opts,
        history,
      });
      outputs = [...outputs, ...run.outputs];
      text = run.text;

      if (!run.escalate || escalations >= this.maxEscalations) break;

      const from = decision.tier;
      const to = run.escalate.toTier ?? TIER_ORDER[Math.min(tierIndex(from) + 1, TIER_ORDER.length - 1)]!;
      if (tierIndex(to) <= tierIndex(from)) break;

      escalations++;
      minTier = to;
      tracer.push('escalate', `${from} -> ${to}: ${run.escalate.reason}`, { escalations });
      emit({ type: 'escalate', from, to, reason: run.escalate.reason });
      decision = this.router.route(signals, minTier);
    }

    const usage = outputs.reduce((acc, o) => addUsage(acc, o.usage), emptyUsage());
    usage.ms = tracer.elapsed();
    const toolCalls: ToolCallRecord[] = outputs.flatMap((o) => o.toolCalls ?? []);

    tracer.push(
      'done',
      `${outputs.length} agente(s), ${toolCalls.length} herramienta(s), $${usage.costUsd.toFixed(5)}`,
      { escalations, ms: usage.ms },
    );

    if (opts.sessionId && text) {
      await this.sessions.append(opts.sessionId, [
        { role: 'user', content: input },
        { role: 'assistant', content: text },
      ]);
    }

    const result: OrchestrationResult = {
      id: runId,
      text,
      signals,
      decision,
      outputs,
      trace: tracer.all(),
      usage,
      escalations,
      toolCalls,
    };
    // Feedback al router a partir de lo OBSERVADO, no de lo que el agente dice
    // de si mismo: su `confidence` sale de la complejidad y del comfortMax, que
    // ya se conocian antes de ejecutar. Aprender de eso es aprender de la
    // propia decision previa.
    const observado = observeOutcome(result);
    const peso = observado.weak ? SIGNAL_WEIGHT.weak : SIGNAL_WEIGHT.observed;
    const agentIds = [...new Set(outputs.map((o) => o.agentId))];
    for (const id of agentIds) {
      this.router.feedback(signals, id, observado.score, peso);
    }

    this.recordarCorrida(runId, { signals, agentIds, input }, opts.sessionId);

    emit({ type: 'done', result });
    return result;
  }

  // -------------------------------------------------------------------------
  // Estrategias
  // -------------------------------------------------------------------------

  private async execute(
    decision: Decision,
    env: {
      input: string;
      signals: Signals;
      budget: Budget;
      tracer: Tracer;
      escalations: number;
      emit: EventSink;
      history?: Message[];
      signal?: AbortSignal;
    },
  ): Promise<{ text: string; outputs: AgentOutput[]; escalate?: AgentOutput['escalate'] }> {
    switch (decision.strategy) {
      case 'direct': {
        const agent = this.registry.get(decision.agents[0]!);
        const out = await this.invoke(agent, [], env);
        return { text: out.text, outputs: [out], ...(out.escalate ? { escalate: out.escalate } : {}) };
      }

      case 'chain': {
        const outputs: AgentOutput[] = [];
        for (const id of decision.agents) {
          if (this.exhausted(env.budget)) {
            env.tracer.push('error', `presupuesto agotado antes de ${id}`);
            break;
          }
          const out = await this.invoke(this.registry.get(id), outputs, env);
          outputs.push(out);
          if (out.escalate) {
            return { text: '', outputs, escalate: out.escalate };
          }
        }
        const last = [...outputs].reverse().find((o) => o.text);
        return { text: last?.text ?? '', outputs };
      }

      case 'parallel': {
        const workers = decision.agents.map((id) => this.registry.get(id));

        /**
         * Cada agente del fan-out recibe su propia tajada del presupuesto.
         * Sin esto corren todos contra el mismo total y el primero que use
         * muchas herramientas se lo come entero, dejando a los otros sin nada
         * sin que nadie se entere. Se reserva un tercio para el sintetizador,
         * que corre despues y tiene que poder leer todas las salidas.
         */
        const disponible = Math.max(0, env.budget.maxCostUsd - env.budget.spentUsd);
        const reserva = decision.synthesizer ? disponible / 3 : 0;
        const tajada = (disponible - reserva) / Math.max(1, workers.length);

        const settled = await Promise.all(
          workers.map((a) =>
            this.invoke(a, [], env, tajada).catch((err: unknown) => {
              env.tracer.push('error', `${a.id} fallo: ${String(err)}`);
              const failed: AgentOutput = {
                agentId: a.id,
                text: '',
                confidence: 0,
                meta: { error: String(err) },
              };
              return failed;
            }),
          ),
        );

        const useful = settled.filter((o) => o.text);
        if (useful.length === 0) {
          const escalate = settled.find((o) => o.escalate)?.escalate;
          return { text: '', outputs: settled, ...(escalate ? { escalate } : {}) };
        }

        if (decision.synthesizer && useful.length > 1 && !this.exhausted(env.budget)) {
          env.tracer.push('synthesize', `${decision.synthesizer} fusiona ${useful.length} salidas`);
          env.emit({ type: 'synthesize', agentId: decision.synthesizer, inputs: useful.length });
          const synth = await this.invoke(this.registry.get(decision.synthesizer), useful, env);
          return { text: synth.text, outputs: [...settled, synth] };
        }

        const merged = useful.map((o) => o.text).join('\n\n---\n\n');
        return { text: merged, outputs: settled };
      }
    }
  }

  private exhausted(budget: Budget): boolean {
    return budget.spentUsd >= budget.maxCostUsd || Date.now() - budget.startedAt >= budget.maxMs;
  }

  /**
   * @param maxCostUsd tope propio para esta invocacion. Sin el, el agente
   *                   comparte el presupuesto global con todos los demas.
   */
  private async invoke(
    agent: Agent,
    priorOutputs: AgentOutput[],
    env: {
      input: string;
      signals: Signals;
      budget: Budget;
      tracer: Tracer;
      escalations: number;
      emit: EventSink;
      history?: Message[];
      signal?: AbortSignal;
    },
    maxCostUsd?: number,
  ): Promise<AgentOutput> {
    env.tracer.push('agent:start', `${agent.id} (${agent.tier})`);
    env.emit({ type: 'agent-start', agentId: agent.id, tier: agent.tier });

    const ctx: AgentContext = {
      input: env.input,
      signals: env.signals,
      history: env.history ?? [],
      priorOutputs,
      // Con tope propio, el agente ve un presupuesto acotado y su loop de
      // herramientas corta contra ese, no contra el total de la corrida.
      budget: maxCostUsd === undefined
        ? env.budget
        : { ...env.budget, maxCostUsd, spentUsd: 0 },
      services: this.services,
      depth: env.escalations,
      ...(env.signal ? { signal: env.signal } : {}),
      onDelta: (delta) => env.emit({ type: 'text', agentId: agent.id, delta }),
      onToolCall: (record) => env.emit({ type: 'tool', agentId: agent.id, record }),
    };

    const out = await agent.run(ctx);
    env.budget.spentUsd += out.usage?.costUsd ?? 0;

    // Los agentes no conocen al tracer: la traza de herramientas se deriva de
    // lo que reportaron al volver.
    for (const rec of out.toolCalls ?? []) {
      const tool = rec.call.name;
      if (rec.approved) {
        env.tracer.push('tool:call', `${agent.id} → ${tool}`, {
          risk: rec.risk,
          ok: rec.result.ok,
          ms: rec.ms,
        });
      } else {
        env.tracer.push('tool:denied', `${agent.id} → ${tool} (no ejecutada)`, {
          risk: rec.risk,
          motivo: rec.result.content.slice(0, 120),
        });
      }
    }

    env.tracer.push(
      'agent:end',
      out.escalate ? `${agent.id} pide escalar` : `${agent.id} respondio`,
      {
        confidence: Number(out.confidence.toFixed(2)),
        costUsd: out.usage?.costUsd ?? 0,
        ms: out.usage?.ms ?? 0,
        chars: out.text.length,
      },
    );
    env.emit({ type: 'agent-end', agentId: agent.id, output: out });

    return out;
  }
}
