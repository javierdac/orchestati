import type {
  AgentContext,
  ModelRequest,
  ToolSpec,
  ToolTurn,
  Usage,
} from '../core/types.js';
import type { Tool, ToolCall, ToolCallRecord } from '../tools/types.js';

/**
 * Loop de herramientas.
 *
 * El loop lo corremos nosotros y no el SDK del proveedor, porque entre que el
 * modelo pide una herramienta y esa herramienta se ejecuta tiene que pasar el
 * gate de confirmacion. Si el loop vive adentro del SDK, ese gate no existe.
 */

export interface ToolLoopOptions {
  ctx: AgentContext;
  /** Quien esta pidiendo las herramientas: va en la confirmacion y en la traza. */
  agentId: string;
  tools: Tool[];
  request: Omit<ModelRequest, 'tools' | 'toolTurns'>;
  maxSteps: number;
  onEvent?: (type: 'tool:call' | 'tool:denied', label: string, data?: Record<string, unknown>) => void;
  /** Si viene, el texto del modelo se emite a medida que se genera. */
  onDelta?: (delta: string) => void;
  /** Se llama apenas termina cada herramienta, antes de volver al modelo. */
  onToolCall?: (record: ToolCallRecord) => void;
}

export interface ToolLoopResult {
  text: string;
  model: string;
  usage: Usage;
  records: ToolCallRecord[];
  steps: number;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    ms: a.ms + b.ms,
  };
}

/** Convierte una herramienta a lo que el modelo necesita ver. */
export function toSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
  };
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { ctx, agentId, tools, request, maxSteps, onEvent, onDelta, onToolCall } = opts;
  const specs = tools.map(toSpec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const turns: ToolTurn[] = [];
  const records: ToolCallRecord[] = [];
  let usage = emptyUsage();
  let model = '';
  let text = '';

  for (let step = 0; step < maxSteps; step++) {
    // No se arranca una vuelta nueva si ya no hay con que pagarla.
    if (ctx.budget.spentUsd + usage.costUsd >= ctx.budget.maxCostUsd) {
      text = text || 'Corte la ejecucion: se agoto el presupuesto de la corrida.';
      break;
    }

    const call = { ...request, tools: specs, toolTurns: turns };
    const client = ctx.services.model;
    const res =
      onDelta && client.generateStream
        ? await client.generateStream(call, onDelta)
        : await client.generate(call);
    usage = addUsage(usage, res.usage);
    model = res.model;
    text = res.text;

    const calls = res.toolCalls ?? [];
    if (calls.length === 0) break;

    const results: ToolTurn['results'] = [];
    for (const call of calls) {
      const record = await executeCall(call, byName, ctx, agentId, onEvent);
      records.push(record);
      onToolCall?.(record);
      results.push({
        id: call.id,
        name: call.name,
        content: record.result.content,
        ok: record.result.ok,
      });
    }
    turns.push({ calls, results });
  }

  return { text, model, usage, records, steps: turns.length };
}

async function executeCall(
  call: ToolCall,
  byName: Map<string, Tool>,
  ctx: AgentContext,
  agentId: string,
  onEvent?: ToolLoopOptions['onEvent'],
): Promise<ToolCallRecord> {
  const started = Date.now();
  const tool = byName.get(call.name);

  if (!tool) {
    return {
      call,
      risk: 'safe',
      approved: false,
      ms: 0,
      result: { ok: false, content: `la herramienta "${call.name}" no existe` },
    };
  }

  // 1. Validar los argumentos contra el esquema antes de tocar nada.
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    return {
      call,
      risk: tool.risk,
      approved: false,
      ms: Date.now() - started,
      result: { ok: false, content: `argumentos invalidos: ${parsed.error.message}` },
    };
  }
  const args = parsed.data;

  // 2. Gate de confirmacion.
  const summary = tool.summarize(args);
  const decision = await ctx.services.confirm.confirm({
    tool: tool.name,
    risk: tool.risk,
    summary,
    args,
    agentId,
    requestRisk: ctx.signals.risk,
  });

  if (!decision.approved) {
    onEvent?.('tool:denied', `${tool.name}: ${summary}`, { reason: decision.reason });
    return {
      call,
      risk: tool.risk,
      approved: false,
      ms: Date.now() - started,
      result: {
        ok: false,
        content: `No se ejecuto "${summary}": ${decision.reason ?? 'sin autorizacion'}. Segui sin esa herramienta o explicale al usuario que hace falta su permiso.`,
      },
    };
  }

  // 3. Ejecutar.
  onEvent?.('tool:call', `${tool.name}: ${summary}`, { risk: tool.risk });
  try {
    const result = await tool.execute(args, {
      root: ctx.services.root,
      signals: ctx.signals,
      budget: ctx.budget,
      logger: ctx.services.logger,
      agentId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { call, risk: tool.risk, approved: true, ms: Date.now() - started, result };
  } catch (err) {
    return {
      call,
      risk: tool.risk,
      approved: true,
      ms: Date.now() - started,
      result: { ok: false, content: `la herramienta fallo: ${String(err)}` },
    };
  }
}
