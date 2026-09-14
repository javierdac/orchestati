/**
 * Banco de calibracion: imprime como se rutea un set fijo de pedidos.
 * Sirve para ver de un vistazo si un cambio en el analizador o en los pesos
 * rompio el ruteo.  `pnpm table`
 */
import { Orchestrator } from '../runtime/orchestrator.js';

export const CALIBRATION_CASES = [
  'hola',
  'gracias!',
  'quien sos y que podes hacer',
  'que es un closure en javascript',
  "traduci 'buenas noches' al ingles",
  'resumime este parrafo en dos lineas',
  'escribime una funcion typescript que valide un email',
  'cuanto es el 15% de 2340',
  'mi app tira TypeError: cannot read property map of undefined en src/list.tsx y no entiendo por que',
  'refactorizame este modulo de pagos que quedo hecho un desastre',
  'disename la arquitectura completa de un sistema de facturacion multi-tenant con auditoria',
  'borra todos los registros de la tabla users en produccion',
  'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
];

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

export function printRoutingTable(cases: string[] = CALIBRATION_CASES): void {
  const o = new Orchestrator();
  console.log(
    pad('PEDIDO', 52),
    pad('INTENT', 14),
    'CPX ',
    pad('TIER', 9),
    pad('ESTRATEGIA', 10),
    'AGENTES',
  );
  console.log('─'.repeat(140));
  for (const c of cases) {
    const { signals, decision } = o.inspect(c);
    console.log(
      pad(c, 52),
      pad(signals.primaryIntent, 14),
      signals.complexity.toFixed(2),
      pad(decision.tier, 9),
      pad(decision.strategy, 10),
      decision.agents.join(' → ') + (decision.synthesizer ? ` (+${decision.synthesizer})` : ''),
    );
  }
}

printRoutingTable();
