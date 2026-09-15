/**
 * Ajusta la configuracion para bajar el costo.  `pnpm tune`
 *
 * Como funciona: el ruteo es determinista y los tokens que consume un pedido
 * casi no dependen de QUE modelo lo atienda —dependen del pedido, del prompt
 * del agente y de cuantas vueltas da—, pero el precio si. Entonces alcanza con
 * perfilar una vez contra la API real y despues barrer configuraciones con
 * pura aritmetica, sin gastar un centavo mas.
 *
 *   pnpm tune --profile              perfila (gasta) y guarda el perfil
 *   pnpm tune                        barre configuraciones (gratis)
 *   pnpm tune --from=sessions        usa los pedidos reales guardados
 *   pnpm tune --from=pedidos.txt     usa un archivo, un pedido por linea
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { loadEnv } from '../core/env.js';
import { allowAll } from '../tools/confirm.js';
import { cargarPedidos } from './requests.js';
import { PRESETS, priceOf, pricedModels, isPresetName, type PresetName } from '../llm/openai-compatible.js';
import type { LlmTier } from '../llm/ai-sdk-base.js';
import type { Tier } from '../core/types.js';

const RUTA_PERFIL = '.orchestati/profile.json';
const TIERS: LlmTier[] = ['light', 'standard', 'deep', 'swarm'];

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/** Tokens por escalon de un pedido. `reflex` no aparece: no llama a nadie. */
interface PerfilPedido {
  text: string;
  tier: Tier;
  strategy: string;
  agents: string[];
  porTier: Partial<Record<LlmTier, { inputTokens: number; outputTokens: number; calls: number }>>;
}

interface Perfil {
  creado: string;
  origen: string;
  backend: string;
  pedidos: PerfilPedido[];
}

// ---------------------------------------------------------------------------
// Perfilado (gasta plata, una vez)
// ---------------------------------------------------------------------------

async function perfilar(spec: string | undefined): Promise<Perfil> {
  const model = await createModelClient();
  if (model.kind === 'mock') {
    throw new Error('Perfilar necesita un backend real: los tokens del mock son inventados.');
  }

  const { origen, pedidos } = await cargarPedidos(spec);
  if (pedidos.length === 0) throw new Error(`No hay pedidos en ${origen}`);

  const o = new Orchestrator({ model, confirm: allowAll(), root: process.cwd(), maxCostUsd: 0.5 });
  const registry = o.registry;

  console.log(`\n${C.bold('Perfilando')} ${pedidos.length} pedido(s) de ${origen}`);
  console.log(C.dim('  Esto gasta plata una sola vez; despues el barrido es gratis.\n'));

  const out: PerfilPedido[] = [];
  for (const [i, text] of pedidos.entries()) {
    process.stdout.write(C.dim(`  [${i + 1}/${pedidos.length}] ${text.slice(0, 54)}… `));
    const res = await o.run(text);

    const porTier: PerfilPedido['porTier'] = {};
    for (const salida of res.outputs) {
      const agente = registry.has(salida.agentId) ? registry.get(salida.agentId) : undefined;
      const tier = agente?.tier;
      if (!tier || tier === 'reflex' || !salida.usage) continue;
      const acc = porTier[tier] ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
      acc.inputTokens += salida.usage.inputTokens;
      acc.outputTokens += salida.usage.outputTokens;
      acc.calls += 1;
      porTier[tier] = acc;
    }

    out.push({ text, tier: res.decision.tier, strategy: res.decision.strategy, agents: res.decision.agents, porTier });
    console.log(C.dim(`${res.decision.tier} · $${res.usage.costUsd.toFixed(5)}`));
  }

  return { creado: new Date().toISOString(), origen, backend: model.kind, pedidos: out };
}

// ---------------------------------------------------------------------------
// Barrido (gratis)
// ---------------------------------------------------------------------------

type Config = Partial<Record<LlmTier, string>>;

function costoDe(perfil: Perfil, config: Config, base: PresetName): { total: number; inciertos: Set<string> } {
  let total = 0;
  const inciertos = new Set<string>();

  for (const p of perfil.pedidos) {
    for (const tier of TIERS) {
      const uso = p.porTier[tier];
      if (!uso) continue;
      const spec = config[tier];
      if (!spec) continue;
      const precio = priceOf(spec, base);
      if (!precio) continue;
      if (!precio.known) inciertos.add(spec);
      total += (uso.inputTokens * precio.in + uso.outputTokens * precio.out) / 1_000_000;
    }
  }
  return { total, inciertos };
}

/** La configuracion que esta activa ahora mismo. */
function configActual(base: PresetName): Config {
  const preset = PRESETS[base];
  const out: Config = {};
  for (const tier of TIERS) {
    out[tier] = process.env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`]?.trim() || `${base}:${preset.models[tier]}`;
  }
  return out;
}

/** Abreviaturas sin colision: standard y swarm empiezan igual. */
const ABREV: Record<LlmTier, string> = { light: 'li', standard: 'st', deep: 'dp', swarm: 'sw' };

function nombre(config: Config): string {
  return TIERS.map((t) => `${ABREV[t]}=${config[t] ?? '?'}`).join('  ');
}

async function barrer(spec: string | undefined): Promise<void> {
  const raw = await readFile(RUTA_PERFIL, 'utf8').catch(() => '');
  if (!raw) {
    console.error(
      C.red('\nNo hay perfil todavia.\n') +
        C.dim('  Corré primero:  pnpm tune --profile' + (spec ? ` --from=${spec}` : '') + '\n'),
    );
    process.exitCode = 1;
    return;
  }
  const perfil = JSON.parse(raw) as Perfil;
  const base: PresetName = isPresetName(perfil.backend) ? perfil.backend : 'openai';

  console.log(`\n${C.bold('Barrido de configuraciones')}`);
  console.log(C.dim(`  perfil de ${perfil.origen} · ${perfil.pedidos.length} pedidos · ${perfil.creado.slice(0, 16)}\n`));

  // --- Donde se va la plata -------------------------------------------------
  const actual = configActual(base);
  const { total: costoActual } = costoDe(perfil, actual, base);

  console.log(C.bold('  Donde se va la plata'));
  for (const tier of TIERS) {
    const pedidos = perfil.pedidos.filter((p) => p.porTier[tier]);
    if (pedidos.length === 0) continue;
    const tokens = pedidos.reduce(
      (a, p) => a + (p.porTier[tier]!.inputTokens + p.porTier[tier]!.outputTokens),
      0,
    );
    const llamadas = pedidos.reduce((a, p) => a + p.porTier[tier]!.calls, 0);
    const { total } = costoDe(perfil, { [tier]: actual[tier] }, base);
    const parte = costoActual > 0 ? (total / costoActual) * 100 : 0;
    console.log(
      `    ${tier.padEnd(9)} ${String(llamadas).padStart(3)} llamada(s)  ${String(tokens).padStart(7)} tok  ` +
        `$${total.toFixed(5)}  ${C.dim(`${parte.toFixed(0)}% del total`)}`,
    );
  }
  const reflex = perfil.pedidos.filter((p) => p.tier === 'reflex').length;
  if (reflex) console.log(C.dim(`    reflex    ${reflex} pedido(s) sin ninguna llamada`));

  const mayor = TIERS.map((t) => ({ tier: t, costo: costoDe(perfil, { [t]: actual[t] }, base).total }))
    .sort((a, b) => b.costo - a.costo)[0];
  if (mayor && costoActual > 0 && mayor.costo / costoActual > 0.5) {
    console.log(
      C.yellow(
        `\n    El ${((mayor.costo / costoActual) * 100).toFixed(0)}% se va en ${mayor.tier}: ` +
          `cambiar ese escalon solo rinde mas que optimizar todos los demas juntos.`,
      ),
    );
  }

  // --- Que costaria cada modelo en cada escalon -----------------------------
  /**
   * Los modelos locales cuestan cero y por eso ganan siempre, pero exigen
   * levantar un servidor y juegan en otra liga de calidad. Se muestran como
   * opcion, pero no se los propone como configuracion completa salvo que se
   * los pida: una recomendacion de "todo gratis" no es una recomendacion.
   */
  const incluirLocales = process.argv.includes('--include-local');
  const candidatos = pricedModels();
  const proponibles = incluirLocales ? candidatos : candidatos.filter((c) => !c.local);

  console.log(`\n${C.bold('  Que costaria cada modelo, por escalon')}  ${C.dim('(solo modelos con precio conocido)')}`);

  for (const tier of TIERS) {
    if (!perfil.pedidos.some((p) => p.porTier[tier])) continue;
    const opciones = candidatos
      .map((c) => ({ spec: c.spec, costo: costoDe(perfil, { [tier]: c.spec }, base).total }))
      .sort((a, b) => a.costo - b.costo);

    const actualCosto = costoDe(perfil, { [tier]: actual[tier] }, base).total;
    console.log(`\n    ${C.bold(tier)}  ${C.dim(`actual ${actual[tier]} → $${actualCosto.toFixed(5)}`)}`);
    for (const o of opciones.slice(0, 5)) {
      const delta = actualCosto > 0 ? (1 - o.costo / actualCosto) * 100 : 0;
      const marca =
        o.spec === actual[tier] ? C.yellow('← actual') : delta > 0 ? C.green(`${delta.toFixed(0)}% menos`) : C.dim(`${Math.abs(delta).toFixed(0)}% mas`);
      console.log(`      ${o.spec.padEnd(34)} $${o.costo.toFixed(5)}  ${marca}`);
    }
  }

  // --- Configuraciones completas -------------------------------------------
  /**
   * El mas barato ENTRE los que algun preset designa para ese escalon. Sin la
   * restriccion, ordenar por precio pone un 8B en `deep` — justo el escalon
   * que existe para los pedidos que ese modelo no resuelve.
   */
  const masBarato = (tier: LlmTier): string => {
    const aptos = proponibles.filter((c) => c.tiers.includes(tier));
    const universo = aptos.length > 0 ? aptos : proponibles;
    return universo
      .map((c) => ({ spec: c.spec, costo: costoDe(perfil, { [tier]: c.spec }, base).total }))
      .sort((a, b) => a.costo - b.costo)[0]!.spec;
  };

  // El escalon que se lleva mas plata: cambiar ese solo suele dar casi todo el ahorro.
  const dominante = TIERS.map((t) => ({ tier: t, costo: costoDe(perfil, { [t]: actual[t] }, base).total }))
    .sort((a, b) => b.costo - a.costo)[0]!;

  const propuestas: Array<{ etiqueta: string; config: Config }> = [
    { etiqueta: 'actual', config: actual },
    {
      etiqueta: `solo cambiar ${dominante.tier}`,
      config: { ...actual, [dominante.tier]: masBarato(dominante.tier) },
    },
    {
      etiqueta: 'barato abajo, caro arriba',
      config: { light: masBarato('light'), standard: masBarato('standard'), deep: actual.deep!, swarm: masBarato('swarm') },
    },
    {
      etiqueta: 'lo mas barato en todo',
      config: Object.fromEntries(TIERS.map((t) => [t, masBarato(t)])) as Config,
    },
  ];

  console.log(`\n${C.bold('  Configuraciones completas')}`);
  for (const p of propuestas) {
    const { total, inciertos } = costoDe(perfil, p.config, base);
    const delta = costoActual > 0 ? (1 - total / costoActual) * 100 : 0;
    const etiqueta = p.etiqueta === 'actual' ? C.yellow('actual') : delta > 0 ? C.green(`${delta.toFixed(0)}% menos`) : C.dim('sin cambio');
    console.log(`\n    ${C.bold(p.etiqueta.padEnd(28))} $${total.toFixed(5)}  ${etiqueta}`);
    console.log(C.dim(`      ${nombre(p.config)}`));
    if (inciertos.size) console.log(C.yellow(`      ⚠ precio estimado para: ${[...inciertos].join(', ')}`));
  }

  if (!incluirLocales) {
    console.log(C.dim('\n    (los modelos locales cuestan 0 y aparecen arriba; --include-local los propone como configuracion)'));
  }

  /**
   * Se propone el cambio de mayor palanca, no el mas barato. Lo mas barato en
   * todo suele ser tambien lo mas riesgoso, y este barrido no mide calidad.
   */
  const recomendada = propuestas.find((p) => p.etiqueta.startsWith('solo cambiar')) ?? propuestas[1];
  if (recomendada) {
    const { total } = costoDe(perfil, recomendada.config, base);
    console.log(`\n${C.bold('  Por donde empezar')}  ${C.dim(`${recomendada.etiqueta} · $${total.toFixed(5)}`)}`);
    console.log(C.dim('    Un solo cambio, asi que si la calidad cae sabes exactamente por que.'));
    for (const tier of TIERS) console.log(C.dim(`    ORCHESTATI_MODEL_${tier.toUpperCase()}=${recomendada.config[tier]}`));
  }

  console.log(
    C.dim(
      '\n  Esto solo mide plata. Un modelo mas barato puede responder peor, y eso no\n' +
        '  aparece aca: validalo con `pnpm eval:quality` antes de dejarlo fijo.\n',
    ),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const spec = process.argv.find((a) => a.startsWith('--from='))?.split('=')[1];

  if (process.argv.includes('--profile')) {
    const perfil = await perfilar(spec);
    await mkdir(dirname(RUTA_PERFIL), { recursive: true });
    await writeFile(RUTA_PERFIL, JSON.stringify(perfil, null, 2));
    console.log(C.green(`\n  perfil guardado en ${RUTA_PERFIL}`));
    console.log(C.dim('  Ahora corré `pnpm tune` las veces que quieras, sin gastar.\n'));
    return;
  }

  await barrer(spec);
}

main().catch((err: unknown) => {
  console.error(C.red(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
});
