# Orchestati — Manual

Complete reference. For what the project is and why, read the [README](README.md); for putting it in an application, the [integration guide](INTEGRATION.md); for working on it, [CONTRIBUTING](CONTRIBUTING.md).

---

## Contents

1. [The mental model](#1-the-mental-model)
2. [Setup](#2-setup)
3. [Concepts](#3-concepts)
4. [Command reference](#4-command-reference)
5. [Library API](#5-library-api)
6. [HTTP API](#6-http-api)
7. [Configuration](#7-configuration)
8. [The measurement toolkit](#8-the-measurement-toolkit)
9. [Storage adapters](#9-storage-adapters)
10. [Troubleshooting](#10-troubleshooting)
11. [Known limits](#11-known-limits)

---

## 1. The mental model

```
input ──► Analyzer ──► Router ──► Executor ──► response
          (local)      (local)     (agents)
          0 tokens     0 tokens
```

Three ideas carry the whole design.

**Deciding is free, answering is not.** The analyzer and the router are deterministic local code. Deciding where a request goes costs nothing, so the decision can afford to be careful — and money is only spent where it buys something.

**Uncertainty propagates.** The analyzer is right about ~82% of the time. The remaining 18% must not be able to cause damage, so confidence travels all the way down: a guessed intent gets its complexity pulled toward the mean, the router stops ranking by intent when unsure, and the one path with no recovery — the instant canned reply — requires high confidence to trigger.

**Everything that matters is measured.** Intent accuracy, routing accuracy, answer quality against a baseline, and cost. Several of the project's claims were wrong when first measured, and are now right because measuring said so.

---

## 2. Setup

```bash
pnpm install
pnpm chat        # works immediately, no credentials
```

With no credentials, the orchestrator runs on `MockModel`: **routing is real, answers are placeholders.** The whole system — tool loop, escalation, budget, streaming, sessions, server — is exercised without spending anything.

For real answers, copy `.env.example` to `.env` and set one key. Entry points load it automatically.

```bash
OPENAI_API_KEY=sk-...
# or GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
```

Requires Node 20.12+. As a dependency: `npm install orchestati`.

---

## 3. Concepts

### Tiers

Five, ordered by cost and capability:

| Tier | What it is | Agents |
|---|---|---|
| `reflex` | No model at all. Fixed replies. | 2 |
| `light` | Small model, short answers. | 1 |
| `standard` | Real work, bounded scope. | 6 |
| `deep` | Needs reasoning, diagnosis or design. | 3 |
| `swarm` | Not a power level — a *shape*. Fans out to lower tiers plus a synthesizer. | 0 |

`swarm` having no agents of its own is deliberate. It is reached by an explicit rule rather than a threshold: complexity ≥ 0.5 **and** the request contains more than one task. A single request, however hard, gains nothing from fanning out.

### Intents

Twenty, detected by a bilingual (Spanish/English) lexicon, with the matched terms kept as evidence. Conversational intents (`greeting`, `thanks`, …) scale their score by the fraction of the message they occupy, so `"hi, refactor this for me"` routes to `refactor`, not `greeting`.

### Complexity

A score from 0 to 1 where the task's intrinsic difficulty acts as a **floor**, not as one term among many — *"design the architecture of X"* is heavy even in twelve words. Length, chained requests, breadth, artifacts and structure amplify from there. The breakdown is on every `Signals` object.

### Strategies

| Strategy | Shape |
|---|---|
| `direct` | One agent. |
| `chain` | planner → worker → critic, where **each link is included only if it contributes**. |
| `parallel` | Fan-out plus a synthesizer. Each agent must cover a capability the request actually requires and no one else has covered. |

### Agents

An agent declares what it can do, what it costs, and `comfortMax` — the complexity above which it would rather escalate than answer badly. It can also veto itself through `accepts()`, which is where domain knowledge the analyzer cannot have belongs.

### Tools and the confirmation gate

Tools declare a risk level: `safe` runs unprompted, `confirm` writes or reaches the network, `destructive` may be irreversible.

**The tool loop runs in Orchestati, not in the provider's SDK.** That is what makes the gate possible: between the model asking for a tool and the tool running, something must be able to say no. A denial is not an error — the model is told permission is missing and continues without it.

| Policy | Behavior |
|---|---|
| `autoSafe()` | **Default.** Reads yes, writes no. |
| `askUser(fn)` | `safe` passes; the rest goes to your callback. |
| `denyAll()` | Everything refused. Shows what an agent *would* do. |
| `allowAll()` | No prompting. Only where authorization happened elsewhere. |

---

## 4. Command reference

### Running requests

```bash
pnpm chat                             # interactive: routing, tokens and cost live
pnpm dev "<request>"                  # one shot
pnpm dev --explain "<request>"        # analysis and decision, without executing
pnpm dev --trace "<request>"          # run and print the step-by-step trace
pnpm dev --json "<request>"           # structured output
pnpm dev --dry-run "<request>"        # deny every tool: see what it would do
pnpm dev --yes "<request>"            # authorize tools without prompting
pnpm dev --no-session "<request>"     # do not read or write conversation history
pnpm dev                              # interactive REPL
pnpm serve                            # HTTP server, SSE and demo UI
```

Inside `pnpm chat`:

| Command | Effect |
|---|---|
| `/examples` · `/ejemplos` | one request per routing path |
| `/1` … `/11` | run that example |
| `/cost` · `/costo` | session usage, by tier and by agent |
| `/good` `/bad` | rate the last answer — **this is what the router learns from** |
| `/trace` · `/traza` | toggle the detailed trace |
| `/exit` · `/salir` | leave (prints the summary) |

### Measuring

```bash
pnpm table                            # routing calibration bench
pnpm eval                             # intent accuracy, held-out set A
pnpm eval b                           # same, control set B
pnpm eval:routing                     # routing accuracy and cost-error direction
pnpm eval:quality                     # does the cheap tier answer well enough? (spends money)
```

### Tuning cost

```bash
pnpm tune --profile --from=sessions   # measure real token usage (spends money, once)
pnpm tune --calibrate                 # measure how verbose each model is (spends money, once)
pnpm tune                             # sweep configurations (free)
pnpm tune --json                      # machine-readable sweep
pnpm tune --include-local             # let local models be proposed
pnpm tune --all-providers             # include providers without credentials
pnpm cycle                            # sweep, then validate the recommendation
```

### Inspecting and maintaining

```bash
pnpm info                             # models and prices per tier, agents, tools
pnpm info --json
pnpm models                           # ask each provider what it actually offers
pnpm models groq                      # just one
pnpm smoke                            # one request per tier against the real API
pnpm test                             # the suite
pnpm typecheck
pnpm build
pnpm verify:package                   # install the built package elsewhere and check it works
```

---

## 5. Library API

### Orchestrator

```ts
import { Orchestrator } from 'orchestati';

const o = new Orchestrator({
  registry,          // AgentRegistry       — default: the full pool
  router,            // Router              — default: built from the registry
  routerOptions,     // { weights, memory, maxTier, fanOut }
  model,             // ModelClient         — default: from credentials, else mock
  tools,             // ToolRegistry        — default: the full catalogue
  confirm,           // ConfirmationPolicy  — default: autoSafe()
  sessions,          // SessionStore        — default: in memory
  root,              // filesystem sandbox  — default: cwd
  logger,
  maxCostUsd,        // default 0.5
  maxMs,             // default 120_000
  maxEscalations,    // default 2
});
```

| Method | Purpose |
|---|---|
| `inspect(input)` | `{ signals, decision }` — synchronous, free, executes nothing |
| `run(input, opts)` | full execution, returns `OrchestrationResult` |
| `stream(input, opts)` | the same as an `AsyncIterable<OrchestrationEvent>` |
| `recordFeedback(runId, score)` | rate a past run; the strongest learning signal |
| `info()` | what this system is right now |
| `registry` · `router` · `sessions` | the pieces, for direct access |

`RunOptions`: `{ sessionId, history, signal, maxCostUsd, maxMs, onEvent }`.

### OrchestrationResult

```ts
{
  id,            // to attach feedback later
  text,          // the answer
  signals,       // everything the analyzer found
  decision,      // strategy, agents, tier, full ranking, reason
  outputs,       // per-agent output, usage and confidence
  toolCalls,     // what ran, what was denied
  trace,         // step by step, with timings
  usage,         // tokens and cost
  escalations,
}
```

### Streaming events

```ts
for await (const ev of o.stream(input)) { /* ev.type */ }
```

`analyze` · `route` · `agent-start` · `text` · `tool` · `agent-end` · `escalate` · `synthesize` · `done` · `error`.

Every `text` event carries `agentId`, because in `parallel` several agents write at once.

### Defining an agent

```ts
import { llmAgent } from 'orchestati';

llmAgent({
  id, name, description,
  tier,                    // light | standard | deep | swarm
  role,                    // responder | planner | worker | critic | synthesizer
  capabilities, intents, cost,
  system,                  // the system prompt
  comfortMax,              // above this complexity it escalates instead of answering badly
  tools,                   // names from the ToolRegistry
  maxToolSteps,
  temperature, maxOutputTokens,
  accepts: (signals) => number | null,   // null = hard veto
});
```

For an agent that does not use an LLM, implement `Agent` directly — `src/agents/reflex.ts` is the worked example.

### Defining a tool

```ts
import { z } from 'zod';
import type { Tool } from 'orchestati';

const tool: Tool<{ id: string }> = {
  name, description,
  risk: 'safe' | 'confirm' | 'destructive',
  schema: z.object({ id: z.string() }),
  summarize: (args) => 'what this will do',   // shown in the confirmation
  execute: async (args, ctx) => ({ ok: true, content: '…' }),
};
```

`ctx` gives `root`, `signals`, `budget`, `logger`, `agentId`, `signal`.

### AI SDK adapter

```ts
import { generateText } from 'ai';
import { orchestatiModel } from 'orchestati';

const model = orchestatiModel(orchestrator, { sessionId, maxCostUsd, modelId });
const { text, providerMetadata } = await generateText({ model, prompt });
providerMetadata.orchestati;  // runId, tier, strategy, agents, intent, cost, toolCalls…
```

Tools passed through the SDK are not used — Orchestati manages its own, with its own gate — and you get an explicit warning rather than silence.

---

## 6. HTTP API

```bash
pnpm serve                # http://127.0.0.1:3000, PORT to change it
```

| Endpoint | Purpose |
|---|---|
| `POST /chat` | `{ input, sessionId? }` → the full result |
| `POST /chat/stream` | the same as SSE, one event per line |
| `POST /inspect` | analysis and decision, **without executing** |
| `GET /info` | models and prices per tier, agents, tools, active policy |
| `GET /agents` | the pool |
| `GET /session/:id` · `DELETE` | conversation history |
| `GET /health` | liveness |
| `GET /` | demo UI: pipeline, tools and trace, live |

Behind an HTTP boundary there is nobody to ask whether an `rm` is authorized, so the server's default policy is `autoSafe`. Raising it is an explicit decision.

---

## 7. Configuration

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Gemini (free tier), via its OpenAI-compatible endpoint |
| `GROQ_API_KEY` | Groq (free tier), open-weight models |
| `MOONSHOT_API_KEY` · `DEEPSEEK_API_KEY` · `CEREBRAS_API_KEY` · `OPENROUTER_API_KEY` · `XAI_API_KEY` | other providers |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway — one key for all |
| `ORCHESTATI_PROVIDER` | force a backend, including `ollama`, `lmstudio`, `mock` |
| `ORCHESTATI_MODEL_LIGHT` … `_SWARM` | model per tier; accepts `provider:model` to **mix providers** |
| `ORCHESTATI_BASE_URL` | your own OpenAI-compatible endpoint |
| `ORCHESTATI_RETRIES` | retries on transient provider failures (default 3) |
| `PORT` | HTTP server port |

**Local backends are never auto-detected.** A server listening on a port is not the same as a server you meant to use; ask for it with `ORCHESTATI_PROVIDER=ollama`.

**Mixing providers across tiers is the setting that decides whether routing saves money.** Within one provider, adjacent tiers are ~5× apart in price, and since `chain` and `parallel` run two or three agents, the middle tier ends up costing about the same as one call to the expensive one. Across providers the gap is 10×–40×.

```bash
ORCHESTATI_MODEL_LIGHT=groq:openai/gpt-oss-20b
ORCHESTATI_MODEL_STANDARD=openai:gpt-4.1-mini
ORCHESTATI_MODEL_DEEP=openai:gpt-4.1
```

---

## 8. The measurement toolkit

### What each tool answers

| Tool | Question | Cost |
|---|---|---|
| `pnpm table` | Where does a fixed set of requests route? | free |
| `pnpm eval` · `eval b` | How often is the intent right? | free |
| `pnpm eval:routing` | How often is the *decision* right, and in which direction does it err? | free |
| `pnpm tune` | What would each configuration cost? | free after one profile |
| `pnpm eval:quality` | Does the cheap tier answer well enough? | spends money |

The first four are free and run in CI. The last one is the only one that needs real models, and it is the only one that can tell you whether saving money cost you anything.

### The tuning loop

```bash
pnpm tune --profile --from=sessions   # 1. real token usage, from real traffic
pnpm tune --calibrate                 # 2. how verbose each candidate model is
pnpm tune                             # 3. sweep, free, as often as you like
pnpm eval:quality                     # 4. validate the winner
ORCHESTATI_MODEL_DEEP=… pnpm tune --profile   # 5. re-profile with what you adopted
```

**Read the sweep in this order.** First *where the money goes* — if one tier carries most of the spend, the options on the others are noise. Then the *ranking* for that tier: trust the order, not the percentage. Then change one tier at a time, which is what the default recommendation does, so a quality drop has an obvious cause.

### Why calibration exists

Cost is `tokens × price`. The sweep knows price exactly and used to *assume* tokens stay put when the model changes. That assumption was the entire source of its error: a predicted 67% saving came out at 31%, a predicted 72% came out at 13%.

Calibration measures the difference instead. It is cheap because **input tokens barely change between models** — the prompt is ours — so only output verbosity needs measuring. The first run produced the result that justified the feature:

```
openai:gpt-4.1        655 tok  1.0×
openai:gpt-4.1-mini   718 tok  1.1×
openai:gpt-5-mini    2162 tok  3.3×
openai:gpt-5-nano    5328 tok  8.1×
```

`gpt-5-nano`, the cheapest model in the table per token, writes 8.1× more than `gpt-4.1`. **Price per token is not price per answer**, and the gap is widest exactly where a reasoning model is sold as the budget option.

### Rate limits are part of the cost

A configuration that cannot handle your traffic is not cheaper, it is unusable. The sweep reads per-model limits from the presets and checks them against the **largest** request in the profile — the limit applies per request, so one is enough to fail — and stops proposing what it knows will be rejected.

---

## 9. Storage adapters

For more than one instance, sessions and the router's memory need to live outside the process. Adapters ship for SQL (Postgres syntax) and Redis, and **neither imports a driver**: you pass a client you already have.

```ts
import { SqlSessionStore, SqlRouterMemory, ensureSchema } from 'orchestati';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await ensureSchema(pool);                             // idempotent DDL

const memory = await new SqlRouterMemory(pool).load(); // warms the cache
const o = new Orchestrator({
  sessions: new SqlSessionStore(pool),
  router: new Router(registry, { memory }),
});
```

```ts
import { RedisSessionStore, RedisRouterMemory } from 'orchestati';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
```

Both accept node-redis (`rPush`) and ioredis (`rpush`) shapes.

**Two things shape how you deploy this.**

`prior()` is synchronous by contract — it runs once per agent on every request, in the hot path — so it cannot go to the network. Both adapters keep a local cache warmed by `load()` and persist in the background. Call `load()` at startup, before serving traffic; `flush()` on shutdown.

The EWMA is computed **inside the database**, not in your process: read-modify-write from two instances silently loses one update. SQL folds it into the `ON CONFLICT … DO UPDATE`; Redis runs a Lua script. Both are covered by integration tests against real servers, including concurrent writers.

A write failure goes to `onError` and is never thrown — the local cache keeps serving, so an outage degrades routing quality instead of taking requests down. Pass your own handler; the default warns once and then stays quiet.

---

## 10. Troubleshooting

**A request routes somewhere unexpected.**
```bash
pnpm dev --explain "the request"
```
Prints the detected intent with its evidence, the complexity breakdown, the confidence, and the full agent ranking with every scoring term. If `intentSource` is `semantic` and confidence is low, the lexicon did not recognize it and the classifier guessed.

**A tool did not run.** `pnpm dev --trace` shows `tool:denied` with the reason. The default policy allows reads only; `--yes` authorizes, `--dry-run` refuses everything so you can see intent without effects.

**A model rejects `temperature`.** Reasoning models only accept 1. Presets mark them and the parameter is dropped automatically; if you added a provider, set `omitTemperature`.

**"model not found".** `pnpm models <provider>` asks the provider what it actually serves — catalogues change and hardcoded lists rot.

**A rate limit that retrying does not fix.** Some limits are per request, not per minute: a request whose expected output exceeds the cap is rejected outright. The retry layer honors `x-should-retry: false` and recognizes "request too large", so it fails fast instead of burning quota.

**Answers stopped improving.** Without `recordFeedback()`, the router only learns from failures — escalations, tool errors, empty answers — which says nothing about quality. Wire your thumbs up/down.

**Integration tests skipped.** They need real servers:
```bash
docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=orchestati postgres:16-alpine
docker run -d --rm -p 56379:6379 redis:7-alpine
```

---

## 11. Known limits

Stated plainly, because most of them were found by measuring rather than by reasoning.

**Routing is right about 94% of the time** on its labeled set, and its errors lean cheap by design — over-routing is enforced at zero by a test, since wasting money is the failure mode the system exists to avoid.

**Intent classification is right about 82%** on held-out phrases. The remaining 18% is why confidence propagates everywhere.

**The cost sweep predicts direction, not magnitude.** Even with calibration it extrapolates from a profile; re-profile with what you adopt for the real number.

**Quality is measured by an LLM judge** on a small set, with alternating positions to control for order bias. The judge runs on the same tier as the baseline and may mildly favor it. Read the direction before the number.

**Prices for providers other than OpenAI are approximate**, flagged as estimated in the sweep, and worth checking against the provider's own page before making a spending decision.

**Orchestati is not unconditionally cheaper.** Its default single-provider configuration measured 29% *more* expensive than sending everything to the big model, because `chain` and `parallel` run several agents. It pays when the cheap tiers are genuinely cheap and enough traffic lands on them. `pnpm eval:quality` exists so you can check that for your own traffic instead of trusting this sentence.
