#!/usr/bin/env bash
# Verifica que el paquete sea consumible desde afuera.
#
# Que los tests pasen no prueba nada sobre esto: los tests importan de `src/`
# con rutas relativas, asi que un `exports` mal armado o un tipo sin exportar
# no se nota hasta que alguien intenta instalarlo.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$RAIZ"
pnpm build > /dev/null
TARBALL="$(npm pack --silent | tail -1)"
mv "$TARBALL" "$TMP/"

cd "$TMP"
echo '{"name":"verify","private":true,"type":"module","version":"1.0.0"}' > package.json
npm install "./$TARBALL" typescript ai --silent

cat > uso.ts <<'TS'
import { Orchestrator, MockModel, ToolRegistry, calculatorTool, askUser, Router, AgentRegistry, llmAgent, analyze } from 'orchestati';
import type { SessionStore, Message, RouterMemory, Intent, Tool, Signals, OrchestrationEvent, Tier, Agent, ConfirmationRequest, OrchestrationResult } from 'orchestati';

class S implements SessionStore {
  async history(): Promise<Message[]> { return []; }
  async append(): Promise<void> {}
  async clear(): Promise<void> {}
}
class M implements RouterMemory {
  prior(_i: Intent, _a: string): number { return 0.5; }
  record(_i: Intent, _a: string, _o: number, _w = 1): void {}
  snapshot(): Record<string, { score: number; n: number }> { return {}; }
}
const agente = llmAgent({
  id: 'llm.x', name: 'x', description: 'x', tier: 'standard',
  capabilities: ['knowledge'], intents: ['factual_qa'], cost: 0.4, system: 'x',
});
const registry = new AgentRegistry().register(agente);
const o = new Orchestrator({
  model: new MockModel(), registry,
  router: new Router(registry, { memory: new M(), maxTier: 'standard' }),
  tools: new ToolRegistry().register(calculatorTool),
  sessions: new S(), confirm: askUser(async () => true),
});
export async function usar(m: string): Promise<OrchestrationResult> {
  const s: Signals = analyze(m);
  const t: Tier = s.suggestedTier;
  const res = await o.run(m);
  o.recordFeedback(res.id, 1);
  for await (const e of o.stream(m)) { const ev: OrchestrationEvent = e; void ev; }
  declare_unused(t);
  return res;
}
function declare_unused(_x: unknown): void {}
declare const tool: Tool; declare const ag: Agent; declare const cr: ConfirmationRequest;
export { tool, ag, cr };
TS

npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict uso.ts

cat > uso.mjs <<'JS'
import { Orchestrator, MockModel, analyze, orchestatiModel } from 'orchestati';
import { createOrchestatiServer } from 'orchestati/server';
import { generateText } from 'ai';

const o = new Orchestrator({ model: new MockModel() });
if (analyze('hola').primaryIntent !== 'greeting') throw new Error('analyze roto');
if (o.inspect('hola').decision.tier !== 'reflex') throw new Error('inspect roto');
const res = await o.run('cuanto es (2340 * 15) / 100');
if (!res.id || !res.text) throw new Error('run roto');

let n = 0;
for await (const _ of o.stream('hola')) n++;
if (n < 3) throw new Error('stream roto');

// El adaptador tiene que funcionar como modelo del AI SDK.
const sdk = await generateText({ model: orchestatiModel(new Orchestrator({ model: new MockModel() })), prompt: 'hola' });
if (!sdk.text) throw new Error('adaptador roto');
if (sdk.providerMetadata?.orchestati?.tier !== 'reflex') throw new Error('metadata de ruteo rota');

// Importar el servidor no debe levantarlo.
const app = createOrchestatiServer({ model: new MockModel() });
const port = await app.listen(0);
const r = await fetch(`http://127.0.0.1:${port}/health`);
if (!r.ok) throw new Error('servidor roto');
await app.close();
JS

node uso.mjs
echo "✓ el paquete se instala, importa, tipa y corre desde afuera"
