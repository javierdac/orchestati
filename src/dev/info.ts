/**
 * Que es este sistema, ahora mismo.  `pnpm info`
 *
 * Lo saca del estado real —el registry, el catalogo de herramientas, el
 * cliente de modelo—, no de una lista escrita a mano, asi que no puede quedar
 * desactualizado respecto de lo que el sistema hace.
 */
import { Orchestrator } from '../runtime/orchestrator.js';
import { createModelClient } from '../llm/model.js';
import { loadEnv } from '../core/env.js';
import { formatSystemInfo } from '../core/info.js';

loadEnv();
const o = new Orchestrator({ model: await createModelClient() });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(o.info(), null, 2));
} else {
  console.log(`\n${formatSystemInfo(o.info())}\n`);
  console.log('Para bajar el costo:  pnpm tune --profile --from=sessions  →  pnpm tune');
  console.log('Para validar calidad: pnpm eval:quality\n');
}
