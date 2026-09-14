import { runToolLoop } from '../runtime/tool-loop.js';
import type {
  Agent,
  AgentContext,
  AgentOutput,
  AgentRole,
  Capability,
  Intent,
  Signals,
  Tier,
} from '../core/types.js';

export interface LlmAgentSpec {
  id: string;
  name: string;
  description: string;
  tier: Exclude<Tier, 'reflex'>;
  role?: AgentRole;
  capabilities: Capability[];
  intents: Intent[];
  cost: number;
  system: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Complejidad maxima con la que el agente se siente comodo.
   * Por encima de esto pide escalar en vez de responder mal.
   */
  comfortMax?: number;
  /** Nombres de herramientas que este agente puede usar. */
  tools?: string[];
  /** Cuantas vueltas de herramientas se le permiten. */
  maxToolSteps?: number;
  accepts?(signals: Signals): number | null;
}

/** Arma el prompt final sumando el pedido, el contexto y lo que hicieron los agentes previos. */
export function buildPrompt(ctx: AgentContext): string {
  const parts: string[] = [`## Pedido del usuario\n${ctx.input}`];

  if (ctx.priorOutputs.length > 0) {
    const previos = ctx.priorOutputs
      .map((o, i) => `### ${i + 1}. ${o.agentId}\n${o.text}`)
      .join('\n\n');
    parts.push(`## Trabajo previo de otros agentes\n${previos}`);
  }

  parts.push(
    [
      '## Senales del analisis local',
      `- intencion: ${ctx.signals.primaryIntent}`,
      `- complejidad: ${ctx.signals.complexity.toFixed(2)}`,
      `- idioma: ${ctx.signals.lang}`,
      `- capacidades requeridas: ${ctx.signals.requiredCapabilities.join(', ')}`,
      ctx.signals.risk > 0.3 ? `- riesgo detectado: ${ctx.signals.risk.toFixed(2)} (accion con efectos)` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return parts.join('\n\n');
}

/** Crea un agente respaldado por LLM a partir de su spec. */
export function llmAgent(spec: LlmAgentSpec): Agent {
  const comfortMax = spec.comfortMax ?? 1;

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    tier: spec.tier,
    role: spec.role ?? 'worker',
    capabilities: spec.capabilities,
    intents: spec.intents,
    cost: spec.cost,
    ...(spec.accepts ? { accepts: spec.accepts } : {}),

    async run(ctx: AgentContext): Promise<AgentOutput> {
      // Auto-conocimiento: si el pedido excede lo que este agente puede dar
      // con calidad, escala en vez de entregar una respuesta pobre.
      if (ctx.signals.complexity > comfortMax + 0.12 && ctx.depth < ctx.budget.maxEscalations) {
        return {
          agentId: spec.id,
          text: '',
          confidence: 0.2,
          escalate: {
            reason: `complejidad ${ctx.signals.complexity.toFixed(2)} supera mi techo (${comfortMax})`,
            toTier: spec.tier === 'light' ? 'standard' : spec.tier === 'standard' ? 'deep' : 'swarm',
          },
        };
      }

      const request = {
        tier: spec.tier,
        system: spec.system,
        prompt: buildPrompt(ctx),
        history: ctx.history,
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        ...(spec.maxOutputTokens ? { maxOutputTokens: spec.maxOutputTokens } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      };

      // Confianza: alta si el agente esta comodo con la complejidad del pedido.
      const fit = Math.max(0, 1 - Math.max(0, ctx.signals.complexity - comfortMax) * 2);
      const confidence = Math.min(0.98, 0.55 + fit * 0.4);

      const disponibles = spec.tools?.length ? ctx.services.tools.pick(spec.tools) : [];

      if (disponibles.length > 0) {
        const loop = await runToolLoop({
          ctx,
          agentId: spec.id,
          tools: disponibles,
          request,
          maxSteps: spec.maxToolSteps ?? 4,
        });

        return {
          agentId: spec.id,
          text: loop.text,
          confidence,
          usage: loop.usage,
          toolCalls: loop.records,
          meta: { model: loop.model, toolSteps: loop.steps },
        };
      }

      const res = await ctx.services.model.generate(request);

      return {
        agentId: spec.id,
        text: res.text,
        confidence,
        usage: res.usage,
        meta: { model: res.model },
      };
    },
  };
}
