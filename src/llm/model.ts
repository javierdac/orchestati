import type { ModelClient, ModelRequest, ModelResponse, Tier, ToolCall } from '../core/types.js';

/**
 * Capa de modelo. El orquestador nunca habla con un proveedor directamente:
 * pide un `tier` logico y esta capa lo mapea a un modelo concreto.
 */

type LlmTier = Exclude<Tier, 'reflex'>;

const DEFAULT_MODELS: Record<LlmTier, string> = {
  light: 'anthropic/claude-haiku-4-5',
  standard: 'anthropic/claude-sonnet-5',
  deep: 'anthropic/claude-opus-5',
  swarm: 'anthropic/claude-sonnet-5',
};

/** USD por millon de tokens (entrada, salida). Aproximado, solo para el budget. */
const PRICING: Record<string, { in: number; out: number }> = {
  'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic/claude-sonnet-5': { in: 3, out: 15 },
  'anthropic/claude-opus-5': { in: 15, out: 75 },
};

export function modelForTier(tier: LlmTier): string {
  const env = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`];
  return env && env.trim() ? env.trim() : DEFAULT_MODELS[tier];
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { in: 3, out: 15 };
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/**
 * Cliente real via Vercel AI Gateway. Usa strings "provider/model", asi que
 * cambiar de proveedor es cambiar una variable de entorno.
 */
export class GatewayModel implements ModelClient {
  readonly kind = 'gateway';

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const model = modelForTier(req.tier);

    const { generateText } = await import('ai');

    const messages: unknown[] = [
      ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: req.prompt },
    ];

    // Se reconstruye el ida y vuelta de herramientas para que el modelo vea
    // lo que pidio y lo que le contestamos.
    for (const turn of req.toolTurns ?? []) {
      messages.push({
        role: 'assistant',
        content: turn.calls.map((c) => ({
          type: 'tool-call',
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        })),
      });
      messages.push({
        role: 'tool',
        content: turn.results.map((r) => ({
          type: 'tool-result',
          toolCallId: r.id,
          toolName: r.name,
          output: { type: 'text', value: r.content },
        })),
      });
    }

    // Se pasan sin `execute`: asi el SDK devuelve la intencion de llamada en
    // vez de ejecutarla, y el gate de confirmacion sigue siendo nuestro.
    const tools = req.tools?.length
      ? Object.fromEntries(
          req.tools.map((t) => [t.name, { description: t.description, inputSchema: t.schema }]),
        )
      : undefined;

    const res = await generateText({
      model,
      ...(req.system ? { system: req.system } : {}),
      messages: messages as never,
      ...(tools ? { tools: tools as never } : {}),
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.signal ? { abortSignal: req.signal } : {}),
    });

    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;

    const toolCalls: ToolCall[] = (res.toolCalls ?? []).map((tc) => ({
      id: (tc as { toolCallId: string }).toolCallId,
      name: (tc as { toolName: string }).toolName,
      args: (tc as { input?: unknown }).input,
    }));

    return {
      text: res.text,
      model,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(model, inputTokens, outputTokens),
        ms: Date.now() - started,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

/**
 * Cliente falso, determinista. Permite correr y testear el orquestador entero
 * sin API key y sin gastar un peso: lo que importa aca es el ruteo.
 */
export class MockModel implements ModelClient {
  readonly kind = 'mock';

  constructor(private latencyMs = 0) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const model = `mock:${modelForTier(req.tier)}`;

    // Si hay herramientas y todavia no se uso ninguna, elige una de forma
    // deterministica. Alcanza para ejercitar el loop completo sin API key.
    const toolCall = (req.toolTurns ?? []).length === 0 ? planToolCall(req) : undefined;
    if (toolCall) {
      const usedIn = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4);
      return {
        text: '',
        model,
        usage: {
          inputTokens: usedIn,
          outputTokens: 20,
          costUsd: estimateCost(modelForTier(req.tier), usedIn, 20),
          ms: Date.now() - started,
        },
        toolCalls: [toolCall],
      };
    }

    const resultados = (req.toolTurns ?? [])
      .flatMap((t) => t.results)
      .map((r) => `${r.name} → ${r.content.split('\n')[0]}`)
      .join(' | ');

    const head = req.prompt.replace(/\s+/g, ' ').slice(0, 160);
    const text = resultados
      ? `[${model}] segun las herramientas: ${resultados}`
      : `[${model}] ${head}${req.prompt.length > 160 ? '…' : ''}`;

    const inputTokens = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4);
    const outputTokens = Math.ceil(text.length / 4);

    return {
      text,
      model,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(modelForTier(req.tier), inputTokens, outputTokens),
        ms: Date.now() - started,
      },
    };
  }
}

/**
 * Elige una herramienta a partir del texto del pedido. Es tosco a proposito:
 * el objetivo no es razonar bien sino que el loop de herramientas sea
 * ejecutable y testeable sin proveedor.
 */
function planToolCall(req: ModelRequest): ToolCall | undefined {
  const names = new Set((req.tools ?? []).map((t) => t.name));
  if (names.size === 0) return undefined;
  const prompt = req.prompt;

  if (names.has('calculator')) {
    const expr = prompt.match(/[\d(][\d\s+\-*/%^().]*\d\s*\)?/g)?.find((e) => /[+\-*/%^]/.test(e));
    if (expr) return { id: 'mock-1', name: 'calculator', args: { expression: expr.trim() } };
  }

  if (names.has('read_file')) {
    const path = prompt.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|ya?ml|sql)\b/)?.[0];
    if (path) return { id: 'mock-1', name: 'read_file', args: { path } };
  }

  if (names.has('search_code')) {
    const quoted = prompt.match(/["'`]([^"'`\n]{3,40})["'`]/)?.[1];
    if (quoted) return { id: 'mock-1', name: 'search_code', args: { pattern: quoted } };
  }

  if (names.has('run_command') && /\b(corre|ejecuta|corre(r|me)?|run|ejecutame)\b/.test(prompt)) {
    const cmd = prompt.match(/\b(git|pnpm|npm|npx|node|tsc|vitest|ls|cat)\s+[\w.:/-]+(\s+[\w.:/-]+)?/)?.[0];
    if (cmd) return { id: 'mock-1', name: 'run_command', args: { command: cmd.trim() } };
  }

  if (names.has('list_dir')) return { id: 'mock-1', name: 'list_dir', args: { path: '.' } };
  return undefined;
}

/** Devuelve el cliente real si hay credenciales; si no, el mock. */
export function createModelClient(): ModelClient {
  const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  return hasKey ? new GatewayModel() : new MockModel();
}
