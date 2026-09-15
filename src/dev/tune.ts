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
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { loadEnv } from '../core/env.js';
import { allowAll } from '../tools/confirm.js';
import { cargarPedidos } from './requests.js';
import {
  cargarCalibracion,
  guardarCalibracion,
  medirModelo,
  factorVerbosidad,
  CALIBRATION_PROMPTS,
  RUTA_CALIBRACION,
  type Calibracion,
} from './calibration.js';
import {
  PRESETS,
  priceOf,
  pricedModels,
  isPresetName,
  presetUsable,
  presetOf,
  parseTierSpec,
  limitsOf,
  type PresetName,
} from '../llm/openai-compatible.js';
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

  // Igual que en la evaluacion de calidad: sandbox descartable, no el repo.
  const sandbox = await mkdtemp(join(tmpdir(), 'orchestati-profile-'));
  const o = new Orchestrator({ model, confirm: allowAll(), root: sandbox, maxCostUsd: 0.5 });
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

interface CostoOpts {
  /** Medidas de verbosidad, para corregir los tokens del perfil. */
  cal?: Calibracion;
  /** Que modelo produjo los tokens del perfil, por escalon. */
  referencia?: Config;
}

/**
 * Costo de una configuracion sobre el perfil.
 *
 * Los tokens del perfil los produjo OTRO modelo. Si hay calibracion, se
 * corrigen por cuanto escribe el candidato comparado con el de referencia;
 * si no, se usan tal cual y el resultado sirve para ordenar, no para
 * presupuestar.
 */
function costoDe(
  perfil: Perfil,
  config: Config,
  base: PresetName,
  opts: CostoOpts = {},
): { total: number; inciertos: Set<string>; sinCalibrar: Set<string> } {
  let total = 0;
  const inciertos = new Set<string>();
  const sinCalibrar = new Set<string>();

  for (const p of perfil.pedidos) {
    for (const tier of TIERS) {
      const uso = p.porTier[tier];
      if (!uso) continue;
      const spec = config[tier];
      if (!spec) continue;
      const precio = priceOf(spec, base);
      if (!precio) continue;
      if (!precio.known) inciertos.add(spec);

      // Correccion por verbosidad: es el termino que hacia fallar la
      // prediccion cuando el candidato era un modelo de razonamiento.
      const ref = opts.referencia?.[tier];
      const factor = opts.cal && ref ? factorVerbosidad(opts.cal, spec, ref) : undefined;
      if (opts.cal && ref && spec !== ref && !factor) sinCalibrar.add(spec);

      const entrada = uso.inputTokens * (factor?.in ?? 1);
      const salida = uso.outputTokens * (factor?.out ?? 1);
      total += (entrada * precio.in + salida * precio.out) / 1_000_000;
    }
  }
  return { total, inciertos, sinCalibrar };
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
  const cal = await cargarCalibracion();

  const json = process.argv.includes('--json');
  const log = (...args: unknown[]): void => {
    // Con --json no se imprime nada mas: cualquier linea suelta rompe el
    // parseo de quien lo consume, que fue exactamente lo que paso.
    if (!json) console.log(...args);
  };

  log(`\n${C.bold('Barrido de configuraciones')}`);
  log(C.dim(`  perfil de ${perfil.origen} · ${perfil.pedidos.length} pedidos · ${perfil.creado.slice(0, 16)}\n`));

  // --- Donde se va la plata -------------------------------------------------
  const actual = configActual(base);

  /**
   * Todo el barrido pasa por aca para que la correccion por verbosidad se
   * aplique siempre con la misma referencia: los modelos que produjeron los
   * tokens del perfil.
   */
  const costo = (config: Config): ReturnType<typeof costoDe> =>
    costoDe(perfil, config, base, { cal, referencia: actual });

  const { total: costoActual } = costo(actual);

  log(C.bold('  Donde se va la plata'));
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
    log(
      `    ${tier.padEnd(9)} ${String(llamadas).padStart(3)} llamada(s)  ${String(tokens).padStart(7)} tok  ` +
        `$${total.toFixed(5)}  ${C.dim(`${parte.toFixed(0)}% del total`)}`,
    );
  }
  const reflex = perfil.pedidos.filter((p) => p.tier === 'reflex').length;
  if (reflex) log(C.dim(`    reflex    ${reflex} pedido(s) sin ninguna llamada`));

  const mayor = TIERS.map((t) => ({ tier: t, costo: costo({ [t]: actual[t] }).total }))
    .sort((a, b) => b.costo - a.costo)[0];
  if (mayor && costoActual > 0 && mayor.costo / costoActual > 0.5) {
    log(
      C.yellow(
        `\n    El ${((mayor.costo / costoActual) * 100).toFixed(0)}% se va en ${mayor.tier}: ` +
          `cambiar ese escalon solo rinde mas que optimizar todos los demas juntos.`,
      ),
    );
  }

  // --- Verbosidad medida ----------------------------------------------------
  const medidos = Object.entries(cal).filter(([, m]) => !m.error && m.samples > 0);
  if (medidos.length > 1) {
    const menor = medidos.reduce((a, b) => (a[1].outputTokens <= b[1].outputTokens ? a : b));
    const verborragicos = medidos.filter(([, m]) => m.outputTokens / menor[1].outputTokens >= 2);

    if (verborragicos.length) {
      log(`\n${C.bold('  Cuidado con el precio por token')}`);
      log(
        C.dim('    Estos escriben mucho mas que el resto, asi que su precio por token engaña:'),
      );
      for (const [spec, m] of verborragicos.sort((a, b) => b[1].outputTokens - a[1].outputTokens)) {
        const x = m.outputTokens / menor[1].outputTokens;
        log(C.yellow(`      ${spec.padEnd(34)} ${x.toFixed(1)}× mas verborragico que ${menor[0]}`));
      }
    }
  }

  // --- Que costaria cada modelo en cada escalon -----------------------------
  /**
   * Los modelos locales cuestan cero y por eso ganan siempre, pero exigen
   * levantar un servidor y juegan en otra liga de calidad. Se muestran como
   * opcion, pero no se los propone como configuracion completa salvo que se
   * los pida: una recomendacion de "todo gratis" no es una recomendacion.
   */
  const incluirLocales = process.argv.includes('--include-local');
  const todosLosProveedores = process.argv.includes('--all-providers');
  const candidatos = pricedModels();

  /**
   * Por defecto solo se proponen proveedores con credencial configurada.
   * Recomendar una configuracion que no se puede correr no es una
   * recomendacion: manda a buscar una key antes de poder probar nada.
   */
  const disponible = (spec: string): boolean => {
    const { preset } = parseTierSpec(spec);
    if (!preset) return false;
    if (presetOf(preset).local) return incluirLocales;
    return todosLosProveedores || presetUsable(preset);
  };

  const proponibles = candidatos.filter((c) => disponible(c.spec));

  /**
   * Candidatos para un escalon: los modelos que algun preset designa para ese
   * escalon, mas los del escalon inmediatamente inferior.
   *
   * Sin restriccion alguna, ordenar por precio pone un 8B en `deep` — justo el
   * escalon que existe para los pedidos que ese modelo no resuelve. Restringir
   * al escalon exacto es el otro extremo: con un solo proveedor no queda
   * ninguna alternativa y el barrido no propone nada. Bajar un escalon es el
   * downgrade que alguien probaria de verdad.
   */
  const ORDEN: LlmTier[] = ['light', 'standard', 'deep'];
  const aptosPara = (tier: LlmTier): typeof proponibles => {
    // `swarm` no entra en los demas escalones: los modelos que un preset le
    // asigna suelen ser de gama media, y colarlos en `deep` propone un 20B
    // para el escalon mas exigente.
    const permitidos = new Set<LlmTier>([tier]);
    if (tier === 'swarm') {
      permitidos.add('standard').add('deep');
    } else {
      const i = ORDEN.indexOf(tier);
      if (i > 0) permitidos.add(ORDEN[i - 1]!);
    }
    const aptos = proponibles.filter((c) => c.tiers.some((t) => permitidos.has(t)));
    return aptos.length > 0 ? aptos : proponibles;
  };

  /**
   * Si un escalon puede realmente atenderse con ese modelo.
   *
   * No es lo mismo "mas lento" que "no funciona": una peticion cuya salida
   * esperada supera el limite por minuto se rechaza entera, y reintentarla no
   * cambia nada. Una config asi no es barata, es inviable.
   */
  const viabilidadDe = (tier: LlmTier, spec: string): { ok: boolean; motivo?: string } => {
    const lim = limitsOf(spec, base);
    const pedidosDelTier = perfil.pedidos.filter((x) => x.porTier[tier]);
    if (!lim?.otpm || pedidosDelTier.length === 0) return { ok: true };

    const salidaMaxima = Math.max(...pedidosDelTier.map((x) => x.porTier[tier]!.outputTokens));
    if (salidaMaxima > lim.otpm) {
      return {
        ok: false,
        motivo:
          `el pedido mas grande genera ${salidaMaxima} tokens de salida y el limite es ` +
          `${lim.otpm.toLocaleString()}/min. Se rechaza entero, reintentar no ayuda.`,
      };
    }
    return { ok: true };
  };

  const configViable = (config: Config): boolean =>
    TIERS.every((t) => !config[t] || viabilidadDe(t, config[t]!).ok);

  const masBarato = (tier: LlmTier): string =>
    aptosPara(tier)
      .filter((c) => viabilidadDe(tier, c.spec).ok)
      .map((c) => ({
        spec: c.spec,
        costo: costo({ [tier]: c.spec }).total,
        // Con precios empatados —pasa cuando varios usan el fallback del
        // preset— gana el que ese preset designa para este escalon.
        exacto: c.tiers.includes(tier) ? 0 : 1,
      }))
      .sort((a, b) => a.costo - b.costo || a.exacto - b.exacto)[0]!.spec;


  log(`\n${C.bold('  Que costaria cada modelo, por escalon')}  ${C.dim('(solo modelos con precio conocido)')}`);

  for (const tier of TIERS) {
    if (!perfil.pedidos.some((p) => p.porTier[tier])) continue;
    const opciones = proponibles
      .filter((c) => aptosPara(tier).includes(c))
      .map((c) => ({ spec: c.spec, costo: costo({ [tier]: c.spec }).total }))
      .sort((a, b) => a.costo - b.costo);

    const actualCosto = costo({ [tier]: actual[tier] }).total;
    log(`\n    ${C.bold(tier)}  ${C.dim(`actual ${actual[tier]} → $${actualCosto.toFixed(5)}`)}`);
    for (const o of opciones.slice(0, 5)) {
      const delta = actualCosto > 0 ? (1 - o.costo / actualCosto) * 100 : 0;
      const marca =
        o.spec === actual[tier] ? C.yellow('← actual') : delta > 0 ? C.green(`${delta.toFixed(0)}% menos`) : C.dim(`${Math.abs(delta).toFixed(0)}% mas`);
      const est = candidatos.find((c) => c.spec === o.spec)?.estimated ? C.yellow(' ~est') : '';
      log(`      ${o.spec.padEnd(34)} $${o.costo.toFixed(5)}  ${marca}${est}`);
    }
  }

  // --- Configuraciones completas -------------------------------------------
  // El escalon que se lleva mas plata: cambiar ese solo suele dar casi todo el ahorro.
  const dominante = TIERS.map((t) => ({ tier: t, costo: costo({ [t]: actual[t] }).total }))
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

  log(`\n${C.bold('  Configuraciones completas')}`);
  for (const p of propuestas) {
    const { total, inciertos, sinCalibrar } = costo(p.config);
    const delta = costoActual > 0 ? (1 - total / costoActual) * 100 : 0;
    const etiqueta = p.etiqueta === 'actual' ? C.yellow('actual') : delta > 0 ? C.green(`${delta.toFixed(0)}% menos`) : C.dim('sin cambio');
    log(`\n    ${C.bold(p.etiqueta.padEnd(28))} $${total.toFixed(5)}  ${etiqueta}`);
    log(C.dim(`      ${nombre(p.config)}`));
    if (inciertos.size) log(C.yellow(`      ⚠ precio estimado para: ${[...inciertos].join(', ')}`));
    if (sinCalibrar.size) {
      log(
        C.yellow(
          `      ⚠ sin calibrar: ${[...sinCalibrar].join(', ')} — se asume que escribe lo mismo que el actual.` +
            ' `pnpm tune --calibrate` lo mide.',
        ),
      );
    }

    // Los limites de rate son parte del costo real: una opcion mas barata que
    // no aguanta tu concurrencia no es mas barata, es inviable.
    for (const tier of TIERS) {
      const spec = p.config[tier];
      if (!spec) continue;
      const lim = limitsOf(spec, base);
      if (!lim) continue;

      const pedidosDelTier = perfil.pedidos.filter((x) => x.porTier[tier]);
      if (pedidosDelTier.length === 0) continue;

      /**
       * El limite de salida se aplica por peticion, asi que lo que importa es
       * el pedido mas grande, no el promedio: si uno solo lo supera, ese se
       * rechaza entero.
       */
      const salidaMaxima = Math.max(...pedidosDelTier.map((x) => x.porTier[tier]!.outputTokens));
      const totalMedio =
        pedidosDelTier.reduce((a, x) => a + x.porTier[tier]!.inputTokens + x.porTier[tier]!.outputTokens, 0) /
        pedidosDelTier.length;

      /**
       * El limite de salida por minuto no hace la configuracion lenta: la hace
       * imposible. Una peticion cuya salida esperada lo supera se rechaza
       * entera, y reintentarla no cambia nada.
       */
      const v = viabilidadDe(tier, spec);
      if (!v.ok) {
        log(C.red(`      ✗ ${spec} NO SIRVE para ${tier}: ${v.motivo}`));
        continue;
      }
      // Ojo: esta salida se midio con los modelos del perfil. Un modelo de
      // razonamiento genera mucho mas —3x medido—, asi que un margen que
      // parece holgado puede no serlo.
      if (lim.otpm && salidaMaxima / lim.otpm > 0.33) {
        log(
          C.yellow(
            `      ⚠ ${spec}: limite de ${lim.otpm.toLocaleString()} tokens de salida/min y el pedido mas ` +
              `grande ya usa ${salidaMaxima}. Un modelo de razonamiento genera ~3x mas y no entraria.`,
          ),
        );
      }

      if (lim.tpm) {
        const porMinuto = Math.floor(lim.tpm / Math.max(1, totalMedio));
        log(
          C.yellow(
            `      ⚠ ${spec}: ${lim.tpm.toLocaleString()} tok/min ≈ ${porMinuto} pedido(s) de ${tier} por minuto`,
          ),
        );
      }
    }
  }

  const sinCredencial = [...new Set(candidatos.filter((c) => !c.local && !disponible(c.spec)).map((c) => parseTierSpec(c.spec).preset))];
  if (sinCredencial.length && !todosLosProveedores) {
    log(
      C.dim(`\n    Sin credencial, no se proponen: ${sinCredencial.join(', ')}.`) +
        C.dim(' Con --all-providers se incluyen igual.'),
    );
  }
  if (!incluirLocales) {
    log(C.dim('    Los modelos locales cuestan 0 y aparecen arriba; --include-local los propone.'));
  }

  /**
   * Se propone el cambio de mayor palanca, no el mas barato. Lo mas barato en
   * todo suele ser tambien lo mas riesgoso, y este barrido no mide calidad.
   */
  const viables = propuestas.filter((p) => configViable(p.config));
  const recomendada = viables.find((p) => p.etiqueta.startsWith('solo cambiar')) ?? viables[1] ?? viables[0];

  if (json) {
    console.log(
      JSON.stringify(
        {
          perfil: { origen: perfil.origen, pedidos: perfil.pedidos.length, backend: perfil.backend },
          actual: { config: actual, costo: costoActual },
          propuestas: propuestas.map((p) => ({
            etiqueta: p.etiqueta,
            config: p.config,
            costo: costo(p.config).total,
          })),
          recomendada: recomendada?.config,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (recomendada) {
    const { total } = costo(recomendada.config);
    console.log(`\n${C.bold('  Por donde empezar')}  ${C.dim(`${recomendada.etiqueta} · $${total.toFixed(5)}`)}`);
    console.log(C.dim('    Un solo cambio, asi que si la calidad cae sabes exactamente por que.'));
    for (const tier of TIERS) console.log(C.dim(`    ORCHESTATI_MODEL_${tier.toUpperCase()}=${recomendada.config[tier]}`));
  }

  console.log(
    C.yellow('\n  Lo que este barrido NO sabe, medido:\n') +
      C.dim(
        '\n  1. Asume que los tokens no cambian al cambiar de modelo. Es falso, y con\n' +
          '     modelos de razonamiento es gravemente falso: sobre el mismo prompt,\n' +
          '     gpt-oss-120b emitio 3072 tokens de salida contra 965 de gpt-4.1. Aun\n' +
          '     costando menos por token, salio mas caro. Dos validaciones reales:\n' +
          '     67% predicho dio 31%, y 72% predicho dio 13%. El ORDEN de las opciones\n' +
          '     se sostuvo en las dos; la magnitud, no.\n' +
          '\n     Despues de aplicar una configuracion, volve a perfilar con ella para\n' +
          '     tener el numero de verdad:\n' +
          '       ORCHESTATI_MODEL_DEEP=<el nuevo> pnpm tune --profile\n' +
          '\n  2. Solo mide plata. Un modelo mas barato puede responder peor y eso no\n' +
          '     aparece aca: validalo con `pnpm eval:quality` antes de dejarlo fijo.\n' +
          '\n  3. No mira los limites de rate. Una opcion mas barata que no aguanta tu\n' +
          '     concurrencia no es mas barata, es inviable.\n',
      ),
  );
}

// ---------------------------------------------------------------------------

/**
 * Mide cuanto escribe cada modelo candidato.
 *
 * Es el arreglo de la suposicion que hacia fallar la prediccion. Barato:
 * tres prompts por modelo, una sola vez, y el resultado se cachea.
 */
async function calibrar(): Promise<void> {
  const cal = await cargarCalibracion();
  const candidatos = pricedModels().filter((c) => {
    const { preset } = parseTierSpec(c.spec);
    return preset && !presetOf(preset).local && presetUsable(preset);
  });

  if (candidatos.length === 0) {
    console.error(C.red('\nNo hay proveedores con credencial para calibrar.\n'));
    process.exitCode = 1;
    return;
  }

  console.log(`\n${C.bold('Calibrando verbosidad')} — ${candidatos.length} modelo(s) × ${CALIBRATION_PROMPTS.length} prompts`);
  console.log(C.dim('  Mide cuanto escribe cada uno. Los tokens de entrada casi no cambian;\n  lo que cambia, y mucho, es cuanto responden.\n'));

  for (const c of candidatos) {
    process.stdout.write(C.dim(`  ${c.spec.padEnd(34)} `));
    const m = await medirModelo(c.spec);
    cal[c.spec] = m;
    if (m.error) console.log(C.red(`falló: ${m.error.slice(0, 60)}`));
    else console.log(C.dim(`${m.outputTokens} tokens de salida`));
  }

  await guardarCalibracion(cal);

  const medidos = Object.entries(cal).filter(([, m]) => !m.error && m.samples > 0);
  if (medidos.length > 1) {
    const menor = medidos.reduce((a, b) => (a[1].outputTokens <= b[1].outputTokens ? a : b));
    console.log(`\n${C.bold('  Verbosidad relativa')}  ${C.dim(`(contra ${menor[0]}, el mas escueto)`)}`);
    for (const [spec, m] of medidos.sort((a, b) => a[1].outputTokens - b[1].outputTokens)) {
      const x = m.outputTokens / menor[1].outputTokens;
      const marca = x >= 2 ? C.yellow(`${x.toFixed(1)}×`) : C.dim(`${x.toFixed(1)}×`);
      console.log(`    ${spec.padEnd(34)} ${String(m.outputTokens).padStart(5)} tok  ${marca}`);
    }
  }

  console.log(C.green(`\n  guardado en ${RUTA_CALIBRACION}`));
  console.log(C.dim('  El barrido ya corrige por esto. Volvé a calibrar si cambiás de modelos.\n'));
}

async function main(): Promise<void> {
  loadEnv();
  const spec = process.argv.find((a) => a.startsWith('--from='))?.split('=')[1];

  if (process.argv.includes('--calibrate')) {
    await calibrar();
    return;
  }

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
