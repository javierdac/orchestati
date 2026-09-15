# Orchestati

**A dynamic agent orchestrator in TypeScript. It analyzes every request locally — spending zero tokens — and only then decides which agent, or combination of agents, should handle it.**

Say `hi` and it answers in 5 ms for $0, never touching a model. Ask it to research, plan and estimate costs, and it fans out to three agents in parallel and synthesizes the result.

*[Versión en español](README.es.md)*

```console
$ pnpm dev --trace "hi"
[reflex] direct · reflex.smalltalk

Hey! What can I help you with?

    4ms analyze      intent=greeting complexity=0.01
    5ms route        direct -> reflex.smalltalk
    5ms done         1 agent, $0.00000
```

---

## The idea

Most agent systems send *everything* to the biggest model. Orchestati picks the path first, using a deterministic analyzer that runs in microseconds:

```
input ──► Analyzer ──► Router ──► Executor ──► response
          (local)      (local)     (agents)
          0 tokens     0 tokens
```

The routing decision costs nothing, so the system can afford to make it carefully — and the money is only spent where it actually buys something.

## Routing in practice

Real output from `pnpm table`, the repository's calibration bench. The lexicon is bilingual (English/Spanish); these are the English prompts, and the Spanish equivalents route identically.

| Request | Intent | Cpx | Tier | Strategy | Agents |
|---|---|---|---|---|---|
| `hi` | greeting | 0.01 | reflex | direct | `reflex.smalltalk` |
| `who are you and what can you do` | identity | 0.08 | reflex | direct | `reflex.identity` |
| `what is a closure in javascript` | factual_qa | 0.21 | light | direct | `llm.quick` |
| `summarize this paragraph in two lines` | summarize | 0.26 | standard | direct | `llm.writer` |
| `how much is 15% of 2340` | math | 0.32 | standard | direct | `llm.analyst` |
| `delete every row in the users table in production` | tool_action | 0.36 | standard | direct | `llm.tools` |
| `write a typescript function that validates an email` | code_generate | 0.38 | standard | direct | `llm.coder` |
| `refactor this payments module, it became a mess` | refactor | 0.44 | standard | direct | `llm.coder` |
| `my app throws TypeError: cannot read property map of undefined` | code_debug | 0.51 | deep | chain | `llm.debugger → llm.critic` |
| `design the full architecture of a multi-tenant billing system` | planning | 0.54 | deep | chain | `llm.planner → llm.researcher → llm.critic` |
| `research and compare vector DBs, then a migration plan and cost estimates` | research | 0.60 | swarm | parallel | `researcher ∥ planner ∥ analyst → synthesizer` |

---

## Quick start

```bash
pnpm install
pnpm chat        # interactive chat with live routing, tokens and cost
```

With no credentials the system runs on `MockModel`: **the routing is real, the answers are not.** That is enough to develop and test the entire orchestrator without spending anything.

To hit real models, copy `.env.example` to `.env` and set one key. Entry points load it automatically, so you never have to remember your shell's export syntax.

| Backend | Variable | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | defaults to the `gpt-4.1` family |
| **Gemini** | `GEMINI_API_KEY` | has a free tier; used through its OpenAI-compatible endpoint |
| **Groq** | `GROQ_API_KEY` | free tier, runs open-weight models |
| OpenRouter | `OPENROUTER_API_KEY` | |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | one key for every provider |
| Ollama / LM Studio | — | local; **must be requested** with `ORCHESTATI_PROVIDER=ollama` |

Everything except the gateway goes through a single OpenAI-compatible client, so adding a new destination means adding a preset, not a provider.

Local backends are **deliberately not auto-detected**: a server listening on a port is not the same as a server you meant to use.

---

## The chat example

`pnpm chat` shows what a normal chat hides — where each request was routed, which agent handled it, which tools ran, how many tokens it cost, and **how much the session has spent so far**.

```
  backend   OpenAI
  light     gpt-4.1-nano
  standard  gpt-4.1-mini
  deep      gpt-4.1
  reflex    — no model, immediate response

  /examples  list the paths   ·  /1 .. /11  run one
  /cost      running total    ·  /trace  detail  ·  /exit
```

Type `/examples` for one request per routing path, then `/cost` for the breakdown. A real session against `gpt-4.1`:

```
  Session usage
  3 messages · 759 in + 86 out = 845 tokens · $0.00036

  by tier
    reflex     1 msg       0 tok         $0   0%
    light      1 msg     183 tok   $0.00003   8%
    standard   1 msg     662 tok   $0.00033  92%

  by agent
    llm.analyst         1×     662 tok   $0.00033
    llm.quick           1×     183 tok   $0.00003
    reflex.smalltalk    1×       0 tok         $0

  tools  calculator×1

  2 of 3 requests did not need the expensive tier
  1 was answered without calling any model
```

That breakdown is the project's thesis measured in money: the greeting was free, the simple question cost three hundred-thousandths of a dollar, and 92% of the spend went to the single request that actually warranted it.

---

## How it works

### 1. Analyzer — `src/analysis/`

Deterministic, synchronous, no network. From every request it extracts:

- **intent** — 20 types, bilingual lexicon, with the evidence that triggered it;
- **artifacts** — code blocks, stack traces, URLs, file paths, JSON;
- **structure** — words, questions, list items, **chained requests**;
- **risk** (0–1) — irreversible verbs like *delete*, *deploy to prod*, *charge*;
- **complexity** (0–1), with a breakdown you can audit.

The complexity model treats a task's intrinsic difficulty as a **floor**, not as one term among many: *"design the architecture of X"* is a heavy request even when it is said in twelve words. Everything else amplifies from there.

```ts
import { analyze } from 'orchestati';

analyze('hi').complexity;                      // 0.01 → reflex
analyze('design the architecture…').complexity; // 0.54 → deep
```

A greeting glued to a real request does not hijack the routing: conversational intents scale their score by the fraction of the message they occupy, so `"hi, refactor this for me"` routes to `refactor`, not `greeting`.

### 2. Semantic classifier — `src/analysis/semantic/`

A regex lexicon has a structural weakness: **somebody has to maintain it**, and when it does not match there is no safety net. Measured on a held-out set of 62 phrases that appear nowhere in the codebase, the lexicon alone is right **35.5%** of the time — the rest falls through to `unknown`.

The net is a local classifier: character n-grams (3–5) hashed with TF-IDF weights, compared by cosine against 223 labeled prototype phrases. **No dependencies, no downloads, no tokens.** Character n-grams do the heavy lifting: *refactorizame*, *refactorizar* and *refactor* share nearly all their trigrams, so they land together without anyone writing the rule — and they absorb typos, which is exactly where a lexicon breaks.

```console
$ pnpm eval              $ pnpm eval b
set A · 62 cases         set B · 39 cases (control)

  lexicon only   35.5%     lexicon only   23.1%
  + semantic     82.3%     + semantic     79.5%
```

**Two thresholds, because they are two different decisions.** Measuring the score's calibration: at similarity ≥ 0.30 the classifier is right **100%** of the time, at ≥ 0.22 it is right 81%, and with no floor at all, 63%. So:

- **Filling in** an `unknown` (floor 0.15) — being right 63% of the time beats `unknown`, which carries *no* routing information at all.
- **Overruling** the lexicon (floor 0.30) — that requires the band where the classifier does not get it wrong.

The lexicon still wins when it is confident: it is exact, auditable and free. The semantic classifier is consulted **only when the lexicon hesitated**, so the fast path pays nothing — 27 µs versus 513 µs for the doubtful case.

Every prediction carries its nearest prototype as evidence (`≈ "let's draw up the quarterly roadmap" (0.41)`), so you can always audit why it said what it said.

**Two evaluation sets, and the second is the one that matters.** Measuring repeatedly against the same held-out set wears it out: every adjustment you make while looking at its errors turns it, bit by bit, into a training set. Set B was written *before* the prototypes were expanded and without looking at set A's failures. When coverage was expanded, A gained 8 points and **B, never inspected, gained 18** — so the improvement generalizes rather than overfitting. A test also asserts that no evaluation phrase appears verbatim among the prototypes.

#### Uncertainty propagates

This is what changed the design most. A classifier that is right 74% of the time **is wrong 26% of the time**, and the system has to know it. Confidence now travels all the way down:

- **A guessed intent's complexity regresses toward the mean.** If the classifier says *farewell* for a refactor request, believing its 0.00 complexity sends the request to the reflex agent.
- **The router stops ranking by intent when it is unsure.** The `intent` weight is scaled by confidence and the remainder is handed to capability coverage — which is also inferred from hard evidence (code blocks, stack traces, paths), not just phrasing. When in doubt, an agent with the right capabilities beats a specialist for an intent you may have guessed wrong.
- **A guessed intent cannot trigger the reflex path.** It is the only path with no recovery — it answers with a fixed string and it is done — so it requires confidence ≥ 0.6. A real greeting has it: `hi` scores 1.00.

Without this, `"separate the business logic from the view"` was classified as `farewell` and the system answered **"Bye! Ping me anytime."** Now it goes to an agent that can actually respond.

### 3. Router — `src/router/`

Scores **every** agent in the pool against the signals and picks. The score has five terms, all visible in `decision.ranking`:

| Term | Weight | What it measures |
|---|---|---|
| `capability` | 0.30 | coverage of the capabilities the request requires |
| `intent` | 0.26 | whether the agent declares that intent — **scaled by confidence** |
| `tierFit` | 0.24 | distance to the target power tier (penalizes undershooting **and** overshooting) |
| `prior` | 0.12 | how that agent has historically performed on that intent |
| `cost` | 0.08 | relative cost penalty |

Agents can also **veto themselves** through `accepts()`. That is how the reflex agent excludes itself the moment a real request shows up, instead of depending on an `if` inside the router.

Then it picks an execution shape:

- **`direct`** — one agent.
- **`chain`** — planner → worker → critic, where *each link is included only if it contributes* (planning a stack trace buys nothing; that is a diagnosis, not a plan).
- **`parallel`** — fan-out plus a synthesizer. `swarm` is not reached by a scalar threshold but by an explicit rule: the request has to be **heavy AND multi-part**. A single request, however hard, gains nothing from fanning out.

In a fan-out, every agent must contribute at least one capability *the request actually requires* that is not yet covered — without that condition the parallel branch fills up with irrelevant agents.

### 4. Agents — `src/agents/`

An agent declares what it can do, what it costs, and **how hard a request it is willing to take on** (`comfortMax`). When a request exceeds that, it returns `escalate` instead of delivering a poor answer, and the orchestrator re-routes it upward.

| Agent | Tier | Role | Purpose |
|---|---|---|---|
| `reflex.smalltalk` | reflex | responder | greetings, thanks, goodbyes — **no LLM** |
| `reflex.identity` | reflex | responder | "who are you?" — describes the real pool |
| `llm.quick` | light | responder | direct questions, short translations |
| `llm.writer` | standard | worker | prose, summaries, explanations |
| `llm.coder` | standard | worker | code — reads and writes files |
| `llm.analyst` | standard | worker | arithmetic and costs — uses `calculator` |
| `llm.tools` | standard | worker | actions with side effects — runs commands |
| `llm.debugger` | deep | worker | stack traces and root cause — reads the real code |
| `llm.researcher` | deep | worker | comparisons and trade-offs |
| `llm.planner` | deep | planner | breaks work into actionable steps |
| `llm.critic` | standard | critic | reviews the previous work |
| `llm.synthesizer` | standard | synthesizer | merges parallel outputs |

### 5. Tools — `src/tools/`

Agents actually execute. Every tool declares a **risk level**, and that level defines what it takes to run it:

| Tool | Risk | What it does |
|---|---|---|
| `read_file` · `list_dir` · `search_code` | `safe` | read the project — run without asking |
| `calculator` | `safe` | exact arithmetic, **without `eval`** |
| `write_file` · `http_fetch` | `confirm` | write to disk or reach the network |
| `run_command` | `destructive` | execute a project binary |

**Orchestati runs the tool loop, not the provider's SDK.** That is the design decision holding everything else up: between the model asking for a tool and that tool running, a confirmation gate has to happen. If the loop lives inside the SDK, that gate does not exist.

```
model asks ─► exists? ─► valid args? ─► authorized? ─► execute
                 │            │              │
                 └────────────┴──────────────┘
                 the model is told what happened and continues
```

A denial **is not an error**: the model is handed *"this needs the user's permission"* and keeps working without that tool.

**Confirmation policies** (`src/tools/confirm.ts`):

- `autoSafe()` — **the default**: reads without asking, writes nothing without permission.
- `askUser(fn)` — `safe` passes through, everything else goes to whoever decides.
- `denyAll()` — rejects everything, to see what an agent *would* do (`--dry-run`).
- `allowAll()` — no prompting, only for environments where authorization already happened elsewhere (`--yes`). Never the default.

```console
$ pnpm dev "run the project tests with pnpm test"
  ⊘ run_command (not authorized)
  Did not run "execute: pnpm test": the active policy only allows reads.

$ pnpm dev --yes "run the project tests with pnpm test"
  ✓ run_command
  RUN v2.1.9 — 131 tests passed
```

**Containment:** file tools cannot leave the project root (`..`, absolute paths and null bytes are rejected); `run_command` uses an **allowlist** — not a denylist — and rejects shell metacharacters that would let commands be chained; `http_fetch` blocks local network destinations, including the cloud metadata endpoint; and `calculator` parses the expression instead of evaluating it, so a "sum" cannot execute code.

### 6. Executor — `src/runtime/`

Runs the strategy with a budget (`maxCostUsd`, `maxMs`), an escalation loop, fault tolerance — if one agent in a parallel branch blows up, the run continues — and a **complete trace** of what was decided and why.

After every run the router receives feedback and updates its memory (an EWMA per intent↔agent pair, persisted to `.orchestati/memory.json`), so routing improves with use.

### 7. Streaming, sessions and server

**Streaming here is not just text token by token.** A UI needs to know *which agent* is working, which tool ran, and when the system decided to escalate — the trace is part of the product, not a log. So `stream()` emits typed events:

```ts
for await (const ev of orchestrator.stream('refactor this')) {
  if (ev.type === 'route')    showPipeline(ev.decision);
  if (ev.type === 'tool')     showTool(ev.record);
  if (ev.type === 'text')     write(ev.delta);   // ev.agentId says whose
  if (ev.type === 'escalate') notify(ev.from, ev.to);
  if (ev.type === 'done')     finish(ev.result);
}
```

In `parallel` three agents write at once, which is why every text event carries its `agentId` and the consumer decides which one to render.

**Sessions** — `InMemorySessionStore` or `FileSessionStore` (append-only JSONL, one file per session, so two processes cannot clobber each other).

```ts
await o.run('write me a CSV parser',  { sessionId: 'javier' });
await o.run('now port it to python',  { sessionId: 'javier' });  // has context
```

**HTTP server** — `node:http`, no framework:

```bash
pnpm serve      # http://127.0.0.1:3000
```

| Endpoint | Purpose |
|---|---|
| `POST /chat` | run and return the full result |
| `POST /chat/stream` | the same, as SSE, event by event |
| `POST /inspect` | analysis and routing decision, **without executing** |
| `GET /agents` | the pool with tiers, capabilities and costs |
| `GET` · `DELETE /session/:id` | a session's history |
| `GET /` | demo UI: pipeline, tools and trace, live |

Behind an HTTP boundary there is **nobody to ask** whether an `rm` is authorized. That is why the server's default policy is `autoSafe` — reads yes, writes no — and raising it is an explicit decision by whoever starts it.

---

## Extending it

### Add an agent

No need to touch the router — register it and it joins the competition.

```ts
import { llmAgent, createDefaultRegistry, Orchestrator } from 'orchestati';

const sql = llmAgent({
  id: 'llm.sql',
  name: 'SQL',
  description: 'Writes and optimizes SQL queries.',
  tier: 'standard',
  capabilities: ['code', 'analysis'],
  intents: ['code_generate', 'data_analysis'],
  cost: 0.4,
  comfortMax: 0.7,
  tools: ['read_file', 'search_code'],
  system: 'You are a SQL expert…',
  accepts: (s) => (/\b(select|join|query|sql)\b/.test(s.normalized) ? 0.5 : 0),
});

const registry = createDefaultRegistry().register(sql);
const o = new Orchestrator({ registry });
```

For an agent that does not use an LLM (an API, a database, a local computation), implement the `Agent` interface directly — `src/agents/reflex.ts` is the worked example.

### Add a tool

```ts
import { z } from 'zod';
import type { Tool } from 'orchestati';

export const jiraTicket: Tool<{ key: string }> = {
  name: 'jira_ticket',
  description: 'Fetches a Jira ticket by key.',
  risk: 'safe',                                   // safe | confirm | destructive
  schema: z.object({ key: z.string() }),
  summarize: (a) => `fetch ${a.key}`,             // shown in the confirmation prompt
  execute: async (a, ctx) => ({ ok: true, content: await fetchTicket(a.key) }),
};
```

### Control what it can touch

```ts
import { Orchestrator, askUser, denyAll } from 'orchestati';

new Orchestrator({ confirm: denyAll() });              // no tools at all
new Orchestrator({ root: '/path/to/project' });        // a different sandbox
new Orchestrator({ confirm: askUser(async (req) => {   // your own gate
  return await myUI.confirm(req.summary, req.risk);
}) });
```

---

## Configuration

| Variable | Purpose |
|---|---|
| `ORCHESTATI_PROVIDER` | force a backend: `openai`, `gemini`, `groq`, `openrouter`, `gateway`, `ollama`, `lmstudio`, `mock` |
| `ORCHESTATI_MODEL_LIGHT` … `_SWARM` | override the model for each tier |
| `ORCHESTATI_BASE_URL` | your own OpenAI-compatible endpoint |
| `PORT` | HTTP server port (default 3000) |

Per-tier prices come from a table in `src/llm/openai-compatible.ts`. It feeds the budget cutoff, so an inflated number is not harmless: it cuts runs that would actually have fit. A model with no known rate is assumed expensive — overestimating cuts early and gets noticed; underestimating overspends and shows up on the invoice.

---

## Scripts

| Command | Purpose |
|---|---|
| `pnpm chat` | interactive chat: routing, tokens and cost, live |
| `pnpm dev "<request>"` | one-shot run |
| `pnpm dev --explain "<request>"` | analysis and decision, without executing |
| `pnpm dev --trace "<request>"` | run and print the trace |
| `pnpm dev --dry-run "<request>"` | deny every tool: see what it *would* do |
| `pnpm dev --yes "<request>"` | authorize tools without prompting |
| `pnpm serve` | HTTP server, SSE and demo UI |
| `pnpm table` | routing calibration bench |
| `pnpm eval` · `pnpm eval b` | classifier accuracy on each held-out set |
| `pnpm smoke` | smoke test against the real API, one request per tier |
| `pnpm test` | 131 tests |

---

## Project layout

```
src/
  analysis/        analyzer, lexicon, arbiter
    semantic/      n-gram classifier, prototypes, vectorizer
  router/          registry, multi-factor ranking, EWMA memory
  agents/          the pool, LLM agent factory, reflex agents
  tools/           types, registry, confirmation policies, sandbox
    builtin/       fs, shell, calculator, http
  runtime/         orchestrator, tool loop, sessions, trace
  llm/             AI SDK base, gateway, OpenAI-compatible presets
  core/            types, events, .env loading
  ui/              demo page served at /
  dev/             chat, smoke, routing table, evaluation
```

---

## Testing and evaluation

131 tests cover the analyzer, the router's ranking, the escalation loop, the budget cutoff, fault tolerance, the tool loop, sandbox containment (path escapes, binary allowlist, SSRF, `eval`), the semantic classifier, sessions, streaming and the server's endpoints.

They include **accuracy floors on both held-out sets**, so a routing regression breaks the build instead of going unnoticed.

```bash
pnpm test
pnpm typecheck
```

---

## Status

What is not there yet: the ~20% of the evaluation sets the classifier still gets wrong, and tools executable from the server behind a real interactive gate (today the server deliberately stays read-only).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: you do not need an API key to develop — the mock backend exercises every layer — and if you touch the analyzer or the router, run `pnpm table` and mention which rows moved.

## License

[MIT](LICENSE) © Javier D'Accorso
