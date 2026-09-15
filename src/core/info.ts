import type { Agent, Capability, Intent, Tier } from './types.js';

/**
 * Lo que el sistema sabe de si mismo.
 *
 * Existe en un solo lugar porque se muestra en cuatro: la CLI (`pnpm info`),
 * el endpoint `/info`, la cabecera del chat y la respuesta del agente que
 * contesta "¿que podes hacer?". Si cada uno lo armara por su cuenta, los
 * cuatro se irian desincronizando del sistema real.
 */

export interface TierInfo {
  tier: Tier;
  /** Modelo que atiende ese escalon. `reflex` no usa ninguno. */
  model?: string;
  /** USD por millon de tokens, si se conoce. */
  price?: { in: number; out: number; known: boolean };
  agents: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  tier: Tier;
  role: string;
  capabilities: Capability[];
  intents: Intent[];
  cost: number;
  tools: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: 'safe' | 'confirm' | 'destructive';
}

export interface SystemInfo {
  backend: string;
  /** Politica de confirmacion activa. */
  confirm: string;
  /** Raiz del sandbox de archivos. */
  root: string;
  tiers: TierInfo[];
  agents: AgentInfo[];
  tools: ToolInfo[];
}

export function describeAgent(a: Agent, tools: string[] = []): AgentInfo {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    tier: a.tier,
    role: a.role ?? 'worker',
    capabilities: a.capabilities,
    intents: a.intents,
    cost: a.cost,
    tools,
  };
}

const usd = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);

/** Version legible, para mostrarle a una persona. */
export function formatSystemInfo(info: SystemInfo, opts: { markdown?: boolean } = {}): string {
  const b = opts.markdown ? (s: string) => `**${s}**` : (s: string) => s;
  const out: string[] = [];

  out.push(`${b('Backend')}: ${info.backend} · política de herramientas: ${info.confirm}`);
  out.push('');
  out.push(b('Escalones'));
  for (const t of info.tiers) {
    if (t.agents.length === 0 && !t.model) continue;
    const modelo = t.model ?? '— ningún modelo, respuesta inmediata';
    const precio = t.price
      ? ` · ${usd(t.price.in)}/${usd(t.price.out)} por millón de tokens${t.price.known ? '' : ' (estimado)'}`
      : '';
    out.push(`- ${b(t.tier)}: ${modelo}${precio}`);
    if (t.agents.length) out.push(`  agentes: ${t.agents.join(', ')}`);
  }

  out.push('');
  out.push(b('Agentes'));
  for (const a of info.agents) {
    const herr = a.tools.length ? ` · herramientas: ${a.tools.join(', ')}` : '';
    out.push(`- ${b(a.name)} (\`${a.id}\`, ${a.tier}) — ${a.description}${herr}`);
  }

  if (info.tools.length) {
    out.push('');
    out.push(b('Herramientas'));
    const porRiesgo = { safe: [] as string[], confirm: [] as string[], destructive: [] as string[] };
    for (const t of info.tools) porRiesgo[t.risk].push(t.name);
    if (porRiesgo.safe.length) out.push(`- sin confirmación: ${porRiesgo.safe.join(', ')}`);
    if (porRiesgo.confirm.length) out.push(`- requieren permiso: ${porRiesgo.confirm.join(', ')}`);
    if (porRiesgo.destructive.length) out.push(`- irreversibles: ${porRiesgo.destructive.join(', ')}`);
  }

  return out.join('\n');
}
