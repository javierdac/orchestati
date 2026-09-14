#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Orchestrator } from './runtime/orchestrator.js';
import { FileRouterMemory } from './router/memory.js';
import { createModelClient } from './llm/model.js';
import type { Message, OrchestrationResult } from './core/types.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const TIER_COLOR: Record<string, (s: string) => string> = {
  reflex: C.green,
  light: C.cyan,
  standard: C.yellow,
  deep: C.magenta,
  swarm: C.red,
};

function bar(v: number, width = 20): string {
  const n = Math.round(Math.min(1, Math.max(0, v)) * width);
  return '█'.repeat(n) + C.dim('░'.repeat(width - n));
}

function printExplain(o: Orchestrator, input: string): void {
  const { signals, decision } = o.inspect(input);
  const tint = TIER_COLOR[decision.tier] ?? C.cyan;

  console.log(`\n${C.bold('Pedido')}  ${input}`);
  console.log(`${C.bold('Idioma')}  ${signals.lang}`);
  console.log(`${C.bold('Intent')}  ${signals.intents
    .slice(0, 3)
    .map((i) => `${i.intent}(${i.score.toFixed(2)})`)
    .join('  ')}`);
  console.log(`${C.bold('Evidencia')} ${C.dim(signals.intents[0]!.evidence.join(', ') || '—')}`);
  console.log(`${C.bold('Complej.')} ${bar(signals.complexity)} ${signals.complexity.toFixed(2)}`);
  for (const [k, v] of Object.entries(signals.complexityBreakdown).sort((a, b) => b[1] - a[1])) {
    if (v > 0.001) console.log(`          ${C.dim(k.padEnd(10))} ${v.toFixed(3)}`);
  }
  console.log(`${C.bold('Riesgo')}   ${signals.risk.toFixed(2)}   ${C.bold('Confianza')} ${signals.confidence.toFixed(2)}`);
  console.log(`${C.bold('Capac.')}   ${signals.requiredCapabilities.join(', ')}`);
  console.log(`\n${C.bold('DECISION')} ${tint(decision.tier.toUpperCase())} · ${C.bold(decision.strategy)}`);
  console.log(`${C.dim(decision.reason)}`);
  console.log(`${C.bold('Agentes')}  ${decision.agents.join(' → ')}${decision.synthesizer ? C.dim(`  (sintetiza: ${decision.synthesizer})`) : ''}`);
  console.log(`\n${C.bold('Ranking')}`);
  for (const r of decision.ranking.slice(0, 6)) {
    const score = Number.isFinite(r.total) ? r.total.toFixed(3) : C.dim('vetado');
    const parts = Object.entries(r.parts)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(' ');
    console.log(`  ${r.agentId.padEnd(18)} ${String(score).padStart(7)}  ${C.dim(parts)}`);
  }
  console.log();
}

function printTrace(res: OrchestrationResult): void {
  console.log(C.dim('\n── traza ──────────────────────────────'));
  for (const e of res.trace) {
    const t = `${String(e.ms).padStart(5)}ms`;
    console.log(`${C.dim(t)} ${C.bold(e.type.padEnd(12))} ${e.label}`);
  }
  console.log(
    C.dim(
      `── $${res.usage.costUsd.toFixed(5)} · ${res.usage.inputTokens}+${res.usage.outputTokens} tok · ${res.escalations} escalada(s) ──`,
    ),
  );
}

function printResult(res: OrchestrationResult, opts: { trace: boolean }): void {
  const tint = TIER_COLOR[res.decision.tier] ?? C.cyan;
  console.log(
    `\n${tint(`[${res.decision.tier}]`)} ${C.dim(`${res.decision.strategy} · ${res.decision.agents.join(' → ')}`)}`,
  );
  console.log(`\n${res.text}\n`);
  if (opts.trace) printTrace(res);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const input = args.join(' ').trim();

  const model = createModelClient();
  const orchestrator = new Orchestrator({
    model,
    routerOptions: { memory: new FileRouterMemory('.orchestati/memory.json') },
  });

  if (flags.has('--help')) {
    console.log(`
${C.bold('orchestati')} — orquestador dinamico de agentes

  pnpm dev "<pedido>"            responde usando el agente elegido
  pnpm dev --explain "<pedido>"  muestra el analisis y la decision, sin ejecutar
  pnpm dev                       modo interactivo

  ${C.bold('flags')}
    --explain   solo analisis + ruteo
    --trace     imprime la traza de ejecucion
    --json      salida en JSON
`);
    return;
  }

  if (model.kind === 'mock') {
    console.log(C.dim('⚠︎ sin AI_GATEWAY_API_KEY: usando MockModel (el ruteo es real, las respuestas no)'));
  }

  if (input && flags.has('--explain')) {
    printExplain(orchestrator, input);
    return;
  }

  if (input) {
    const res = await orchestrator.run(input);
    if (flags.has('--json')) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      printResult(res, { trace: flags.has('--trace') });
    }
    return;
  }

  // Modo interactivo
  const rl = createInterface({ input: stdin, output: stdout });
  const history: Message[] = [];
  console.log(C.dim('modo interactivo · /explain <texto> · /trace · /salir\n'));
  let showTrace = flags.has('--trace');

  for (;;) {
    const line = (await rl.question(C.bold('› '))).trim();
    if (!line) continue;
    if (line === '/salir' || line === '/exit') break;
    if (line === '/trace') {
      showTrace = !showTrace;
      console.log(C.dim(`traza ${showTrace ? 'on' : 'off'}`));
      continue;
    }
    if (line.startsWith('/explain ')) {
      printExplain(orchestrator, line.slice(9));
      continue;
    }
    const res = await orchestrator.run(line, { history });
    printResult(res, { trace: showTrace });
    history.push({ role: 'user', content: line }, { role: 'assistant', content: res.text });
  }
  rl.close();
}

main().catch((err: unknown) => {
  console.error(C.red(`error: ${String(err)}`));
  process.exitCode = 1;
});
