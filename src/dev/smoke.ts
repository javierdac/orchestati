/**
 * Smoke test contra la API real.  `pnpm smoke`
 *
 * Recorre un pedido por tier y reporta modelo, costo y latencia reales. Es la
 * prueba de que las decisiones que se toman offline sobreviven al mundo.
 */
import { loadEnv } from '../core/env.js';
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { allowAll, autoSafe } from '../tools/confirm.js';
import { InMemorySessionStore } from '../runtime/session.js';

const CASOS = [
  { pedido: 'hola', espera: 'reflex, sin tocar ningun modelo' },
  { pedido: 'que es un closure en javascript, en dos oraciones', espera: 'light' },
  { pedido: 'cuanto es (2340 * 15) / 100', espera: 'standard + herramienta calculator' },
  {
    pedido: 'explicame que hace el archivo src/analysis/arbiter.ts y si ves algun problema',
    espera: 'standard + read_file sobre el repo real',
  },
  {
    pedido:
      'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    espera: 'swarm: tres agentes en paralelo + sintetizador',
  },
];

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

loadEnv();
const model = await createModelClient();
if (model.kind === 'mock') {
  console.error(
    C.red('\nNo hay credenciales: esto correria contra el MockModel y no probaria nada.\n') +
      '  Exportá una de estas y volvé a intentar:\n' +
      '    export AI_GATEWAY_API_KEY=...     (Vercel AI Gateway)\n',
  );
  process.exit(1);
}

// Solo lectura salvo que se pida lo contrario: este script gasta plata de verdad.
const permisivo = process.argv.includes('--yes');

const o = new Orchestrator({
  model,
  confirm: permisivo ? allowAll() : autoSafe(),
  sessions: new InMemorySessionStore(),
  root: process.cwd(),
  maxCostUsd: 0.5,
});

console.log(`\n${C.bold('Smoke test')} — backend ${model.kind}, politica ${permisivo ? 'allow-all' : 'auto-safe'}\n`);

let total = 0;
let fallos = 0;

for (const caso of CASOS) {
  console.log(C.bold(`› ${caso.pedido}`));
  console.log(C.dim(`  esperado: ${caso.espera}`));

  const t0 = Date.now();
  try {
    const res = await o.run(caso.pedido);
    total += res.usage.costUsd;

    const modelos = [...new Set(res.outputs.map((x) => String(x.meta?.model ?? '—')))];
    const herramientas = res.toolCalls.map(
      (t) => `${t.approved ? (t.result.ok ? '✓' : '✗') : '⊘'}${t.call.name}`,
    );

    console.log(
      `  ${C.green('ok')} ${res.decision.tier}/${res.decision.strategy} · ${res.decision.agents.join(' → ')}`,
    );
    console.log(C.dim(`     modelos: ${modelos.join(', ')}`));
    if (herramientas.length) console.log(C.dim(`     tools:   ${herramientas.join(' ')}`));
    console.log(
      C.dim(
        `     $${res.usage.costUsd.toFixed(5)} · ${res.usage.inputTokens}+${res.usage.outputTokens} tok · ${Date.now() - t0}ms`,
      ),
    );
    console.log(C.dim(`     ${res.text.replace(/\s+/g, ' ').slice(0, 220)}…`));
  } catch (err) {
    fallos++;
    console.log(`  ${C.red('fallo')} ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log();
}

console.log(
  `${C.bold('Total')} $${total.toFixed(5)} · ${CASOS.length - fallos}/${CASOS.length} ok\n`,
);
process.exitCode = fallos > 0 ? 1 : 0;
