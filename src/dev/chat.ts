/**
 * Chat interactivo de ejemplo.  `pnpm chat`
 *
 * Muestra lo que un chat normal esconde: por donde ruteo cada pedido, que
 * agente lo atendio, que herramientas uso, cuantos tokens costo y cuanto
 * lleva gastado la sesion.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { InMemorySessionStore } from '../runtime/session.js';
import { askUser, autoSafe } from '../tools/confirm.js';
import { PRESETS, isPresetName, modelForTierIn } from '../llm/openai-compatible.js';
import type { ConfirmationRequest } from '../tools/types.js';
import { EventQueue } from '../core/events.js';
import type { OrchestrationResult, Tier } from '../core/types.js';

// ---------------------------------------------------------------------------
// Presentacion
// ---------------------------------------------------------------------------

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  gris: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

const TINTE: Record<string, (s: string) => string> = {
  reflex: C.green,
  light: C.cyan,
  standard: C.yellow,
  deep: C.magenta,
  swarm: C.red,
};

const usd = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);

// ---------------------------------------------------------------------------
// Ejemplos: uno por camino, para poder verlos todos
// ---------------------------------------------------------------------------

const EJEMPLOS: Array<{ texto: string; espera: string }> = [
  { texto: 'hola', espera: 'reflex · sin LLM, $0' },
  { texto: 'gracias, sos un capo', espera: 'reflex · sin LLM, $0' },
  { texto: 'quien sos y que podes hacer', espera: 'reflex · describe el pool real' },
  { texto: 'que es un closure en javascript', espera: 'light · modelo chico' },
  { texto: 'cuanto es (2340 * 15) / 100', espera: 'standard · usa la herramienta calculator' },
  { texto: 'explicame que hace el archivo src/router/router.ts', espera: 'standard · lee el archivo de verdad' },
  { texto: 'escribime una funcion typescript que valide un email', espera: 'standard · agente programador' },
  { texto: 'mi app tira TypeError: cannot read property map of undefined en src/list.tsx', espera: 'deep · cadena depurador → revisor' },
  { texto: 'borra todos los registros de la tabla users en produccion', espera: 'standard · operador, pide confirmacion' },
  { texto: 'disename la arquitectura de un sistema de facturacion multi-tenant con auditoria', espera: 'deep · cadena planificador → investigador → revisor' },
  {
    texto: 'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    espera: 'swarm · tres agentes en paralelo + sintetizador',
  },
];

// ---------------------------------------------------------------------------
// Acumulador de la sesion
// ---------------------------------------------------------------------------

interface Linea {
  n: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

class Contador {
  mensajes = 0;
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  ms = 0;
  porTier = new Map<Tier, Linea>();
  porAgente = new Map<string, Linea>();
  herramientas = new Map<string, number>();

  private sumar(mapa: Map<string, Linea> | Map<Tier, Linea>, clave: string, res: OrchestrationResult): void {
    const m = mapa as Map<string, Linea>;
    const prev = m.get(clave) ?? { n: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    m.set(clave, {
      n: prev.n + 1,
      costUsd: prev.costUsd + res.usage.costUsd,
      inputTokens: prev.inputTokens + res.usage.inputTokens,
      outputTokens: prev.outputTokens + res.usage.outputTokens,
    });
  }

  registrar(res: OrchestrationResult): void {
    this.mensajes++;
    this.inputTokens += res.usage.inputTokens;
    this.outputTokens += res.usage.outputTokens;
    this.costUsd += res.usage.costUsd;
    this.ms += res.usage.ms;

    this.sumar(this.porTier, res.decision.tier, res);
    for (const o of res.outputs) {
      const prev = this.porAgente.get(o.agentId) ?? { n: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      this.porAgente.set(o.agentId, {
        n: prev.n + 1,
        costUsd: prev.costUsd + (o.usage?.costUsd ?? 0),
        inputTokens: prev.inputTokens + (o.usage?.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (o.usage?.outputTokens ?? 0),
      });
    }
    for (const t of res.toolCalls) {
      this.herramientas.set(t.call.name, (this.herramientas.get(t.call.name) ?? 0) + 1);
    }
  }

  reporte(): string {
    const filas: string[] = [];
    filas.push(C.bold('\n  Consumo de la sesion'));
    filas.push(
      `  ${this.mensajes} mensaje(s) · ${this.inputTokens} entrada + ${this.outputTokens} salida = ${C.bold(
        String(this.inputTokens + this.outputTokens),
      )} tokens · ${C.bold(usd(this.costUsd))}`,
    );

    if (this.porTier.size) {
      filas.push(C.dim('\n  por escalon'));
      const orden: Tier[] = ['reflex', 'light', 'standard', 'deep', 'swarm'];
      for (const tier of orden) {
        const l = this.porTier.get(tier);
        if (!l) continue;
        const tinte = TINTE[tier] ?? C.cyan;
        const parte = this.costUsd > 0 ? Math.round((l.costUsd / this.costUsd) * 100) : 0;
        filas.push(
          `    ${tinte(tier.padEnd(9))} ${String(l.n).padStart(2)} msg  ${String(
            l.inputTokens + l.outputTokens,
          ).padStart(6)} tok  ${usd(l.costUsd).padStart(9)}  ${C.dim(`${parte}%`)}`,
        );
      }
    }

    if (this.porAgente.size) {
      filas.push(C.dim('\n  por agente'));
      for (const [id, l] of [...this.porAgente].sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        filas.push(
          `    ${id.padEnd(18)} ${String(l.n).padStart(2)}×  ${String(
            l.inputTokens + l.outputTokens,
          ).padStart(6)} tok  ${usd(l.costUsd).padStart(9)}`,
        );
      }
    }

    if (this.herramientas.size) {
      filas.push(
        C.dim('\n  herramientas  ') +
          [...this.herramientas].map(([n, c]) => `${n}×${c}`).join('  '),
      );
    }

    // Lo que habria costado sin ruteo: todo al escalon mas caro que se uso.
    const ahorro = this.estimarAhorro();
    if (ahorro) filas.push(C.dim(`\n  ${ahorro}`));

    return filas.join('\n') + '\n';
  }

  /** Cuanto de lo gastado se evito mandando los pedidos faciles a escalones baratos. */
  private estimarAhorro(): string | undefined {
    const reflex = this.porTier.get('reflex');
    const light = this.porTier.get('light');
    const baratos = (reflex?.n ?? 0) + (light?.n ?? 0);
    if (baratos === 0) return undefined;
    return `${baratos} de ${this.mensajes} pedido(s) no necesitaron el escalon caro` +
      (reflex ? ` · ${reflex.n} se resolvieron sin llamar a ningun modelo` : '');
  }
}

// ---------------------------------------------------------------------------
// Programa
// ---------------------------------------------------------------------------

/**
 * Las lineas se encolan apenas llegan.
 *
 * Con la entrada por pipe, `rl.question` pierde todo lo que haya llegado antes
 * de que se lo llame: readline emite 'line' y, sin nadie escuchando, se
 * descarta. Encolando desde el arranque funciona igual con teclado que con
 * un archivo redirigido.
 */
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const lineas = new EventQueue<string>();
rl.on('line', (l: string) => lineas.push(l));
rl.on('close', () => lineas.close());
const entrada = lineas[Symbol.asyncIterator]();

async function pedir(prompt: string): Promise<string | undefined> {
  stdout.write(prompt);
  const r = await entrada.next();
  return r.done ? undefined : r.value;
}

async function confirmar(req: ConfirmationRequest): Promise<boolean> {
  const tinte = req.risk === 'destructive' ? C.red : C.yellow;
  console.log(`\n  ${tinte('⚠')} ${C.bold(req.agentId)} quiere ${C.bold(req.summary)} ${C.dim(`[${req.tool} · ${req.risk}]`)}`);
  if (req.risk === 'destructive') console.log(C.red('    puede no ser reversible'));
  const r = (await pedir(`    ${C.bold('¿ejecutar? (s/N) ')}`))?.trim().toLowerCase();
  return r === 's' || r === 'si' || r === 'y';
}

const model = await createModelClient();
const contador = new Contador();

const o = new Orchestrator({
  model,
  confirm: stdin.isTTY ? askUser(confirmar) : autoSafe(),
  sessions: new InMemorySessionStore(),
  root: process.cwd(),
});

// --- Cabecera ---------------------------------------------------------------

const preset = isPresetName(model.kind) ? PRESETS[model.kind] : undefined;
console.log(`\n${C.bold('Orchestati')} ${C.dim('· chat de ejemplo')}`);
console.log(C.dim('El ruteo es local y no gasta tokens. Lo que ves cobrado es solo lo que el agente elegido consumio.\n'));
console.log(`  backend   ${C.bold(preset?.label ?? model.kind)}`);
if (preset) {
  for (const tier of ['light', 'standard', 'deep', 'swarm'] as const) {
    const tinte = TINTE[tier] ?? C.cyan;
    console.log(`  ${tinte(tier.padEnd(9))} ${C.dim(modelForTierIn(preset, tier))}`);
  }
  console.log(`  ${C.green('reflex'.padEnd(9))} ${C.dim('— ningun modelo, respuesta inmediata')}`);
} else if (model.kind === 'mock') {
  console.log(C.yellow('  ⚠ sin credenciales: MockModel. El ruteo es real, las respuestas no.'));
}
console.log(C.dim('\n  /ejemplos  lista los caminos  ·  /1 .. /11  corre uno'));
console.log(C.dim('  /costo     consumo acumulado  ·  /traza  detalle  ·  /salir\n'));

let traza = false;
// Para no repetir el reporte si lo ultimo que se pidio fue /costo.
let yaMostrado = false;

function mostrarEjemplos(): void {
  console.log(C.bold('\n  Un ejemplo por camino\n'));
  EJEMPLOS.forEach((e, i) => {
    const tier = e.espera.split(' ')[0]!;
    const tinte = TINTE[tier] ?? C.cyan;
    console.log(`  ${C.bold(`/${i + 1}`.padStart(4))}  ${e.texto}`);
    console.log(`        ${tinte('→')} ${C.dim(e.espera)}`);
  });
  console.log();
}

async function enviar(texto: string): Promise<void> {
  let primario: string | undefined;
  let abierto = false;
  const t0 = Date.now();

  for await (const ev of o.stream(texto, { sessionId: 'chat' })) {
    switch (ev.type) {
      case 'analyze': {
        const s = ev.signals;
        console.log(
          C.gris(
            `  análisis  ${s.primaryIntent} · complejidad ${s.complexity.toFixed(2)} · confianza ${s.confidence.toFixed(2)} · ${s.intentSource}`,
          ),
        );
        break;
      }
      case 'route': {
        const d = ev.decision;
        const tinte = TINTE[d.tier] ?? C.cyan;
        console.log(
          `  ${tinte(`[${d.tier}]`)} ${C.dim(
            `${d.strategy} · ${d.agents.join(' → ')}${d.synthesizer ? ` → ${d.synthesizer}` : ''}`,
          )}`,
        );
        primario = d.strategy === 'direct' ? d.agents[0] : (d.synthesizer ?? d.agents.at(-1));
        break;
      }
      case 'tool': {
        const r = ev.record;
        const marca = r.approved ? (r.result.ok ? C.green('✓') : C.yellow('✗')) : C.red('⊘');
        console.log(C.dim(`  ${marca} ${r.call.name}${r.approved ? '' : ' (no autorizada)'}`));
        break;
      }
      case 'escalate':
        console.log(C.yellow(`  ↑ escalado ${ev.from} → ${ev.to}: ${ev.reason}`));
        break;
      case 'text':
        if (ev.agentId === primario) {
          if (!abierto) {
            stdout.write('\n');
            abierto = true;
          }
          stdout.write(ev.delta);
        }
        break;
      case 'done': {
        const r = ev.result;
        if (!abierto) console.log(`\n${r.text}`);
        contador.registrar(r);

        const u = r.usage;
        console.log(
          C.dim(
            `\n\n  este mensaje  ${u.inputTokens}+${u.outputTokens} tok · ${C.bold(usd(u.costUsd))} · ${Date.now() - t0}ms`,
          ),
        );
        console.log(
          C.dim(
            `  sesion        ${contador.inputTokens + contador.outputTokens} tok · ${C.bold(
              usd(contador.costUsd),
            )} en ${contador.mensajes} mensaje(s)\n`,
          ),
        );
        if (traza) {
          for (const t of r.trace) {
            console.log(C.gris(`    ${String(t.ms).padStart(6)}ms  ${t.type.padEnd(12)} ${t.label}`));
          }
          console.log();
        }
        break;
      }
      case 'error':
        console.log(C.red(`\n  error: ${ev.message}\n`));
        break;
      default:
        break;
    }
  }
}

for (;;) {
  // Entrada agotada (pipe cerrado, Ctrl-D): se cierra ordenado.
  const cruda = await pedir(C.bold('› '));
  if (cruda === undefined) break;
  const linea = cruda.trim();
  if (!linea) continue;
  if (linea === '/salir' || linea === '/exit') break;
  if (linea === '/ejemplos') {
    mostrarEjemplos();
    continue;
  }
  if (linea === '/costo') {
    console.log(contador.reporte());
    yaMostrado = true;
    continue;
  }
  if (linea === '/traza') {
    traza = !traza;
    console.log(C.dim(`  traza ${traza ? 'on' : 'off'}\n`));
    continue;
  }
  yaMostrado = false;
  const num = linea.match(/^\/(\d+)$/);
  if (num) {
    const e = EJEMPLOS[Number(num[1]) - 1];
    if (!e) {
      console.log(C.red(`  no hay ejemplo ${num[1]}\n`));
      continue;
    }
    console.log(C.dim(`  › ${e.texto}`));
    await enviar(e.texto);
    continue;
  }
  await enviar(linea);
}

if (!yaMostrado && contador.mensajes > 0) console.log(contador.reporte());
rl.close();
