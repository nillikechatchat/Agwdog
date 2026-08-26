#!/usr/bin/env node
/**
 * ai-gateway CLI entry point.
 *
 * Usage:
 *   npx ai-gateway          # start the gateway server (reads gateway.config.json)
 *   npx ai-gateway --version
 *   npx ai-gateway --help
 *
 * The actual server wiring lives in `src/server/http.ts`.
 */

import { resolve } from 'node:path';
import { argv, env } from 'node:process';

const VERSION = '0.1.0';

async function main(): Promise<void> {
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
  const { startServer } = await import('../server/http.js');
  const { migrate, openDatabase } = await import('../storage/db.js');
  const { Repositories } = await import('../storage/index.js');
  const { Registry } = await import('../observability/registry.js');
  const { createPipeline } = await import('../dispatch/index.js');
  const { loadConfig } = await import('../config/loader.js');
  const { loadMasterKey, encrypt } = await import('../crypto/aes.js');
  const { log } = await import('../utils/logger.js');

  const dataDir = env['GATEWAY_DATA_DIR'] ?? resolve(process.cwd(), 'data');
  const dbPath = resolve(dataDir, 'gateway.db');
  const db = openDatabase(dbPath);
  migrate(db as never);
  const repos = new Repositories(db as never);
  const registry = new Registry();
  const config = loadConfig({ configPath: configFile });

  // Load or generate master key for API key encryption
  const masterKey = loadMasterKey(dataDir, env['GATEWAY_MASTER_KEY']);

  // Initialize providers and virtual models from config
  if (config.providers) {
    for (const p of config.providers) {
      try {
        const existing = repos.providers.getByName(p.name);
        if (!existing) {
          // Encrypt the API key
          const encrypted = encrypt(p.apiKey, masterKey);
          repos.providers.insert({
            id: `provider-${p.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: p.name,
            protocol: p.protocol,
            baseUrl: p.baseUrl,
            apiKeyCiphertext: encrypted.ciphertext,
            apiKeyIv: encrypted.iv,
            apiKeyTag: encrypted.tag,
            inputPricePerMTokensUsd: p.inputPricePerMTokensUsd ?? null,
            outputPricePerMTokensUsd: p.outputPricePerMTokensUsd ?? null,
            cachedInputPricePerMTokensUsd: p.cachedInputPricePerMTokensUsd ?? null,
            enabled: p.enabled !== false,
            extra: p.extra ?? null,
          });
        }
      } catch (e) {
        log.error('provider_insert_error', { name: p.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (config.virtualModels) {
    for (const vm of config.virtualModels) {
      try {
        const existing = repos.virtualModels.getByName(vm.name);
        if (!existing) {
          repos.virtualModels.insert({
            id: `vm-${vm.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: vm.name,
            strategy: vm.strategy,
            latencyWindow: vm.latencyWindow ?? null,
            failureThreshold: vm.failureThreshold ?? null,
            recoveryThreshold: vm.recoveryThreshold ?? null,
            maxRetries: 2,
            fallbackChain: vm.fallbackChain ?? [],
          });
        }
      } catch {}
    }
  }

  // Create pipeline with full wiring
  const pipelineDeps = {
    db,
    repos,
    registry,
    config: {
      cacheEnabled: config.cacheEnabled,
      cacheTtlSeconds: config.cacheTtlSeconds,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
    },
  };
  const pipeline = createPipeline(pipelineDeps);

  const dispatch = async (input: any): Promise<void> => {
    await pipeline.dispatch({
      requestId: input.ctx.requestId ?? '',
      req: input.req,
      res: input.res,
      method: input.method,
      pathname: input.pathname,
      body: input.body,
      params: input.params,
    });
  };

  const serverOpts: any = {
    dispatch,
    db,
    port: Number(env['GATEWAY_PORT']) || config.port || 3000,
    onListen(info: any) {
      log.info('cli.start', { host: info.host, port: info.port, configFile });
    },
    onStopped() {
      try { db.close(); } catch { /* best-effort */ }
    },
  };

  if (env['GATEWAY_ADMIN_TOKEN'] || config.adminToken) {
    serverOpts.admin = {
      repos,
      registry,
      adminToken: env['GATEWAY_ADMIN_TOKEN'] || config.adminToken,
      masterKey,
    };
  }

  const server = startServer(serverOpts);

  // Listen.
  void server.ready.then(() => {
    // keep alive until SIGTERM
  });
}

void main().catch((err) => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});
