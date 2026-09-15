/**
 * Que modelos ofrece cada proveedor configurado.  `pnpm models`
 *
 * Existe para no tener que adivinar ids: se los pregunta al endpoint en vez de
 * copiarlos de una lista que envejece.
 */
import { loadEnv } from '../core/env.js';
import { OpenAICompatibleModel, PRESETS, type PresetName, type EndpointPreset } from '../llm/openai-compatible.js';

loadEnv();

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const filtro = process.argv[2]?.toLowerCase();

console.log(`\n${C.bold('Proveedores')}\n`);

for (const [nombre, preset] of Object.entries(PRESETS) as Array<[PresetName, EndpointPreset]>) {
  const key = preset.keyEnv.map((v) => process.env[v]).find(Boolean);
  const configurado = preset.local || Boolean(key);

  const estado = configurado ? C.green('configurado') : C.dim(`falta ${preset.keyEnv[0] ?? 'servidor local'}`);
  console.log(`  ${C.bold(nombre.padEnd(12))} ${estado}  ${C.dim(preset.label)}`);
  console.log(
    C.dim(`               por defecto  light=${preset.models.light}  standard=${preset.models.standard}  deep=${preset.models.deep}`),
  );

  if (configurado && (!filtro || filtro === nombre)) {
    const modelos = await new OpenAICompatibleModel(preset, nombre).listModels();
    if (modelos.length) {
      console.log(C.dim(`               ${modelos.length} modelo(s) disponibles:`));
      for (const chunk of agrupar(modelos.sort(), 3)) console.log(C.dim(`                 ${chunk.join('  ')}`));
    }
  }
  console.log();
}

console.log(C.dim('  Para mezclar proveedores por escalon, en .env:'));
console.log(C.dim('    ORCHESTATI_MODEL_LIGHT=groq:llama-3.1-8b-instant'));
console.log(C.dim('    ORCHESTATI_MODEL_STANDARD=groq:llama-3.3-70b-versatile'));
console.log(C.dim('    ORCHESTATI_MODEL_DEEP=openai:gpt-4.1\n'));

function agrupar<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
