/**
 * Evalua el clasificador de intenciones contra un set held-out.
 * Compara el lexico solo contra lexico + semantico.  `pnpm eval`
 */
import { analyze } from '../analysis/analyzer.js';
import { EVAL_SET, type EvalCase } from './eval-set.js';
import type { Intent } from '../core/types.js';

interface Outcome {
  case: EvalCase;
  got: Intent;
  ok: boolean;
  source: string;
}

function run(semantic: boolean): Outcome[] {
  return EVAL_SET.map((c) => {
    const s = analyze(c.text, semantic ? {} : { semantic: false });
    return { case: c, got: s.primaryIntent, ok: s.primaryIntent === c.expected, source: s.intentSource };
  });
}

function accuracy(outcomes: Outcome[]): number {
  return outcomes.filter((o) => o.ok).length / outcomes.length;
}

const soloLexico = run(false);
const conSemantico = run(true);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

console.log(`\n${bold('Evaluacion de intencion')} — ${EVAL_SET.length} casos held-out\n`);
console.log(`  solo lexico        ${bold(pct(accuracy(soloLexico)))}`);
console.log(`  lexico + semantico ${bold(pct(accuracy(conSemantico)))}\n`);

// Que cambio, caso por caso.
const arreglados: Outcome[] = [];
const rotos: Outcome[] = [];
const siguenMal: Outcome[] = [];

conSemantico.forEach((nuevo, i) => {
  const viejo = soloLexico[i]!;
  if (nuevo.ok && !viejo.ok) arreglados.push(nuevo);
  else if (!nuevo.ok && viejo.ok) rotos.push(nuevo);
  else if (!nuevo.ok) siguenMal.push(nuevo);
});

if (arreglados.length) {
  console.log(green(`  ✓ ${arreglados.length} que el lexico erraba y el semantico acerto`));
  for (const o of arreglados) {
    const antes = soloLexico.find((x) => x.case.text === o.case.text)!.got;
    console.log(dim(`      "${o.case.text}"  ${antes} → ${o.got}`));
  }
}

if (rotos.length) {
  console.log(red(`\n  ✗ ${rotos.length} que el semantico rompio`));
  for (const o of rotos) {
    console.log(dim(`      "${o.case.text}"  esperado ${o.case.expected}, dio ${o.got}`));
  }
}

if (siguenMal.length) {
  console.log(dim(`\n  · ${siguenMal.length} que ninguno acierta`));
  for (const o of siguenMal) {
    console.log(dim(`      "${o.case.text}"  esperado ${o.case.expected}, dio ${o.got} [${o.source}]`));
  }
}

// De donde salio cada decision.
const porFuente = new Map<string, number>();
for (const o of conSemantico) porFuente.set(o.source, (porFuente.get(o.source) ?? 0) + 1);
console.log(`\n  ${bold('decidido por')}`);
for (const [src, n] of [...porFuente].sort((a, b) => b[1] - a[1])) {
  const aciertos = conSemantico.filter((o) => o.source === src && o.ok).length;
  console.log(`    ${src.padEnd(10)} ${String(n).padStart(3)} casos   ${pct(aciertos / n)} correcto`);
}
console.log();
