/**
 * El ciclo completo de ajuste, de una.  `pnpm cycle`
 *
 *   barrido (gratis)  →  config recomendada  →  validacion de calidad (paga)
 *
 * Existe porque las tres partes se corren siempre juntas y encadenarlas a mano
 * invita a validar una configuracion distinta de la que el barrido propuso.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnv } from '../core/env.js';
import { createModelClient } from '../llm/model.js';
import type { LlmTier } from '../llm/ai-sdk-base.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function correr(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('pnpm', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!args.includes('--json')) process.stdout.write(d);
    });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} salio con ${code}`))));
  });
}

loadEnv();
const model = await createModelClient();
if (model.kind === 'mock') {
  console.error(C.red('\nNecesita un backend real: poné una key en .env.\n'));
  process.exit(1);
}

if (!existsSync('.orchestati/profile.json')) {
  console.error(
    C.red('\nNo hay perfil todavia.\n') + C.dim('  Corré primero:  pnpm tune --profile --from=sessions\n'),
  );
  process.exit(1);
}

console.log(`\n${C.bold('1/2  Barrido')} ${C.dim('(gratis)')}\n`);
const json = await correr(['-s', 'tune', '--json']);
const plan = JSON.parse(json) as {
  actual: { config: Record<string, string>; costo: number };
  propuestas: Array<{ etiqueta: string; config: Record<string, string>; costo: number }>;
  recomendada: Record<LlmTier, string>;
};

for (const p of plan.propuestas) {
  const delta = plan.actual.costo > 0 ? (1 - p.costo / plan.actual.costo) * 100 : 0;
  console.log(`  ${p.etiqueta.padEnd(28)} $${p.costo.toFixed(5)}  ${delta > 0.5 ? C.green(`${delta.toFixed(0)}% menos`) : C.dim('—')}`);
}

const env: NodeJS.ProcessEnv = {};
for (const [tier, spec] of Object.entries(plan.recomendada)) {
  env[`ORCHESTATI_MODEL_${tier.toUpperCase()}`] = spec;
}

console.log(`\n${C.bold('2/2  Validacion de calidad')} ${C.dim('(gasta plata)')}`);
console.log(C.dim(`  probando: ${Object.entries(plan.recomendada).map(([t, m]) => `${t}=${m}`).join('  ')}\n`));

await correr(['-s', 'eval:quality'], env);

console.log(C.dim('\n  Si la calidad se sostuvo, esa config va al .env. Si cayo, el barrido'));
console.log(C.dim('  cambio un solo escalon, asi que ya sabes cual mirar.\n'));
