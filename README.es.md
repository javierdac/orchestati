# Orchestati

*[English version](README.md)*

Orquestador dinámico de agentes en TypeScript. **Analiza el pedido localmente
—sin gastar un solo token— y recién ahí decide qué agente (o combinación de
agentes) lo atiende.**

Si le decís `hola`, responde en 5 ms y cuesta $0.
Si le pedís que investigue, planifique y estime costos, abre tres agentes en
paralelo y sintetiza.

```
$ pnpm dev --trace "hola"
[reflex] direct · reflex.smalltalk

¡Hola! ¿En qué te doy una mano?

    4ms analyze      intent=greeting complejidad=0.01
    5ms route        direct -> reflex.smalltalk
    5ms done         1 agente(s), $0.00000
```

## La idea

La mayoría de los sistemas de agentes mandan *todo* al modelo más grande. Acá el
camino se elige antes, con un analizador determinista que corre en microsegundos:

```
input ──► Analyzer ──► Router ──► Executor ──► respuesta
          (local)      (local)     (agentes)
          0 tokens     0 tokens
```

## Ruteo real

Salida de `pnpm table`, el banco de calibración del repo:

| Pedido | Intent | Cpx | Tier | Estrategia | Agentes |
|---|---|---|---|---|---|
| `hola` | greeting | 0.01 | reflex | direct | `reflex.smalltalk` |
| `quien sos y que podes hacer` | identity | 0.07 | reflex | direct | `reflex.identity` |
| `que es un closure en javascript` | factual_qa | 0.21 | light | direct | `llm.quick` |
| `cuanto es el 15% de 2340` | math | 0.29 | standard | direct | `llm.analyst` |
| `escribime una funcion que valide un email` | code_generate | 0.38 | standard | direct | `llm.coder` |
| `borra todos los registros de users en produccion` | tool_action | 0.36 | standard | direct | `llm.tools` |
| `TypeError: cannot read property map of undefined…` | code_debug | 0.51 | deep | chain | `llm.debugger → llm.critic` |
| `diseñame la arquitectura de un sistema multi-tenant` | planning | 0.54 | deep | chain | `llm.planner → llm.researcher → llm.critic` |
| `investiga y compara…, despues un plan y ademas costos` | research | 0.74 | swarm | parallel | `llm.researcher ∥ llm.planner ∥ llm.analyst → llm.synthesizer` |

## Las cuatro piezas

### 1. Analyzer — `src/analysis/`

Determinista, sincrónico, sin red. Extrae de cada pedido:

- **intención** (20 tipos, léxico bilingüe es/en) con la evidencia que la disparó;
- **artefactos**: bloques de código, stack traces, URLs, rutas de archivo, JSON;
- **estructura**: palabras, preguntas, ítems de lista, **pedidos encadenados**;
- **riesgo** (0–1): verbos irreversibles como `borrar`, `deploy a prod`, `cobrar`;
- **complejidad** (0–1), con su desglose para poder auditarla.

El modelo de complejidad trata la dificultad intrínseca de la tarea como un
**piso**, no como un sumando: *"diseñame la arquitectura de X"* es un pedido
pesado aunque se diga en doce palabras. El resto de los rasgos amplifican.

```ts
import { analyze } from 'orchestati';

analyze('hola').complexity;                    // 0.01 → reflex
analyze('diseñame la arquitectura…').complexity; // 0.54 → deep
```

Un saludo pegado a un pedido real no secuestra el ruteo: las intenciones
conversacionales escalan su score por la fracción del mensaje que ocupan, así que
`"hola, refactorizame esto"` rutea a `refactor`, no a `greeting`.

### 2. Clasificador semántico — `src/analysis/semantic/`

El léxico de regex tiene una debilidad estructural: **alguien tiene que
mantenerlo**, y cuando no matchea no hay red. Medido sobre un set held-out de 62
frases que no están en ningún lado del código, el léxico solo acierta el
**35.5%** — el resto cae en `unknown`.

La red es un clasificador local: n-gramas de caracteres (3–5) hasheados con pesos
TF-IDF, comparados por coseno contra 223 frases prototipo etiquetadas. **Sin
dependencias, sin descargas, sin tokens.** Los n-gramas de caracteres son los que
hacen el trabajo: "refactorizame", "refactorizar" y "refactor" comparten casi
todos sus trigramas, así que caen juntos sin que nadie escriba la regla — y de
paso absorben los errores de tipeo, que es justo donde el léxico se rompe.

```
$ pnpm eval            $ pnpm eval b
set A · 62 casos       set B · 39 casos (control)

  solo lexico   35.5%    solo lexico   23.1%
  + semantico   82.3%    + semantico   79.5%
```

**Dos sets, y el segundo es el que importa.** Medir muchas veces contra el mismo
set held-out lo va gastando: cada ajuste que uno hace mirando sus errores lo
convierte de a poco en un set de entrenamiento. El set B se escribió *antes* de
ampliar los prototipos y sin mirar los fallos del A. Cuando amplié la cobertura,
el A subió 8 puntos y **el B, que nunca miré, subió 18** — así que la ganancia
generaliza en vez de sobreajustar. Un test verifica además que ninguna frase de
evaluación aparezca textual entre los prototipos.

**Dos umbrales, porque son dos decisiones distintas.** Midiendo la calibración del
score: con similitud ≥ 0.30 el clasificador acierta el **100%** de las veces, con
≥ 0.22 el 81%, y sin piso el 63%. Entonces:

- **Rellenar** un `unknown` (piso 0.15) — un 63% de acierto le gana a un `unknown`,
  que no aporta *ninguna* información de ruteo.
- **Dar vuelta** una respuesta del léxico (piso 0.30) — para eso hace falta el
  tramo donde el semántico no se equivoca.

El léxico sigue mandando cuando está seguro: es exacto, auditable y gratis. El
semántico se consulta **solo si el léxico dudó**, así que la vía rápida no paga
nada — 27 µs contra 513 µs del caso dudoso.

Cada predicción viene con el prototipo más parecido como evidencia
(`≈ "armemos el roadmap del trimestre" (0.41)`), así que siempre se puede auditar
por qué dijo lo que dijo.

#### La incertidumbre se propaga

Esto fue lo que más cambió el diseño. Un clasificador que acierta 74% **falla 26%**,
y el sistema tiene que saberlo. La confianza ahora viaja hasta el final:

- **La complejidad de una intención adivinada regresa hacia la media.** Si el
  clasificador dice "farewell" para un pedido de refactor, creerle su 0.00 de
  complejidad manda el pedido al agente reflex.
- **El router deja de rankear por intención cuando no está seguro.** El peso de
  `intent` se recorta por la confianza y pasa a la cobertura de capacidades, que
  se infiere también de evidencia dura (bloques de código, stack traces, rutas) y
  no solo del fraseo. Ante la duda, un agente con las capacidades correctas le
  gana a un especialista de una intención que quizá adivinamos mal.
- **Una intención adivinada no puede activar el camino reflex.** Es el único
  camino sin recuperación posible —responde una frase fija y listo—, así que
  exige confianza ≥ 0.6. Un saludo de verdad la tiene: `hola` da 1.00.

Sin esto, `"separá la logica de negocio de la vista"` se clasificaba como
`farewell` y el sistema contestaba **"¡Chau! Cuando quieras seguimos."** Ahora va
a un agente que puede responder.

### 3. Router — `src/router/`

Puntúa **todos** los agentes del pool contra las señales y elige. El score se
compone de cinco términos, todos visibles en `decision.ranking`:

| Término | Peso | Qué mide |
|---|---|---|
| `capability` | 0.30 | cobertura de las capacidades que el pedido requiere |
| `intent` | 0.26 | si el agente declara esa intención — **escalado por la confianza** |
| `tierFit` | 0.24 | distancia al escalón de potencia objetivo (penaliza quedarse corto **y** pasarse) |
| `prior` | 0.12 | cómo le fue históricamente a ese agente con esa intención |
| `cost` | 0.08 | penalización por costo relativo |

Además cada agente puede **auto-vetarse** con `accepts()`. Así el agente reflex se
excluye solo en cuanto aparece un pedido real, en vez de depender de un `if` en
el router.

Luego elige la forma de ejecución:

- **`direct`** — un agente.
- **`chain`** — planner → worker → crítico, y *cada eslabón entra solo si aporta*
  (planificar un stack trace no sirve de nada: eso se diagnostica).
- **`parallel`** — fan-out + sintetizador. `swarm` no se alcanza por umbral
  escalar sino por regla explícita: el pedido tiene que ser **pesado Y múltiple**.
  Un solo pedido, por difícil que sea, no gana nada con fan-out.

En el fan-out cada agente tiene que aportar al menos una capacidad *requerida por
el pedido* que no esté cubierta — sin esa condición el paralelo se llena de
agentes irrelevantes.

### 4. Agentes — `src/agents/`

Un agente declara qué sabe hacer, cuánto cuesta y **hasta qué complejidad se
anima** (`comfortMax`). Si el pedido lo supera, devuelve `escalate` en vez de
entregar una respuesta pobre, y el orquestador lo vuelve a rutear más arriba.

| Agente | Tier | Rol | Para qué |
|---|---|---|---|
| `reflex.smalltalk` | reflex | responder | saludos, gracias, despedidas — **sin LLM** |
| `reflex.identity` | reflex | responder | "¿quién sos?" — describe el pool real |
| `llm.quick` | light | responder | preguntas directas, traducciones cortas |
| `llm.writer` | standard | worker | redacción, resúmenes, explicaciones |
| `llm.coder` | standard | worker | código — lee y escribe archivos |
| `llm.analyst` | standard | worker | cálculos y costos — usa `calculator` |
| `llm.tools` | standard | worker | acciones con efecto — ejecuta comandos |
| `llm.debugger` | deep | worker | stack traces y causa raíz — lee el código real |
| `llm.researcher` | deep | worker | comparaciones y trade-offs |
| `llm.planner` | deep | planner | descompone en pasos accionables |
| `llm.critic` | standard | critic | revisa el trabajo previo |
| `llm.synthesizer` | standard | synthesizer | fusiona salidas paralelas |

### 5. Herramientas — `src/tools/`

Los agentes ejecutan de verdad. Cada herramienta declara su **nivel de riesgo**, y
ese nivel define qué hace falta para correrla:

| Herramienta | Riesgo | Qué hace |
|---|---|---|
| `read_file` · `list_dir` · `search_code` | `safe` | leen el proyecto — se ejecutan sin preguntar |
| `calculator` | `safe` | aritmética exacta, **sin `eval`** |
| `write_file` · `http_fetch` | `confirm` | escriben o salen a la red |
| `run_command` | `destructive` | ejecuta un binario del proyecto |

**El loop de herramientas lo corre Orchestati, no el SDK del proveedor.** Esa es la
decisión de diseño que sostiene todo lo demás: entre que el modelo pide una
herramienta y esa herramienta se ejecuta tiene que pasar un gate de confirmación.
Si el loop vive adentro del SDK, ese gate no existe.

```
modelo pide  ─►  ¿existe?  ─►  ¿argumentos válidos?  ─►  ¿autorizado?  ─►  ejecuta
                     │                  │                      │
                     └──────────────────┴──────────────────────┘
                         al modelo se le explica qué pasó y sigue
```

Una denegación **no es un error**: al modelo se le devuelve *"hace falta el permiso
del usuario"* y sigue trabajando sin esa herramienta.

**Políticas de confirmación** (`src/tools/confirm.ts`):

- `autoSafe()` — **el default**: lee sin preguntar, no escribe nada sin permiso.
- `askUser(fn)` — lo `safe` pasa directo, el resto va a quien decida.
- `denyAll()` — rechaza todo: sirve para ver qué *haría* un agente (`--dry-run`).
- `allowAll()` — sin preguntar, sólo para entornos donde la autorización ya se dio
  afuera (`--yes`). Nunca es el default.

```console
$ pnpm dev "corre los tests del proyecto con pnpm test"
  ⊘ run_command (no autorizada)
  No se ejecutó "ejecutar: pnpm test": la política activa solo permite lectura.

$ pnpm dev --yes "corre los tests del proyecto con pnpm test"
  ✓ run_command
  RUN v2.1.9 — 59 tests passed
```

**Contención:** las herramientas de archivos no salen de la raíz del proyecto
(`..`, rutas absolutas y bytes nulos se rechazan); `run_command` usa una **lista de
permitidos** —no de prohibidos— y rechaza metacaracteres de shell que permitirían
encadenar comandos; `http_fetch` bloquea la red local, incluido el endpoint de
metadata de cloud; y `calculator` parsea la expresión en vez de evaluarla, así que
una "cuenta" no puede ejecutar código.

### 6. Executor — `src/runtime/`

Ejecuta la estrategia con presupuesto (`maxCostUsd`, `maxMs`), bucle de escalado,
tolerancia a fallos —si un agente del paralelo explota, la corrida sigue— y una
**traza completa** de qué se decidió y por qué.

Después de cada corrida el router recibe feedback y actualiza su memoria
(EWMA por par intención↔agente, persistida en `.orchestati/memory.json`), así que
el ruteo mejora con el uso.

### 7. El chat de ejemplo — `pnpm chat`

Un chat que muestra lo que un chat normal esconde: por dónde ruteó cada pedido,
qué agente lo atendió, qué herramientas usó, cuántos tokens costó y **cuánto
lleva gastado la sesión**.

`/ejemplos` lista un pedido por camino (podés correrlos con `/1` … `/11`) y
`/costo` imprime el acumulado. Una sesión real contra `gpt-4.1`:

```
  Consumo de la sesion
  3 mensaje(s) · 759 entrada + 86 salida = 845 tokens · $0.00036

  por escalon
    reflex     1 msg       0 tok         $0   0%
    light      1 msg     183 tok   $0.00003   8%
    standard   1 msg     662 tok   $0.00033  92%

  por agente
    llm.analyst         1×     662 tok   $0.00033
    llm.quick           1×     183 tok   $0.00003
    reflex.smalltalk    1×       0 tok         $0

  herramientas  calculator×1

  2 de 3 pedido(s) no necesitaron el escalon caro
  1 se resolvio sin llamar a ningun modelo
```

Ese desglose es la tesis del proyecto medida en plata: el saludo salió gratis, la
pregunta simple costó tres centésimas de milésimo, y el 92% del gasto se lo llevó
el único pedido que realmente lo necesitaba.

### 8. Streaming, sesiones y servidor

**El streaming acá no es sólo texto token a token.** Una UI necesita saber *qué
agente* está trabajando, qué herramienta corrió y cuándo el sistema decidió
escalar — la traza es parte del producto, no un log. Por eso `stream()` emite
eventos tipados:

```ts
for await (const ev of orchestrator.stream('refactorizame esto')) {
  if (ev.type === 'route')       mostrarPipeline(ev.decision);
  if (ev.type === 'tool')        mostrarHerramienta(ev.record);
  if (ev.type === 'text')        escribir(ev.delta);   // ev.agentId dice de quién
  if (ev.type === 'escalate')    avisar(ev.from, ev.to);
  if (ev.type === 'done')        cerrar(ev.result);
}
```

En `parallel` hay tres agentes escribiendo a la vez: por eso cada evento de texto
lleva su `agentId`, y el consumidor decide cuál renderizar (la CLI muestra sólo
el que produce la respuesta final).

**Sesiones** — `InMemorySessionStore` o `FileSessionStore` (JSONL append-only, un
archivo por sesión, así dos procesos no se pisan). El historial se recorta por
los últimos N turnos.

```ts
await o.run('escribime un parser de CSV', { sessionId: 'javier' });
await o.run('ahora pasalo a python',      { sessionId: 'javier' });  // tiene contexto
```

**Servidor HTTP** — `node:http`, sin framework:

```bash
pnpm serve      # http://127.0.0.1:3000
```

| Endpoint | Qué hace |
|---|---|
| `POST /chat` | ejecuta y devuelve el resultado completo |
| `POST /chat/stream` | lo mismo, como SSE evento por evento |
| `POST /inspect` | análisis + decisión de ruteo, **sin ejecutar** |
| `GET /agents` | el pool con tiers, capacidades y costos |
| `GET` · `DELETE /session/:id` | historial de una sesión |
| `GET /` | UI de demostración: pipeline, herramientas y traza en vivo |

Del otro lado de un HTTP **no hay a quién preguntarle** si autoriza un `rm`. Por
eso la política por defecto del servidor es `autoSafe` —lectura sí, escritura
no— y subirla es una decisión explícita de quien lo levanta.

## Uso

```bash
pnpm install

pnpm dev "hola"                       # ejecuta
pnpm dev --explain "<pedido>"         # muestra análisis + decisión, sin ejecutar
pnpm dev --trace "<pedido>"           # ejecuta e imprime la traza
pnpm dev --json "<pedido>"            # salida estructurada
pnpm dev --dry-run "<pedido>"         # deniega toda herramienta: qué *haría*
pnpm dev --yes "<pedido>"             # autoriza herramientas sin preguntar
pnpm dev --no-session "<pedido>"      # sin historial de conversación
pnpm dev                              # modo interactivo (pregunta cada acción)
pnpm serve                            # servidor HTTP + SSE + UI de demo
pnpm table                            # banco de calibración del ruteo
pnpm chat                             # chat de ejemplo: ruteo, tokens y costo en vivo
pnpm eval                             # accuracy del clasificador (set A)
pnpm eval b                           # ídem sobre el set de control
pnpm test
```

Sin credenciales el sistema usa `MockModel`: **el ruteo es real, las respuestas
no**. Sirve para desarrollar y testear el orquestador entero sin gastar un peso.

Para pegarle a modelos de verdad, copiá `.env.example` a `.env` y poné una key.
Los puntos de entrada lo cargan solos, así que no hace falta exportar nada ni
acordarse de la sintaxis de tu shell (`export` en bash, `set -x` en fish). Lo que
ya esté en el entorno gana: un `.env` no pisa una variable exportada a propósito.

| Backend | Variable | Nota |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | familia `gpt-4.1` por defecto |
| **Gemini** | `GEMINI_API_KEY` | tiene nivel gratuito; se usa vía su endpoint compatible con OpenAI |
| **Groq** | `GROQ_API_KEY` | nivel gratuito, corre modelos de pesos abiertos |
| OpenRouter | `OPENROUTER_API_KEY` | |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | una key para todos los proveedores |
| Ollama / LM Studio | — | local; **hay que pedirlo** con `ORCHESTATI_PROVIDER=ollama` |

Todo menos el gateway pasa por un único cliente compatible con OpenAI, así que
agregar un destino nuevo es agregar un preset, no un proveedor.

Los backends locales **no se autodetectan a propósito**: que un servidor esté
escuchando en el puerto no significa que uno quiera usarlo.

Los precios por tier salen de una tabla en `src/llm/model.ts` (tarifas de primera
parte de Anthropic, referencia 2026-06). Alimenta el corte por presupuesto, así
que un número inflado no es inofensivo: corta corridas que en realidad entraban.
Un modelo fuera de la tabla se asume caro — sobrestimar corta de más y se nota;
subestimar gasta de más y aparece en la factura.

```ts
import { Orchestrator } from 'orchestati';

const o = new Orchestrator({ maxCostUsd: 0.25 });
const res = await o.run('refactorizame este modulo');

res.text;              // respuesta final
res.decision.agents;   // quién la atendió
res.decision.ranking;  // por qué ganó ese
res.usage.costUsd;     // qué costó
res.toolCalls;         // qué herramientas usó, y cuáles le denegaron
res.trace;             // qué pasó, paso a paso
```

Con streaming y memoria de conversación:

```ts
import { Orchestrator, FileSessionStore } from 'orchestati';

const o = new Orchestrator({ sessions: new FileSessionStore() });
for await (const ev of o.stream('refactorizame esto', { sessionId: 'javier' })) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
}
```

Para controlar qué puede tocar:

```ts
import { Orchestrator, askUser, denyAll } from 'orchestati';

new Orchestrator({ confirm: denyAll() });              // sin herramientas
new Orchestrator({ root: '/ruta/al/proyecto' });       // otro sandbox
new Orchestrator({ confirm: askUser(async (req) => {   // tu propio gate
  return await miUI.confirmar(req.summary, req.risk);
}) });
```

## Agregar un agente

No hay que tocar el router: se registra y entra a competir.

```ts
import { llmAgent, createDefaultRegistry, Orchestrator } from 'orchestati';

const sql = llmAgent({
  id: 'llm.sql',
  name: 'SQL',
  description: 'Escribe y optimiza consultas SQL.',
  tier: 'standard',
  capabilities: ['code', 'analysis'],
  intents: ['code_generate', 'data_analysis'],
  cost: 0.4,
  comfortMax: 0.7,
  system: 'Sos un experto en SQL…',
  accepts: (s) => (/\b(select|join|query|sql)\b/.test(s.normalized) ? 0.5 : 0),
});

const registry = createDefaultRegistry().register(sql);
const o = new Orchestrator({ registry });
```

Para un agente que no use LLM (API, base de datos, cálculo local), implementá la
interfaz `Agent` directamente — `src/agents/reflex.ts` es el ejemplo.

## Estado

119 tests cubren el analizador, el ranking del router, el bucle de escalado, el
corte por presupuesto, la tolerancia a fallos, el loop de herramientas, la
contención del sandbox (escape de rutas, allowlist de binarios, SSRF, `eval`), el
clasificador semántico, las sesiones, el streaming y los endpoints del servidor
— **incluidos pisos de accuracy sobre los dos sets held-out**, así que una
regresión en el ruteo rompe el build en vez de pasar desapercibida.

Lo que todavía no está: el ~20% de los sets de evaluación que el clasificador
sigue errando, y las herramientas ejecutables desde el servidor con un gate
interactivo real (hoy el servidor se queda en sólo-lectura a propósito).
