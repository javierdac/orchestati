/**
 * Evalua la decision de ruteo contra un set etiquetado.  `pnpm eval:routing`
 *
 * Reporta dos tipos de error por separado porque cuestan cosas distintas:
 * rutear mas caro de lo necesario tira plata, rutear mas barato arriesga la
 * calidad de la respuesta.
 */
import { Orchestrator } from '../runtime/orchestrator.js';
import { MockModel } from '../llm/model.js';
import { ROUTING_SET, type RoutingCase } from './routing-set.js';
import { TIER_ORDER, tierIndex, type Tier } from '../core/types.js';

export interface RoutingOutcome {
  case: RoutingCase;
  tier: Tier;
  agents: string[];
  tierOk: boolean;
  agentOk: boolean | undefined;
  /** >0 se paso de caro, <0 se quedo corto. */
  drift: number;
}

export function evaluateRouting(cases: RoutingCase[] = ROUTING_SET): RoutingOutcome[] {
  const o = new Orchestrator({ model: new MockModel() });
  return cases.map((c) => {
    const { decision } = o.inspect(c.text);
    const principal = decision.agents[0]!;
    return {
      case: c,
      tier: decision.tier,
      agents: decision.agents,
      tierOk: decision.tier === c.tier,
      agentOk: c.agents ? c.agents.some((a) => decision.agents.includes(a)) : undefined,
      drift: tierIndex(decision.tier) - tierIndex(c.tier),
      ...(principal ? {} : {}),
    };
  });
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(1)}%`;

function main(): void {
  const out = evaluateRouting();
  const n = out.length;

  const tierOk = out.filter((o) => o.tierOk).length;
  const cerca = out.filter((o) => Math.abs(o.drift) <= 1).length;
  const conAgente = out.filter((o) => o.agentOk !== undefined);
  const agenteOk = conAgente.filter((o) => o.agentOk).length;
  const caro = out.filter((o) => o.drift > 0);
  const barato = out.filter((o) => o.drift < 0);

  console.log(`\n${C.bold('Evaluacion de ruteo')} — ${n} casos etiquetados\n`);
  console.log(`  escalon exacto      ${C.bold(pct(tierOk, n))}  ${C.dim(`(${tierOk}/${n})`)}`);
  console.log(`  escalon ±1          ${C.bold(pct(cerca, n))}  ${C.dim(`(${cerca}/${n})`)}`);
  console.log(
    `  agente esperado     ${C.bold(pct(agenteOk, conAgente.length))}  ${C.dim(`(${agenteOk}/${conAgente.length})`)}`,
  );
  console.log();
  console.log(`  ${C.yellow('se paso de caro')}     ${caro.length}  ${C.dim('tira plata')}`);
  console.log(`  ${C.red('se quedo corto')}      ${barato.length}  ${C.dim('arriesga la calidad')}`);

  // Distribucion: a donde fue a parar cada escalon esperado.
  console.log(`\n  ${C.bold('esperado → obtenido')}`);
  for (const esperado of TIER_ORDER) {
    const delTier = out.filter((o) => o.case.tier === esperado);
    if (delTier.length === 0) continue;
    const dist = new Map<Tier, number>();
    for (const o of delTier) dist.set(o.tier, (dist.get(o.tier) ?? 0) + 1);
    const detalle = [...dist]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => (t === esperado ? C.green(`${t}×${c}`) : C.red(`${t}×${c}`)))
      .join('  ');
    console.log(`    ${esperado.padEnd(9)} ${detalle}`);
  }

  const fallos = out.filter((o) => !o.tierOk || o.agentOk === false);
  if (fallos.length) {
    console.log(`\n  ${C.bold('casos que no dieron')}`);
    for (const f of fallos) {
      const marca = f.drift > 0 ? C.yellow('caro ') : f.drift < 0 ? C.red('corto') : C.dim('     ');
      console.log(`    ${marca} ${C.dim(`${f.case.tier}→${f.tier}`.padEnd(18))} ${f.case.text.slice(0, 62)}`);
      if (!f.tierOk) console.log(C.dim(`            esperado por: ${f.case.why}`));
      if (f.agentOk === false) {
        console.log(C.dim(`            agente: esperaba ${f.case.agents?.join('|')}, dio ${f.agents.join(' → ')}`));
      }
    }
  }
  console.log();
}

// Solo imprime cuando se lo ejecuta directo: el modulo tambien se importa
// desde los tests, y ahi no queremos la salida por consola.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
