#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Orchestrator } from './runtime/orchestrator.js';
import { FileRouterMemory } from './router/memory.js';
import { FileSessionStore } from './runtime/session.js';
import { createModelClient } from './llm/model.js';
import { allowAll, askUser, autoSafe, denyAll } from './tools/confirm.js';
import type { ConfirmationPolicy, ConfirmationRequest } from './tools/types.js';
import type { OrchestrationResult } from './core/types.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const RISK_COLOR: Record<string, (s: string) => string> = {
  safe: C.green,
  confirm: C.yellow,
  destructive: C.red,
};

const TIER_COLOR: Record<string, (s: string) => string> = {
  reflex: C.green,
  light: C.cyan,
  standard: C.yellow,
  deep: C.magenta,
  swarm: C.red,
};

let rlShared: ReturnType<typeof createInterface> | undefined;
function readline(): ReturnType<typeof createInterface> {
  rlShared ??= createInterface({ input: stdin, output: stdout });
  return rlShared;
}

/** Muestra que se va a ejecutar y espera un si explicito. */
async function promptConfirm(req: ConfirmationRequest): Promise<boolean> {
  const tint = RISK_COLOR[req.risk] ?? C.yellow;
  console.log(
    `\n${tint('⚠ confirmacion')} ${C.bold(req.agentId)} quiere ${C.bold(req.summary)}` +
      ` ${C.dim(`[${req.tool} · ${req.risk}]`)}`,
  );
  if (req.risk === 'destructive') {
    console.log(C.red('  esta accion puede no ser reversible'));
  }
  const ans = (await readline().question(`  ${C.bold('¿ejecutar? (s/N) ')}`)).trim().toLowerCase();
  return ans === 's' || ans === 'si' || ans === 'y' || ans === 'yes';
}

/** Elige la politica segun los flags y si hay una terminal del otro lado. */
function choosePolicy(flags: Set<string>): ConfirmationPolicy {
  if (flags.has('--dry-run')) return denyAll();
  if (flags.has('--yes')) return allowAll();
  if (stdin.isTTY) return askUser(promptConfirm);
  // Sin terminal no hay a quien preguntarle: solo lectura.
  return autoSafe();
}

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

/**
 * Ejecuta mostrando el progreso a medida que ocurre: primero la decision de
 * ruteo, despues las herramientas, y el texto token a token.
 */
async function runStreaming(
  orchestrator: Orchestrator,
  input: string,
  opts: { trace: boolean; sessionId?: string },
): Promise<OrchestrationResult | undefined> {
  let primario: string | undefined;
  let resultado: OrchestrationResult | undefined;
  let abrioTexto = false;

  for await (const ev of orchestrator.stream(input, {
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })) {
    switch (ev.type) {
      case 'route': {
        const d = ev.decision;
        const tint = TIER_COLOR[d.tier] ?? C.cyan;
        console.log(
          `\n${tint(`[${d.tier}]`)} ${C.dim(`${d.strategy} · ${d.agents.join(' → ')}${d.synthesizer ? ` → ${d.synthesizer}` : ''}`)}`,
        );
        // Solo se imprime el texto del agente que produce la respuesta final:
        // en paralelo hay tres escribiendo a la vez y se leeria como ruido.
        primario =
          d.strategy === 'direct' ? d.agents[0] : (d.synthesizer ?? d.agents.at(-1));
        break;
      }
      case 'tool': {
        const r = ev.record;
        const tint = RISK_COLOR[r.risk] ?? C.dim;
        const marca = r.approved ? (r.result.ok ? '✓' : '✗') : '⊘';
        console.log(C.dim(`  ${marca} ${tint(r.call.name)}${r.approved ? '' : ' (no autorizada)'}`));
        break;
      }
      case 'escalate':
        console.log(C.yellow(`  ↑ escalado ${ev.from} → ${ev.to}: ${ev.reason}`));
        break;
      case 'text':
        if (ev.agentId === primario) {
          if (!abrioTexto) {
            stdout.write('\n');
            abrioTexto = true;
          }
          stdout.write(ev.delta);
        }
        break;
      case 'done':
        resultado = ev.result;
        if (!abrioTexto) console.log(`\n${ev.result.text}`);
        console.log('\n');
        if (opts.trace) printTrace(ev.result);
        break;
      case 'error':
        console.error(C.red(`\nerror: ${ev.message}`));
        break;
      default:
        break;
    }
  }
  return resultado;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const input = args.join(' ').trim();

  const model = createModelClient();
  const confirm = choosePolicy(flags);
  const orchestrator = new Orchestrator({
    model,
    confirm,
    root: process.cwd(),
    sessions: new FileSessionStore(),
    routerOptions: { memory: new FileRouterMemory('.orchestati/memory.json') },
  });

  // Una sesion por terminal: los pedidos de una misma corrida se acumulan.
  const sessionId = flags.has('--no-session') ? undefined : `cli-${process.ppid}`;

  if (flags.has('--help')) {
    console.log(`
${C.bold('orchestati')} — orquestador dinamico de agentes

  pnpm dev "<pedido>"            responde usando el agente elegido
  pnpm dev --explain "<pedido>"  muestra el analisis y la decision, sin ejecutar
  pnpm dev                       modo interactivo

  ${C.bold('flags')}
    --explain   solo analisis + ruteo, sin ejecutar
    --trace     imprime la traza de ejecucion
    --json      salida en JSON
    --yes         autoriza las herramientas sin preguntar
    --dry-run     deniega toda herramienta: muestra que *haria* el agente
    --no-session  no guarda ni lee historial de conversacion

  ${C.bold('servidor')}
    pnpm serve                    HTTP + SSE en http://127.0.0.1:3000
`);
    return;
  }

  console.log(C.dim(`herramientas: politica ${confirm.name}`));
  if (model.kind === 'mock') {
    console.log(C.dim('⚠︎ sin AI_GATEWAY_API_KEY: usando MockModel (el ruteo es real, las respuestas no)'));
  }

  if (input && flags.has('--explain')) {
    printExplain(orchestrator, input);
    return;
  }

  if (input) {
    if (flags.has('--json')) {
      const res = await orchestrator.run(input, { ...(sessionId ? { sessionId } : {}) });
      console.log(JSON.stringify(res, null, 2));
    } else {
      await runStreaming(orchestrator, input, {
        trace: flags.has('--trace'),
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return;
  }

  // Modo interactivo
  const rl = readline();
  console.log(C.dim('modo interactivo · /explain <texto> · /trace · /nueva · /salir\n'));
  let showTrace = flags.has('--trace');
  let sesion = sessionId ?? 'cli';

  for (;;) {
    const line = (await rl.question(C.bold('› '))).trim();
    if (!line) continue;
    if (line === '/salir' || line === '/exit') break;
    if (line === '/trace') {
      showTrace = !showTrace;
      console.log(C.dim(`traza ${showTrace ? 'on' : 'off'}`));
      continue;
    }
    if (line === '/nueva') {
      await orchestrator.sessions.clear(sesion);
      sesion = `cli-${Date.now()}`;
      console.log(C.dim('sesion nueva'));
      continue;
    }
    if (line.startsWith('/explain ')) {
      printExplain(orchestrator, line.slice(9));
      continue;
    }
    await runStreaming(orchestrator, line, { trace: showTrace, sessionId: sesion });
  }
  rl.close();
}

main().catch((err: unknown) => {
  console.error(C.red(`error: ${String(err)}`));
  process.exitCode = 1;
});
