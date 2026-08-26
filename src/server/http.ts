/**
 * ai-gateway HTTP server.
 *
 * Wraps Node's stdlib `http` module, parses incoming requests, dispatches
 * them through {@link resolveRoute}, and writes responses. Each dispatched
 * request goes through:
 *
 *   1. Inflight tracker begin()
 *   2. body parse (JSON only, 1 MiB default cap)
 *   3. auth middleware (Admin Token or Virtual Key)
 *   4. routing → protocol converter → upstream
 *   5. client serializer → response write
 *   6. inflight tracker end()
 *
 * Stages 4–5 are deliberately left to a later milestone; this module
 * exposes a `dispatch` interface that the wiring code implements.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { log } from '../utils/logger.js';
import type { Database } from '../storage/db.js';
import type { Repositories } from '../storage/index.js';
import type { Registry } from '../observability/registry.js';
import { createInflightTracker, installShutdown, type InflightTracker, type ShutdownHandle } from './lifecycle.js';
import { resolveRoute, type HttpMethod } from './router.js';
import { readJsonBody, BodyTooLargeError, InvalidJsonError } from './middleware/parse.js';
import { handleAdminRequest } from '../admin/index.js';

export interface GatewayContext {
  requestId: string;
  inflight: InflightTracker;
  shutdown: ShutdownHandle;
  server: Server;
  db: Database | null;
}

export interface DispatchInput {
  ctx: GatewayContext;
  req: IncomingMessage;
  res: ServerResponse;
  method: HttpMethod;
  pathname: string;
  params: Record<string, string>;
  body: unknown;
}

export type DispatchFn = (input: DispatchInput) => Promise<void> | void;

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Called once the server is listening. */
  onListen?: (info: { host: string; port: number }) => void;
  /** Called when shutdown completes. */
  onStopped?: () => void | Promise<void>;
  /** Optional admin subsystem dependencies. When provided, requests to
   * `/admin/*` are served before the gateway route table. */
   admin?: {
     repos: Repositories;
     registry: Registry;
     adminToken?: string;
     masterKey?: Buffer;
   };
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HEADERS_TIMEOUT_MS = 10_000;

/** HTTP status text for the few status codes we set explicitly. */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function startServer(opts: ServerOptions & { dispatch: DispatchFn; db?: Database | null }): {
  server: Server;
  port: number;
  host: string;
  shutdown: ShutdownHandle;
  inflight: InflightTracker;
  ready: Promise<void>;
} {
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const inflight = createInflightTracker();
  const server = createServer();
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  const serverRef: Server = server;
  const ctxRef: { current?: GatewayContext } = {};
  const lifecycleOpts: Parameters<typeof installShutdown>[3] = { shutdownTimeoutMs: 30_000 };
  if (opts.onStopped) lifecycleOpts.onStopped = opts.onStopped;
  const shutdown = installShutdown(server, opts.db ?? null, inflight, lifecycleOpts);

  const dispatch = opts.dispatch;

  server.on('request', (req, res) => {
    inflight.begin();
    void handleRequest(ctxRef, serverRef, req, res, dispatch, inflight, opts).finally(() => inflight.end());
  });

  server.on('error', (err) => {
    log.error('server.error', { error: err.message });
  });

  const ready = new Promise<void>((resolve) => {
    server.listen(requestedPort, host, () => {
      const addr = server.address() as AddressInfo | null;
      const actualPort = addr?.port ?? requestedPort;
      const actualHost = addr?.address ?? host;
      const ctx: GatewayContext = {
        requestId: 'pending',
        inflight,
        shutdown,
        server,
        db: opts.db ?? null,
      };
      ctxRef.current = ctx;
      log.info('server.listen', { host: actualHost, port: actualPort });
      opts.onListen?.({ host: actualHost, port: actualPort });
      resolve();
    });
  });

  return {
    server,
    port: requestedPort,
    host,
    shutdown,
    inflight,
    ready,
  };
}

async function handleRequest(
  ctxRef: { current?: GatewayContext },
  server: Server,
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: DispatchFn,
  inflight: InflightTracker,
  opts: ServerOptions & { dispatch: DispatchFn; db?: Database | null },
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Gateway-Version', '0.1.0');

  const ctx: GatewayContext = {
    requestId,
    inflight,
    shutdown: ctxRef.current?.shutdown ?? installNoopShutdown(),
    server,
    db: ctxRef.current?.db ?? null,
  };

  const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
  const url = req.url ?? '/';
  const qIdx = url.indexOf('?');
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx);

  // Admin subsystem is matched first so its HTML and JSON endpoints are
  // served regardless of whether the path collides with a future gateway
  // route. The handler returns true on match. The bare root path is routed
  // here too so preview panes opening "/" land on the admin UI (302).
  const isAdminPath =
    pathname === '/' ||
    pathname === '' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/');
  if (opts?.admin && isAdminPath) {
    if (!ctxRef.current?.db) {
      // No DB available; admin can't operate. Surface 503 to the client.
      writeJsonError(res, 503, 'admin_unavailable', 'admin subsystem requires a database');
      return;
    }
    try {
      const handled = await handleAdminRequest(req, res, {
        repos: opts.admin.repos,
        registry: opts.admin.registry,
        adminToken: opts.admin.adminToken,
        masterKey: opts.admin.masterKey,
      });
      if (handled) return;
    } catch (err) {
      if (!res.headersSent) writeJsonError(res, 500, 'admin_error', errMessage(err));
      return;
    }
  }

  const route = resolveRoute(method, pathname);
  if (!route) {
    writeJsonError(res, 404, 'route_not_found', `No route for ${method} ${pathname}`);
    return;
  }

  // Body parsing is skipped for obvious-no-body methods.
  const needsBody = method !== 'GET' && method !== 'DELETE';
  let body: unknown = undefined;
  if (needsBody) {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        writeJsonError(res, 413, 'payload_too_large', err.message);
        return;
      }
      if (err instanceof InvalidJsonError) {
        writeJsonError(res, 400, 'invalid_json', err.message);
        return;
      }
      throw err;
    }
  }

  try {
    await dispatch({ ctx, req, res, method, pathname, params: route.params, body });
  } catch (err) {
    if (!res.headersSent) {
      log.error('server.dispatch_error', { requestId, error: errMessage(err), method, pathname });
      writeJsonError(res, 500, 'internal_error', errMessage(err));
    } else {
      log.error('server.dispatch_error_after_headers', { requestId, error: errMessage(err) });
      try {
        res.end();
      } catch {
        /* best effort */
      }
    }
  }
}

function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { type: code, code, message } });
  res.statusCode = status;
  res.statusMessage = STATUS_TEXT[status] ?? 'Error';
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function generateRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stand-in shutdown handle used before the server is listening. */
function installNoopShutdown(): ShutdownHandle {
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    forceExit: () => resolve(),
    done,
  };
}

/**
 * Set SSE headers and return a chunk helper. The first call writes headers;
 * subsequent calls write `data: ...\n\n` chunks.
 */
export function startSseResponse(res: ServerResponse): (eventName?: string, data?: unknown) => void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (eventName, data) => {
    if (eventName) res.write(`event: ${eventName}\n`);
    if (data !== undefined) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`data: ${payload}\n`);
    }
    res.write('\n');
  };
}

export { resolveRoute };
export { BodyTooLargeError, InvalidJsonError };