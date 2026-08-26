/**
 * Graceful shutdown lifecycle for the ai-gateway HTTP server.
 *
 * When SIGTERM/SIGINT arrives, we:
 *   1. Stop accepting new connections (`server.close()`).
 *   2. Wait up to `shutdownTimeoutMs` (default 30s) for in-flight requests
 *      tracked via the {@link InflightTracker} to drain.
 *   3. Close the SQLite database cleanly so WAL is flushed.
 *
 * After the deadline expires the process exits regardless; long-running
 * streaming requests get cut off (the upstream connection is closed too).
 */

import type { Server } from 'node:http';

import type { Database } from '../storage/db.js';
import { log } from '../utils/logger.js';

export interface InflightTracker {
  begin(): void;
  end(): void;
  count(): number;
}

export function createInflightTracker(): InflightTracker {
  let n = 0;
  return {
    begin: () => {
      n += 1;
    },
    end: () => {
      n = Math.max(0, n - 1);
    },
    count: () => n,
  };
}

export interface LifecycleOptions {
  shutdownTimeoutMs?: number;
  /** Called once draining begins, useful for stopping background workers. */
  onDrainStart?: () => void | Promise<void>;
  /** Called once the server has fully stopped. */
  onStopped?: () => void | Promise<void>;
}

export interface ShutdownHandle {
  /** Forcibly cut over to process.exit, used by tests. */
  forceExit: () => void;
  /** Awaitable that resolves when shutdown completes or the timeout fires. */
  done: Promise<void>;
}

/**
 * Install SIGTERM/SIGINT handlers on `process` and arrange to close the HTTP
 * server + database when invoked. Returns a {@link ShutdownHandle} so the
 * caller can await completion or force exit.
 */
export function installShutdown(
  server: Server,
  db: Database | null,
  inflight: InflightTracker,
  options: LifecycleOptions = {},
): ShutdownHandle {
  const timeoutMs = options.shutdownTimeoutMs ?? 30_000;
  let triggered = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handler = (signal: NodeJS.Signals): void => {
    if (triggered) return;
    triggered = true;
    log.info('shutdown.signal', { signal, inflight: inflight.count(), timeoutMs });
    void shutdown(server, db, inflight, timeoutMs, options).finally(() => {
      resolveDone();
    });
  };

  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);

  return {
    forceExit: () => handler('SIGTERM'),
    done,
  };
}

async function shutdown(
  server: Server,
  db: Database | null,
  inflight: InflightTracker,
  timeoutMs: number,
  options: LifecycleOptions,
): Promise<void> {
  if (options.onDrainStart) {
    try {
      await options.onDrainStart();
    } catch (err) {
      log.warn('shutdown.drain_start_error', { error: errMessage(err) });
    }
  }

  // Stop accepting new connections.
  server.close((err) => {
    if (err) log.warn('shutdown.server_close_error', { error: err.message });
  });

  const start = Date.now();
  while (inflight.count() > 0 && Date.now() - start < timeoutMs) {
    await sleep(100);
  }
  if (inflight.count() > 0) {
    log.warn('shutdown.drain_timeout', { inflight: inflight.count() });
  }

  try {
    db?.close();
  } catch (err) {
    log.warn('shutdown.db_close_error', { error: errMessage(err) });
  }

  if (options.onStopped) {
    try {
      await options.onStopped();
    } catch (err) {
      log.warn('shutdown.stopped_callback_error', { error: errMessage(err) });
    }
  }
  log.info('shutdown.complete', { durationMs: Date.now() - start });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}