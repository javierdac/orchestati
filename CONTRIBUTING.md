# Contributing to Orchestati

Thanks for taking a look. This document covers how to work on the project and the few conventions that are worth knowing before you open a pull request.

## Getting set up

```bash
pnpm install
pnpm test        # 131 tests, no credentials needed
pnpm chat        # interactive chat
```

**You do not need an API key to develop.** With no credentials the system runs on `MockModel`, where the routing is real and the answers are not. Every layer — the analyzer, the router, the tool loop, the escalation loop, the budget cutoff, streaming, sessions and the server — is fully exercised by the test suite without a single token being spent. Add a key only when you need to verify how a real model behaves.

If you do want to hit a real model, copy `.env.example` to `.env` and set one key. Gemini and Groq both have free tiers.

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
```

Both must pass. Beyond that, what you should run depends on what you touched.

### If you touched the analyzer, the lexicon or the router

Run the calibration bench:

```bash
pnpm table
```

It prints how a fixed set of requests is routed. It is the fastest way to see whether a change to the weights, the thresholds or the lexicon quietly broke routing somewhere you were not looking. A single row moving is often correct; several rows moving usually means the change was broader than intended. Mention in your PR which rows changed and why.

### If you touched the analyzer, the router or anything that affects routing

```bash
pnpm eval:routing
```

This measures the *product*, not a component. Two numbers matter beyond the headline accuracy: **over-routed** (requests sent to a more expensive tier than needed — wasted money) and **under-routed** (sent cheaper than needed — risked quality). A test enforces that over-routing stays at zero, because the bias has to sit on the side the system promises.

The routing set is labeled with an expected tier *and* a reason (`why`). If you disagree with a label, argue with the reason rather than changing the label to make your change pass.

### If you touched the semantic classifier or the prototypes

Run both evaluation sets:

```bash
pnpm eval      # set A, 62 held-out cases
pnpm eval b    # set B, 39 held-out cases (control)
```

There are accuracy floors enforced as tests, so a regression fails the build rather than going unnoticed.

**The one rule that matters here: never add an evaluation phrase to the prototypes.** Measuring repeatedly against the same held-out set wears it out — every adjustment made while looking at its errors turns it, bit by bit, into a training set. Set B exists as the control: it was written before the prototypes were last expanded and without looking at set A's failures.

If you expand prototype coverage, write *new* phrasings for the concepts that are weak, not the failing cases verbatim, and report both sets' numbers in your PR. A test asserts that no evaluation phrase appears verbatim among the prototypes, but it cannot catch a paraphrase — that part is on you.

## Adding things

The README covers the mechanics of [adding an agent](README.md#add-an-agent) and [adding a tool](README.md#add-a-tool). A few things it does not say:

**Agents should not need router changes.** If you find yourself adding a special case to `src/router/router.ts` to make your agent get picked, that is usually a sign the agent should be expressing itself through `accepts()`, its declared `capabilities`, or its `intents` instead. The router scoring exists so that agents compete on declared properties rather than on hardcoded rules.

**Be honest in `comfortMax`.** It is the complexity above which the agent would rather escalate than answer badly. Setting it to `1` to "win" more requests defeats the escalation loop.

**New providers are presets, not classes.** Anything with an OpenAI-compatible endpoint is a new entry in `PRESETS` in `src/llm/openai-compatible.ts` — a base URL, the env vars to read a key from, and a model per tier. Only reach for a new client class if the API shape is genuinely different.

## Tool safety

Tools are the part of the system that can do real damage, so they have rules.

**Declare the right risk level.** `safe` means it only reads and has no side effects — those run without asking anyone. `confirm` means it writes or reaches the network. `destructive` means it can do something irreversible. When in doubt, pick the higher level; the cost of an unnecessary prompt is much lower than the cost of a silent `rm`.

**Never bypass the gate.** The tool loop lives in `src/runtime/tool-loop.ts` precisely so that a confirmation can happen between the model asking for a tool and the tool running. Do not add an `execute` to a tool definition passed to the provider SDK — that hands the loop to the SDK and the gate stops existing.

**Anything touching the filesystem goes through `resolveInside()`.** It confines paths to the sandbox root and rejects `..`, absolute paths and null bytes. Anything running a binary goes through `parseCommand()`, which uses an allowlist and rejects shell metacharacters.

**A denial is not an error.** When a tool is not authorized, the model should be told that permission is missing and keep working without it — not receive a failure that looks like a bug.

New tools need tests for the containment, not just the happy path. `tests/tools.test.ts` has the existing ones to follow: path escapes, allowlist bypasses, SSRF, `eval`.

## Conventions

**Tests.** New behavior needs a test. Prefer tests that describe a property of the system (*"a guessed intent cannot trigger the reflex path"*) over tests that pin an implementation detail.

**Comments.** Code comments in this repository are in Spanish; documentation is in English. This is a historical artifact rather than a principle — match the file you are editing, and do not mass-translate as part of an unrelated change. Comments should explain *why*, since the *what* is usually already in the code.

**Commits.** A subject line that says what changed, and a body that says why, when the reason is not obvious. Reference the numbers when a change moves them (accuracy, test count, a routing row).

**Scope.** Small, focused pull requests get reviewed faster. If a change requires recalibrating thresholds, say so explicitly rather than folding it in silently — threshold changes affect every request that flows through the system.

### If you touched a storage adapter

The unit tests use in-memory doubles, which cover the logic but never execute the `ON CONFLICT` or the Lua script — a Postgres type-inference bug lived in exactly that gap. Run the real ones:

```bash
docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=orchestati postgres:16-alpine
docker run -d --rm -p 56379:6379 redis:7-alpine
pnpm test tests/adapters.integration.test.ts
```

They skip visibly when no server is listening, and CI runs them against service containers.

## Reporting bugs

A routing bug is much easier to fix with the analyzer's own output attached:

```bash
pnpm dev --explain "the request that routed badly"
```

That prints the detected intent with its evidence, the complexity breakdown, the confidence, and the full agent ranking with each scoring term. Include it, along with where you expected the request to go.

For a tool or execution bug, `pnpm dev --trace "..."` prints the step-by-step trace, and `--dry-run` shows what an agent *would* do without executing anything.

## Security

If you find a way to escape the sandbox, bypass the confirmation gate, or get a tool to execute something it should not, please report it privately rather than opening a public issue.
