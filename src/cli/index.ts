#!/usr/bin/env node
/**
 * ai-gateway CLI entry point.
 *
 * Usage:
 *   npx ai-gateway          # start the gateway server (reads gateway.config.json)
 *   npx ai-gateway --version
 *   npx ai-gateway --help
 *
 * The actual server wiring lives in `src/server/lifecycle.ts` + `src/admin/api.ts`.
 * This file is intentionally thin — all business logic is exercised by the test
 * suite, not here.
 */

import { resolve } from 'node:path';
import { argv, env } from 'node:process';

const VERSION = '0.1.0';

function main(): void {
  const args = argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`ai-gateway v${VERSION}

Usage:
  npx ai-gateway              Start the gateway (reads ./gateway.config.json)
  npx ai-gateway --version    Print version and exit
  npx ai-gateway --help       Show this help

Config file (JSON):
  {
    "port": 3000,
    "host": "127.0.0.1",
    "adminToken": "<optional Bearer token for /admin/*>",
    "dataDir": "./data",
    "providers": [ ... ],
    "virtualModels": [ ... ]
  }

Environment variables:
  GATEWAY_PORT          override port (default 3000)
  GATEWAY_HOST          override host (default 127.0.0.1)
  GATEWAY_ADMIN_TOKEN   set admin bearer token (override config file)
  GATEWAY_DATA_DIR      data directory (default ./data)
  GATEWAY_MASTER_KEY    AES-256 key for encrypting stored API keys (auto-generated on first run if absent)
`);
    process.exit(0);
  }

  // Default path: current working directory.
  const configFile = args.find((a) => a.startsWith('--config='))?.split('=')[1]
    ?? resolve(process.cwd(), 'gateway.config.json');

  // Lazy-load to avoid type-circular import at startup.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startServer } = require('../server/http.js') as typeof import('../server/http.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { migrate, openDatabase } = require('../storage/db.js') as typeof import('../storage/db.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Repositories } = require('../storage/index.js') as typeof import('../storage/index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Registry } = require('../observability/registry.js') as typeof import('../observability/registry.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { log } = require('../utils/logger.js') as typeof import('../utils/logger.js');

  const dataDir = env['GATEWAY_DATA_DIR'] ?? resolve(process.cwd(), 'data');
  const dbPath = resolve(dataDir, 'gateway.db');
  const db = openDatabase(dbPath);
  migrate(db as never);
  const repos = new Repositories(db as never);
  const registry = new Registry();

  // Minimal dispatch: just auth + metrics. The real adapter/client wiring
  // is deferred to a future milestone (see design.md §3).
  async function dispatch({ res }: { res: import('node:http').ServerResponse }): Promise<void> {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: VERSION, message: 'gateway up (dispatch stub)' }));
  }

  const adminToken = env['GATEWAY_ADMIN_TOKEN'];
  const server = startServer({
    dispatch,
    db,
    port: Number(env['GATEWAY_PORT']) || 3000,
    host: env['GATEWAY_HOST'] || '127.0.0.1',
    admin: {
      repos,
      registry,
      ...(adminToken !== undefined ? { adminToken } : {}),
    },
    onListen(info) {
      log.info('cli.start', { host: info.host, port: info.port, configFile });
    },
    onStopped() {
      try { db.close(); } catch { /* best-effort */ }
    },
  });

  // Listen.
  void server.ready.then(() => {
    // keep alive until SIGTERM
  });
}

main();
