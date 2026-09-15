import { analyze } from '../analysis/analyzer.js';
import { createDefaultRegistry } from '../agents/index.js';
import { Router } from '../router/router.js';
import type { RouterOptions } from '../router/router.js';
import { AgentRegistry } from '../router/registry.js';
import { createModelClientSync } from '../llm/model.js';
import { ToolRegistry } from '../tools/registry.js';
import { EventQueue } from '../core/events.js';
import { InMemorySessionStore, type SessionStore } from './session.js';
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

  /** Solo analiza, sin ejecutar nada. Util para inspeccionar el ruteo. */
  inspect(input: string): { signals: Signals; decision: Decision } {
    const signals = analyze(input);
    return { signals, decision: this.router.route(signals) };
  }

  async run(input: string, opts: RunOptions = {}): Promise<OrchestrationResult> {
    const tracer = new Tracer();
    const emit: EventSink = opts.onEvent ?? (() => {});
    const signals = analyze(input);

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

    // Feedback al router: los agentes que respondieron bien suben de prioridad.
    for (const o of outputs) {
      if (!o.text && o.escalate) this.router.feedback(signals, o.agentId, 0.15);
      else this.router.feedback(signals, o.agentId, o.confidence);
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
      text,
      signals,
      decision,
      outputs,
      trace: tracer.all(),
      usage,
      escalations,
      toolCalls,
    };
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
        const settled = await Promise.all(
          workers.map((a) =>
            this.invoke(a, [], env).catch((err: unknown) => {
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
  ): Promise<AgentOutput> {
    env.tracer.push('agent:start', `${agent.id} (${agent.tier})`);
    env.emit({ type: 'agent-start', agentId: agent.id, tier: agent.tier });

    const ctx: AgentContext = {
      input: env.input,
      signals: env.signals,
      history: env.history ?? [],
      priorOutputs,
      budget: env.budget,
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
