import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from '@ai-sdk/provider';
import type { Orchestrator } from '../runtime/orchestrator.js';
import type { Message, OrchestrationResult } from '../core/types.js';

/**
 * Expone el orquestador como un modelo del AI SDK.
 *
 * Quien ya usa `generateText` o `streamText` lo enchufa cambiando la linea del
 * `model` y se lleva el ruteo sin tocar nada mas: del otro lado sigue viendo
 * texto y tokens, pero adentro el pedido paso por el analizador, el router y
 * el agente que corresponda.
 */

export interface OrchestatiModelOptions {
  /** Sesion para el historial que maneja el orquestador. */
  sessionId?: string;
  /** Id que se reporta al SDK. Aparece en la telemetria del llamador. */
  modelId?: string;
  /** Tope de costo por llamada. */
  maxCostUsd?: number;
}

/** Texto plano de un mensaje del prompt del SDK. */
function textoDe(mensaje: LanguageModelV4Prompt[number]): string {
  const contenido = mensaje.content as unknown;
  if (typeof contenido === 'string') return contenido;
  if (!Array.isArray(contenido)) return '';
  return contenido
    .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * El SDK manda una conversacion; el orquestador espera un pedido y su
 * historial. El ultimo mensaje del usuario es el pedido a rutear —es el que
 * define que hay que hacer— y todo lo anterior es contexto.
 */
export function convertPrompt(prompt: LanguageModelV4Prompt): { input: string; history: Message[] } {
  const ultimoUsuario = prompt.map((m) => m.role).lastIndexOf('user');
  if (ultimoUsuario === -1) {
    return { input: prompt.map(textoDe).filter(Boolean).join('\n'), history: [] };
  }

  const history: Message[] = prompt
    .slice(0, ultimoUsuario)
    .map((m) => ({ role: m.role === 'tool' ? 'assistant' : m.role, content: textoDe(m) }) as Message)
    .filter((m) => m.content.length > 0);

  return { input: textoDe(prompt[ultimoUsuario]!), history };
}

function toUsage(res: OrchestrationResult): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: res.usage.inputTokens,
      noCache: res.usage.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: res.usage.outputTokens, text: res.usage.outputTokens, reasoning: undefined },
  };
}

/**
 * La decision de ruteo viaja como metadata del proveedor: es lo que el llamador
 * no puede deducir del texto y es la razon de usar esto.
 */
function toMetadata(res: OrchestrationResult): Record<string, Record<string, never>> {
  return {
    orchestati: {
      runId: res.id,
      tier: res.decision.tier,
      strategy: res.decision.strategy,
      agents: res.decision.agents,
      intent: res.signals.primaryIntent,
      complexity: Number(res.signals.complexity.toFixed(3)),
      confidence: Number(res.signals.confidence.toFixed(3)),
      costUsd: res.usage.costUsd,
      escalations: res.escalations,
      toolCalls: res.toolCalls.map((t) => ({ name: t.call.name, approved: t.approved, ok: t.result.ok })),
    } as never,
  };
}

/** El orquestador maneja sus propias herramientas: las del llamador se avisan. */
function warnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const out: SharedV4Warning[] = [];
  if (options.tools?.length) {
    out.push({
      type: 'unsupported',
      feature: 'tools',
      details:
        'Orchestati maneja sus propias herramientas por agente, con un gate de confirmacion propio. ' +
        'Registralas en el ToolRegistry del orquestador en vez de pasarlas por el SDK.',
    });
  }
  if (options.responseFormat && options.responseFormat.type !== 'text') {
    out.push({
      type: 'unsupported',
      feature: 'responseFormat',
      details: 'La salida estructurada depende del agente que atienda el pedido, que se elige en tiempo de ejecucion.',
    });
  }
  return out;
}

/**
 * @example
 * const model = orchestatiModel(new Orchestrator());
 * const { text, providerMetadata } = await generateText({ model, prompt: 'hola' });
 * providerMetadata.orchestati.tier  // 'reflex'
 */
export function orchestatiModel(
  orchestrator: Orchestrator,
  opts: OrchestatiModelOptions = {},
): LanguageModelV4 {
  const modelId = opts.modelId ?? 'orchestati';

  const runOptions = (options: LanguageModelV4CallOptions, history: Message[]) => ({
    history,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  });

  return {
    specificationVersion: 'v4',
    provider: 'orchestati',
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const { input, history } = convertPrompt(options.prompt);
      const res = await orchestrator.run(input, runOptions(options, history));

      return {
        content: [{ type: 'text', text: res.text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: toUsage(res),
        providerMetadata: toMetadata(res) as never,
        warnings: warnings(options),
      };
    },

    async doStream(options) {
      const { input, history } = convertPrompt(options.prompt);
      const avisos = warnings(options);
      const textId = 'orchestati-text';

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: avisos });

          let principal: string | undefined;
          let abierto = false;

          try {
            for await (const ev of orchestrator.stream(input, runOptions(options, history))) {
              if (ev.type === 'route') {
                const d = ev.decision;
                // En `parallel` escriben varios a la vez: solo se reenvia el
                // que produce la respuesta final, o el SDK entregaria texto
                // de agentes entremezclado.
                principal = d.strategy === 'direct' ? d.agents[0] : (d.synthesizer ?? d.agents.at(-1));
              }

              if (ev.type === 'text' && ev.agentId === principal) {
                if (!abierto) {
                  controller.enqueue({ type: 'text-start', id: textId });
                  abierto = true;
                }
                controller.enqueue({ type: 'text-delta', id: textId, delta: ev.delta });
              }

              if (ev.type === 'done') {
                const res = ev.result;
                if (!abierto) {
                  controller.enqueue({ type: 'text-start', id: textId });
                  controller.enqueue({ type: 'text-delta', id: textId, delta: res.text });
                  abierto = true;
                }
                controller.enqueue({ type: 'text-end', id: textId });
                controller.enqueue({
                  type: 'finish',
                  usage: toUsage(res),
                  finishReason: { unified: 'stop', raw: undefined },
                  providerMetadata: toMetadata(res) as never,
                });
              }

              if (ev.type === 'error') {
                controller.enqueue({ type: 'error', error: new Error(ev.message) });
              }
            }
          } catch (err) {
            controller.enqueue({ type: 'error', error: err });
          } finally {
            controller.close();
          }
        },
      });

      return { stream };
    },
  };
}
