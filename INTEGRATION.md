# Integrating Orchestati

How to put the orchestrator inside an existing application. Every snippet here was run against the packaged build, not written from memory.

*See also: [README](README.md) for what the project is, [CONTRIBUTING](CONTRIBUTING.md) for working on it.*

---

## Install

```bash
npm install orchestati        # pnpm add orchestati / yarn add orchestati
```

Requires Node 20.12+ and ESM (`"type": "module"`, or `.mjs`). TypeScript types ship with the package and resolve under `strict` + `nodenext`.

```ts
import { Orchestrator, analyze, llmAgent } from 'orchestati';
import { createOrchestatiServer } from 'orchestati/server';   // optional
```

**Nothing is required to start.** With no API key the orchestrator runs on `MockModel`, where routing is real and answers are placeholders. That is the recommended way to build and test your integration.

---

## Pick the integration depth

The three levels are independent — you can stop at any of them.

| You want | Use | Costs tokens |
|---|---|---|
| To know where a request *would* go | `analyze()` / `orchestrator.inspect()` | no |
| The orchestrator to run the whole thing | `orchestrator.run()` | yes |
| To show progress while it runs | `orchestrator.stream()` | yes |

### Level 1 — routing only, keep your own execution

The cheapest integration, and the one people underestimate. You use the analyzer and router to decide, then execute however you already do.

```ts
import { Orchestrator } from 'orchestati';

const o = new Orchestrator();
const { signals, decision } = o.inspect(userMessage);

if (decision.tier === 'reflex') return cannedReply(signals.primaryIntent);
if (signals.risk >= 0.5) return requireConfirmation(userMessage);

const model = { light: 'gpt-4.1-nano', standard: 'gpt-4.1-mini', deep: 'gpt-4.1' }[decision.tier];
return myExistingPipeline(userMessage, model);
```

`inspect()` is synchronous, deterministic and free. It is a reasonable thing to call on every message even if you ignore most of the result.

### Level 2 — full run

```ts
import { Orchestrator } from 'orchestati';

const o = new Orchestrator({ maxCostUsd: 0.25 });
const res = await o.run(userMessage, { sessionId: user.id });

res.text;               // the answer
res.decision.agents;    // who handled it
res.decision.ranking;   // why that one won
res.usage.costUsd;      // what it cost
res.toolCalls;          // what it ran, and what was denied
res.trace;              // step by step
res.id;                 // to attach feedback later
```

### Level 3 — streaming

```ts
for await (const ev of o.stream(userMessage, { sessionId: user.id })) {
  switch (ev.type) {
    case 'analyze':   showBadge(ev.signals.primaryIntent, ev.signals.complexity); break;
    case 'route':     showPipeline(ev.decision.tier, ev.decision.agents); break;
    case 'tool':      showTool(ev.record.call.name, ev.record.approved); break;
    case 'escalate':  showNotice(`escalated ${ev.from} → ${ev.to}`); break;
    case 'text':      if (ev.agentId === primary) append(ev.delta); break;
    case 'done':      finish(ev.result); break;
    case 'error':     showError(ev.message); break;
  }
}
```

In a `parallel` run several agents stream at once, which is why every text event carries `agentId`. Pick the one whose output becomes the answer:

```ts
const primary = decision.strategy === 'direct'
  ? decision.agents[0]
  : (decision.synthesizer ?? decision.agents.at(-1));
```

---

## Wiring it into a framework

### Next.js App Router — streaming route

```ts
// app/api/chat/route.ts
import { Orchestrator } from 'orchestati';

const orchestrator = new Orchestrator({ maxCostUsd: 0.25 });

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const ev of orchestrator.stream(message, { sessionId, signal: req.signal })) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
  });
}
```

Create the orchestrator **at module scope**, not per request: building the semantic classifier takes ~13 ms and the router's learned memory lives in the instance.

### Express / Fastify

```ts
app.post('/chat', async (req, res) => {
  const result = await orchestrator.run(req.body.message, { sessionId: req.user.id });
  res.json({ text: result.text, cost: result.usage.costUsd, runId: result.id });
});
```

### Already have a server? Mount the bundled one

```ts
import { createOrchestatiServer } from 'orchestati/server';

const app = createOrchestatiServer({ port: 3000, confirm: autoSafe() });
await app.listen();
// app.server is a plain node:http server — put it behind your proxy
```

Importing this module does not start anything; only `pnpm serve` does.

---

## Making it yours

The default pool is generic on purpose. A real integration mostly means replacing it with agents and tools that know your domain.

### Domain agents

```ts
import { Orchestrator, createDefaultRegistry, llmAgent } from 'orchestati';

const refunds = llmAgent({
  id: 'llm.refunds',
  name: 'Refunds',
  description: 'Handles refund requests against our policy.',
  tier: 'standard',
  capabilities: ['knowledge', 'tools'],
  intents: ['factual_qa', 'tool_action'],
  cost: 0.4,
  comfortMax: 0.7,
  tools: ['lookup_order', 'refund_policy'],
  system: 'You handle refunds. Always check the order before promising anything…',
  // Domain vocabulary the generic lexicon cannot know about.
  accepts: (s) => (/\b(refund|reembolso|devoluci[oó]n|chargeback)\b/.test(s.normalized) ? 0.6 : 0),
});

const registry = createDefaultRegistry().register(refunds);
const o = new Orchestrator({ registry });
```

`accepts()` is how an agent expresses domain knowledge the analyzer does not have. Returning `null` is a hard veto; a number from -1 to 1 nudges the score.

You do not have to keep the default pool:

```ts
import { AgentRegistry, Router } from 'orchestati';

const registry = new AgentRegistry().register(myTriage, myWorker, mySpecialist);
const o = new Orchestrator({ registry, router: new Router(registry) });
```

### Tools against your own systems

```ts
import { z } from 'zod';
import type { Tool } from 'orchestati';

export const lookupOrder: Tool<{ orderId: string }> = {
  name: 'lookup_order',
  description: 'Fetches an order by id, with its items and current status.',
  risk: 'safe',                                   // safe | confirm | destructive
  schema: z.object({ orderId: z.string() }),
  summarize: (a) => `look up order ${a.orderId}`, // shown in the confirmation prompt
  async execute(args, ctx) {
    const order = await db.orders.findById(args.orderId);
    if (!order) return { ok: false, content: `order ${args.orderId} not found` };
    return { ok: true, content: JSON.stringify(order), meta: { orderId: args.orderId } };
  },
};
```

Then register it and let agents declare it by name:

```ts
import { createDefaultToolRegistry } from 'orchestati';

const tools = createDefaultToolRegistry().register(lookupOrder, issueRefund);
const o = new Orchestrator({ tools, registry });
```

**Get the risk level right.** `safe` runs with no prompt, so anything that writes, charges, emails or deletes is at least `confirm`. When in doubt pick the higher level: an unnecessary prompt is much cheaper than a silent refund.

The built-in filesystem and shell tools are aimed at a local coding assistant. In a server integration you usually want to drop them:

```ts
import { ToolRegistry, calculatorTool } from 'orchestati';

const tools = new ToolRegistry().register(calculatorTool, lookupOrder, issueRefund);
```

### The confirmation gate, wired to your UI

Behind an HTTP boundary there is nobody to prompt, so the default (`autoSafe`) allows reads and refuses everything else. To let a human decide, implement the gate against whatever channel you have:

```ts
import { askUser } from 'orchestati';

const o = new Orchestrator({
  tools,
  confirm: askUser(async (req) => {
    // req: { tool, risk, summary, args, agentId, requestRisk }
    const approval = await pendingApprovals.create({
      userId: currentUser.id,
      text: `${req.agentId} wants to ${req.summary}`,
      risk: req.risk,
    });
    return await approval.waitForDecision({ timeoutMs: 120_000 });
  }),
});
```

A denial is not a failure: the model is told permission is missing and continues without that tool.

### Sessions in your database

```ts
import type { SessionStore, Message } from 'orchestati';

class PgSessions implements SessionStore {
  async history(sessionId: string): Promise<Message[]> {
    const rows = await db.messages.findMany({
      where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 20,
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }
  async append(sessionId: string, messages: Message[]) {
    await db.messages.createMany({ data: messages.map((m) => ({ sessionId, ...m })) });
  }
  async clear(sessionId: string) {
    await db.messages.deleteMany({ where: { sessionId } });
  }
}

const o = new Orchestrator({ sessions: new PgSessions() });
```

### Learned routing that survives a restart

The router's memory is an EWMA per intent↔agent pair. In a serverless or multi-instance deployment, back it with your own store:

```ts
import { Router, type RouterMemory, type Intent } from 'orchestati';

class SharedMemory implements RouterMemory {
  prior(intent: Intent, agentId: string): number { return cache.get(`${intent}:${agentId}`) ?? 0.5; }
  record(intent: Intent, agentId: string, outcome: number, weight = 1) {
    void redis.eval(EWMA_SCRIPT, `${intent}:${agentId}`, outcome, weight);
  }
  snapshot() { return cache.all(); }
}

const o = new Orchestrator({ registry, router: new Router(registry, { memory: new SharedMemory() }) });
```

`prior()` is called once per agent per request, so it must be fast and synchronous — read from a warm cache and write asynchronously.

**Give it a real signal.** Without feedback, the memory only learns from failures (escalations, tool errors, empty answers), which says nothing about quality. Wire your thumbs up/down:

```ts
const res = await o.run(message, { sessionId });
// …later, when the user rates it
o.recordFeedback(res.id, rating === 'up' ? 1 : 0);
```

---

## Controlling cost

Budgets are per run, so enforce per-user limits outside and per-run limits inside:

```ts
const remaining = await quota.remainingUsd(user.id);
if (remaining <= 0) return tooExpensive();

const res = await o.run(message, {
  sessionId: user.id,
  maxCostUsd: Math.min(0.25, remaining),
  maxMs: 60_000,
});
await quota.charge(user.id, res.usage.costUsd);
```

Two more levers:

```ts
new Orchestrator({
  routerOptions: { maxTier: 'standard' },   // never escalate to the expensive tier
  maxEscalations: 1,
});
```

`maxTier` is the blunt instrument for a free plan: everything still routes normally, it just cannot reach `deep` or `swarm`.

Prices come from a table keyed by model id. If you use a model that is not in it, the cost is estimated with a deliberately high fallback so the budget still cuts — check `src/llm/openai-compatible.ts` and override the models per tier with `ORCHESTATI_MODEL_LIGHT` … `_SWARM`.

---

## Observability

The trace is structured and cheap to forward:

```ts
const res = await o.run(message, {
  sessionId: user.id,
  onEvent: (ev) => {
    if (ev.type === 'route') {
      metrics.increment('orchestati.route', { tier: ev.decision.tier, strategy: ev.decision.strategy });
    }
    if (ev.type === 'tool') {
      metrics.increment('orchestati.tool', { name: ev.record.call.name, approved: String(ev.record.approved) });
    }
    if (ev.type === 'escalate') metrics.increment('orchestati.escalation');
  },
});

metrics.histogram('orchestati.cost_usd', res.usage.costUsd, { tier: res.decision.tier });
logger.info('orchestated', { runId: res.id, trace: res.trace });
```

Worth alerting on: the share of requests reaching `deep`/`swarm` (cost drift), the escalation rate (an agent's `comfortMax` may be miscalibrated), and denied tool calls (an agent asking for something it should not).

---

## Testing your integration

Use `MockModel` — deterministic, free, and it exercises the whole pipeline including the tool loop.

```ts
import { Orchestrator, MockModel, allowAll } from 'orchestati';
import { describe, expect, it } from 'vitest';

const o = new Orchestrator({
  model: new MockModel(),
  registry: myRegistry,
  tools: myTools,
  confirm: allowAll(),
});

it('routes a refund request to the refunds agent', () => {
  expect(o.inspect('quiero un reembolso de mi pedido 1234').decision.agents).toContain('llm.refunds');
});

it('never answers a greeting with a model call', async () => {
  const res = await o.run('hola');
  expect(res.usage.costUsd).toBe(0);
});
```

For tools, assert the containment, not just the happy path: that a `confirm` tool is refused under `autoSafe`, and that a denial leaves the run usable.

Your own routing set is worth building early — copy the shape of `src/dev/routing-set.ts`: a request, the tier you expect, and *why*. It catches the regressions that unit tests do not.

---

## Production checklist

- [ ] The orchestrator is built once at module scope, not per request.
- [ ] `confirm` is set deliberately. The default (`autoSafe`) allows reads; `allowAll()` should never reach production without an external approval step.
- [ ] Filesystem and shell tools are removed, or `root` points at a directory that is safe to expose.
- [ ] Sessions are backed by a real store if you run more than one instance.
- [ ] A per-user quota exists outside the per-run budget.
- [ ] `signal` is passed through so an abandoned request stops costing money.
- [ ] `recordFeedback()` is wired to something, otherwise the router only learns from failures.
- [ ] Model ids per tier are pinned explicitly for reproducibility.

---

## Where to look in the source

| You want to change | File |
|---|---|
| Intent detection, complexity, risk | `src/analysis/analyzer.ts`, `src/analysis/lexicon.ts` |
| Classifier training phrases | `src/analysis/semantic/prototypes.ts` |
| How agents are scored and picked | `src/router/router.ts` |
| Strategies (direct / chain / parallel) | `src/router/router.ts`, `src/runtime/orchestrator.ts` |
| The tool confirmation gate | `src/runtime/tool-loop.ts`, `src/tools/confirm.ts` |
| What the router learns from | `src/runtime/outcome.ts` |
| Providers and per-tier models | `src/llm/openai-compatible.ts` |
