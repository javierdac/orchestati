import { loadEnv } from './core/env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Orchestrator, type OrchestratorOptions } from './runtime/orchestrator.js';
import { FileSessionStore } from './runtime/session.js';
import { FileRouterMemory } from './router/memory.js';
import { autoSafe } from './tools/confirm.js';
import type { OrchestrationEvent } from './core/events.js';

/**
 * Servidor HTTP del orquestador. Sin framework: `node:http` alcanza y mantiene
 * el proyecto sin dependencias de runtime mas alla del SDK del modelo.
 *
 * Nota sobre herramientas: del otro lado de un HTTP no hay a quien preguntarle
 * si autoriza un `rm`. Por eso la politica por defecto aca es `autoSafe`
 * —lectura si, escritura no— y subirla es una decision explicita de quien
 * levanta el servidor.
 */

const MAX_BODY = 256 * 1024;

export interface ServerOptions extends OrchestratorOptions {
  port?: number;
  host?: string;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('cuerpo demasiado grande');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

/** Un evento de orquestacion como evento SSE. */
function sse(res: ServerResponse, event: OrchestrationEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createOrchestatiServer(opts: ServerOptions = {}) {
  loadEnv();
  const orchestrator = new Orchestrator({
    confirm: opts.confirm ?? autoSafe(),
    sessions: opts.sessions ?? new FileSessionStore(),
    routerOptions: opts.routerOptions ?? { memory: new FileRouterMemory('.orchestati/memory.json') },
    ...opts,
  });

  const here = dirname(fileURLToPath(import.meta.url));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    try {
      // --- UI de demostracion -------------------------------------------
      if (req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(join(here, 'ui', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, {
          ok: true,
          agents: orchestrator.registry.all().length,
          confirm: (opts.confirm ?? autoSafe()).name,
        });
        return;
      }

      // --- Pool de agentes ----------------------------------------------
      if (req.method === 'GET' && url.pathname === '/agents') {
        json(res, 200, {
          agents: orchestrator.registry.all().map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            tier: a.tier,
            role: a.role ?? 'worker',
            capabilities: a.capabilities,
            intents: a.intents,
            cost: a.cost,
          })),
        });
        return;
      }

      // --- Analisis y ruteo, sin ejecutar --------------------------------
      if (req.method === 'POST' && url.pathname === '/inspect') {
        const body = (await readBody(req)) as { input?: string };
        if (!body.input?.trim()) return json(res, 400, { error: 'falta "input"' });
        const { signals, decision } = orchestrator.inspect(body.input);
        json(res, 200, { signals, decision });
        return;
      }

      // --- Ejecucion completa --------------------------------------------
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = (await readBody(req)) as { input?: string; sessionId?: string };
        if (!body.input?.trim()) return json(res, 400, { error: 'falta "input"' });
        const result = await orchestrator.run(body.input, {
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        });
        json(res, 200, result);
        return;
      }

      // --- Ejecucion en streaming (SSE) ----------------------------------
      if (req.method === 'POST' && url.pathname === '/chat/stream') {
        const body = (await readBody(req)) as { input?: string; sessionId?: string };
        if (!body.input?.trim()) return json(res, 400, { error: 'falta "input"' });

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-accel-buffering': 'no',
        });

        // Si el cliente se va, se aborta el trabajo en vez de seguir gastando.
        const abort = new AbortController();
        req.on('close', () => abort.abort());

        try {
          for await (const event of orchestrator.stream(body.input, {
            signal: abort.signal,
            ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          })) {
            if (res.writableEnded) break;
            sse(res, event);
          }
        } catch (err) {
          if (!res.writableEnded) {
            sse(res, { type: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        }
        res.end();
        return;
      }

      // --- Sesiones -------------------------------------------------------
      const sessionMatch = url.pathname.match(/^\/session\/([\w-]{1,64})$/);
      if (sessionMatch) {
        const id = sessionMatch[1]!;
        if (req.method === 'GET') {
          json(res, 200, { sessionId: id, messages: await orchestrator.sessions.history(id) });
          return;
        }
        if (req.method === 'DELETE') {
          await orchestrator.sessions.clear(id);
          json(res, 200, { ok: true });
          return;
        }
      }

      json(res, 404, { error: 'no encontrado' });
    } catch (err) {
      if (!res.writableEnded) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  return {
    server,
    orchestrator,
    listen(port = opts.port ?? 3000, host = opts.host ?? '127.0.0.1'): Promise<number> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Arranque directo: `pnpm serve`
const esteArchivo = fileURLToPath(import.meta.url);
if (process.argv[1] && (process.argv[1] === esteArchivo || esteArchivo.startsWith(process.argv[1]))) {
  const port = Number(process.env.PORT ?? 3000);
  const { createModelClient } = await import('./llm/model.js');
  const app = createOrchestatiServer({ port, model: await createModelClient() });
  void app.listen(port).then((p) => {
    console.log(`orchestati escuchando en http://127.0.0.1:${p}`);
    console.log(`  POST /chat  ·  POST /chat/stream (SSE)  ·  POST /inspect  ·  GET /agents`);
  });
}
