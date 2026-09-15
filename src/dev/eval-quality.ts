/**
 * ¿El escalon barato responde suficientemente bien?  `pnpm eval:quality`
 *
 * El proyecto mide el costo y mide el ruteo, pero hasta ahora nadie verificó
 * que rutear barato no degrade la respuesta. Sin esto, "ahorro" y
 * "degradacion" se ven exactamente igual desde afuera.
 *
 * Compara, para cada pedido, lo que produce el orquestador contra mandar todo
 * al escalon mas caro —el planteo que este proyecto dice superar— y los hace
 * juzgar a ciegas.
 *
 * Gasta plata de verdad: requiere un backend real y se corre a mano.
 */
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { loadEnv } from '../core/env.js';
import { allowAll } from '../tools/confirm.js';
import { QUALITY_SET, type QualityCase } from './quality-set.js';
import { OpenAICompatibleModel, PRESETS, isPresetName } from '../llm/openai-compatible.js';
import type { ModelClient, Tier } from '../core/types.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const BASELINE_SYSTEM =
  'Sos un asistente experto. Responde el pedido del usuario de la forma mas util posible, ' +
  'en el idioma en que te escriben. Se preciso y no agregues relleno.';

const JUDGE_SYSTEM =
  'Sos un evaluador imparcial. Te dan un pedido, un criterio de que haria aceptable la ' +
  'respuesta, y dos respuestas candidatas. Decidis cual sirve mejor al pedido segun el ' +
  'criterio.\n\n' +
  'Reglas: juzga solo por utilidad y correccion, nunca por longitud ni por tono. Una ' +
  'respuesta breve que resuelve el pedido le gana a una larga que lo rodea. Si las dos ' +
  'sirven igual de bien, es empate — el empate es un resultado valido y frecuente.\n\n' +
  'Responde SOLO con un JSON: {"winner":"A"|"B"|"tie","reason":"<una oracion>"}';

interface Comparacion {
  case: QualityCase;
  tier: Tier;
  agents: string[];
  costRouted: number;
  costBaseline: number;
  /** Desde el punto de vista del ruteado. */
  verdict: 'win' | 'tie' | 'loss' | 'error';
  reason: string;
}

/** Determinista: la misma corrida reparte las posiciones igual. */
function primeroEsRuteado(i: number): boolean {
  return i % 2 === 0;
}

async function judge(
  model: ModelClient,
  c: QualityCase,
  ruteada: string,
  baseline: string,
  ruteadaEsA: boolean,
): Promise<{ verdict: Comparacion['verdict']; reason: string; cost: number }> {
  const A = ruteadaEsA ? ruteada : baseline;
  const B = ruteadaEsA ? baseline : ruteada;

  const res = await model.generate({
    tier: 'deep',
    system: JUDGE_SYSTEM,
    temperature: 0,
    prompt: `## Pedido\n${c.text}\n\n## Criterio\n${c.criteria}\n\n## Respuesta A\n${A}\n\n## Respuesta B\n${B}`,
  });

  try {
    const json = JSON.parse(res.text.replace(/^```json\s*|\s*```$/g, '').trim()) as {
      winner: string;
      reason: string;
    };
    const gano = json.winner === 'tie' ? 'tie' : json.winner === (ruteadaEsA ? 'A' : 'B') ? 'win' : 'loss';
    return { verdict: gano, reason: json.reason ?? '', cost: res.usage.costUsd };
  } catch {
    return { verdict: 'error', reason: `el juez no devolvio JSON: ${res.text.slice(0, 80)}`, cost: res.usage.costUsd };
  }
}

async function main(): Promise<void> {
  loadEnv();
  const model = await createModelClient();

  if (model.kind === 'mock') {
    console.error(
      C.red('\nEsto necesita un backend real: contra el mock las dos respuestas serian el mismo placeholder.\n') +
        '  Poné una key en .env (OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY…) y volvé a intentar.\n',
    );
    process.exit(1);
  }

  const limite = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? QUALITY_SET.length);
  const casos = QUALITY_SET.slice(0, limite);

  const o = new Orchestrator({ model, confirm: allowAll(), root: process.cwd(), maxCostUsd: 0.5 });

  /**
   * La linea base tiene que quedar FIJA aunque se reconfiguren los escalones.
   *
   * La primera version la resolvia pidiendole al cliente el tier `deep`, asi
   * que al abaratar ese escalon se abarataba tambien el control: el
   * experimento comparaba dos cosas que se movian juntas y el resultado no
   * significaba nada.
   */
  const presetBase = isPresetName(model.kind) ? model.kind : 'openai';
  const modeloBase = process.env.ORCHESTATI_BASELINE_MODEL?.trim() || PRESETS[presetBase].models.deep;
  const baseline = await new OpenAICompatibleModel(PRESETS[presetBase], presetBase, {
    light: modeloBase, standard: modeloBase, deep: modeloBase, swarm: modeloBase,
  }).init();
  console.log(C.dim(`  linea base fija: ${presetBase}:${modeloBase}\n`));

  console.log(`\n${C.bold('Calidad: ruteado contra mandar todo al escalon caro')}`);
  console.log(C.dim(`${casos.length} casos · backend ${model.kind} · juez a ciegas con posiciones alternadas\n`));

  const out: Comparacion[] = [];
  let costoJuez = 0;

  for (const [i, c] of casos.entries()) {
    process.stdout.write(C.dim(`  [${i + 1}/${casos.length}] ${c.text.slice(0, 52)}… `));

    const ruteado = await o.run(c.text);
    const base = await baseline.generate({ tier: 'deep', system: BASELINE_SYSTEM, prompt: c.text, temperature: 0.2 });

    const ruteadaEsA = primeroEsRuteado(i);
    const j = await judge(baseline, c, ruteado.text, base.text, ruteadaEsA);
    costoJuez += j.cost;

    out.push({
      case: c,
      tier: ruteado.decision.tier,
      agents: ruteado.decision.agents,
      costRouted: ruteado.usage.costUsd,
      costBaseline: base.usage.costUsd,
      verdict: j.verdict,
      reason: j.reason,
    });

    const marca =
      j.verdict === 'win' ? C.green('gana') : j.verdict === 'tie' ? C.dim('empata') : j.verdict === 'loss' ? C.red('pierde') : C.yellow('error');
    console.log(`${marca} ${C.dim(`(${ruteado.decision.tier})`)}`);
  }

  // --- Resumen -------------------------------------------------------------
  const n = out.length;
  const cuenta = (v: Comparacion['verdict']): number => out.filter((o) => o.verdict === v).length;
  const wins = cuenta('win');
  const ties = cuenta('tie');
  const losses = cuenta('loss');
  const errores = cuenta('error');

  const costRouted = out.reduce((a, o) => a + o.costRouted, 0);
  const costBaseline = out.reduce((a, o) => a + o.costBaseline, 0);
  const pct = (x: number): string => `${((x / n) * 100).toFixed(0)}%`;

  console.log(`\n${C.bold('  Calidad')}`);
  console.log(`    ${C.green('gana o empata')}  ${C.bold(pct(wins + ties))}  ${C.dim(`(${wins} gana, ${ties} empata)`)}`);
  console.log(`    ${C.red('pierde')}         ${pct(losses)}  ${C.dim(`(${losses})`)}`);
  if (errores) console.log(`    ${C.yellow('sin veredicto')}  ${errores}`);

  console.log(`\n${C.bold('  Costo')}`);
  console.log(`    ruteado     $${costRouted.toFixed(5)}`);
  console.log(`    todo caro   $${costBaseline.toFixed(5)}`);
  const ahorro = costBaseline > 0 ? (1 - costRouted / costBaseline) * 100 : 0;
  const etiqueta = ahorro >= 0 ? `ahorro ${ahorro.toFixed(0)}%` : `${Math.abs(ahorro).toFixed(0)}% MAS CARO`;
  console.log(`    ${ahorro >= 0 ? C.bold(etiqueta) : C.red(C.bold(etiqueta))}  ${C.dim(`· el juez costo aparte $${costoJuez.toFixed(5)}`)}`);

  // De donde sale la plata: por escalon, ruteado contra la linea base.
  console.log(`\n${C.bold('  Costo por escalon')}  ${C.dim('(ruteado vs. mandar ese mismo pedido al caro)')}`);
  const tiers = [...new Set(out.map((o) => o.tier))];
  const porTier = tiers.map((t) => {
    const del = out.filter((o) => o.tier === t);
    return {
      tier: t,
      n: del.length,
      routed: del.reduce((a, o) => a + o.costRouted, 0),
      base: del.reduce((a, o) => a + o.costBaseline, 0),
    };
  });
  for (const t of porTier) {
    const delta = t.base > 0 ? (1 - t.routed / t.base) * 100 : 0;
    const signo = delta >= 0 ? C.green(`${delta.toFixed(0)}% mas barato`) : C.red(`${Math.abs(delta).toFixed(0)}% mas caro`);
    console.log(
      `    ${t.tier.padEnd(9)} ${String(t.n).padStart(2)} caso(s)  $${t.routed.toFixed(5)} vs $${t.base.toFixed(5)}  ${signo}`,
    );
  }

  /**
   * El ahorro depende de la mezcla de trafico: los escalones baratos ahorran y
   * los caros gastan de mas. Este es el punto donde se empatan.
   */
  const baratos = porTier.filter((t) => t.routed < t.base);
  const caros = porTier.filter((t) => t.routed >= t.base);
  const ahorroPorBarato = baratos.reduce((a, t) => a + (t.base - t.routed), 0) / Math.max(1, baratos.reduce((a, t) => a + t.n, 0));
  const sobrecostoPorCaro = caros.reduce((a, t) => a + (t.routed - t.base), 0) / Math.max(1, caros.reduce((a, t) => a + t.n, 0));
  if (ahorroPorBarato > 0 && sobrecostoPorCaro > 0) {
    const fraccion = sobrecostoPorCaro / (sobrecostoPorCaro + ahorroPorBarato);
    console.log(
      `\n  ${C.bold('Punto de equilibrio')}  con esta configuracion hace falta que al menos ` +
        `${C.bold(`${(fraccion * 100).toFixed(0)}%`)} del trafico\n  caiga en los escalones baratos para que el ruteo salga a cuenta. ` +
        `En este set fue el ${((baratos.reduce((a, t) => a + t.n, 0) / n) * 100).toFixed(0)}%.`,
    );
  }

  if (losses > 0) {
    console.log(`\n${C.bold('  Donde pierde')}`);
    for (const o of out.filter((x) => x.verdict === 'loss')) {
      console.log(`    ${C.dim(`${o.tier}`.padEnd(9))} ${o.case.text.slice(0, 58)}`);
      console.log(C.dim(`              ${o.reason.slice(0, 100)}`));
    }
  }

  console.log(
    C.dim(
      '\n  El juez corre en el mismo escalon que la linea base, asi que puede favorecerla ' +
        '\n  levemente por familiaridad de estilo. Con muestras chicas, leer la direccion' +
        '\n  del resultado antes que el numero exacto.\n',
    ),
  );
}

main().catch((err: unknown) => {
  console.error(C.red(`error: ${String(err)}`));
  process.exitCode = 1;
});
