/**
 * Gateway configuration loader.
 *
 * Resolves the active config from, in order of precedence:
 *   1. CLI flags (passed in via {@link loadConfig})
 *   2. Environment variables (GATEWAY_*)
 *   3. JSON file (--config <path> or ./gateway.config.json)
 *   4. Built-in defaults
 *
 * On first run (no admin token in file/env), a random token is generated
 * and printed to stdout so the operator can capture it before the process
 * detaches.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GatewayConfigFile,
  type ResolvedConfig,
  type Protocol,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_DATA_DIR,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_PORT,
  DEFAULT_PROBE_INTERVAL_MINUTES,
  DEFAULT_RECOVERY_THRESHOLD,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_BUDGET_RATIO,
} from './types.js';

const VALID_PROTOCOLS: readonly Protocol[] = ['OpenAI', 'OpenAI-Compatible', 'Anthropic', 'Gemini', 'Doubao', 'Wenxin'];

export interface LoadOptions {
  configPath?: string;
  /** When true, generate a fresh Admin Token if none was supplied. Default: true. */
  generateAdminToken?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function asString(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

function asInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`Expected integer, got: ${value}`);
  }
  return n;
}

function asNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`Expected number, got: ${value}`);
  }
  return n;
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new ConfigError(`Expected boolean, got: ${value}`);
}

function readFileIfExists(path: string): GatewayConfigFile {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as GatewayConfigFile;
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validate(file: GatewayConfigFile): void {
  const seenNames = new Set<string>();
  for (const p of file.providers ?? []) {
    if (!p.name) throw new ConfigError('Provider is missing required field: name');
    if (seenNames.has(p.name)) throw new ConfigError(`Duplicate provider name: ${p.name}`);
    seenNames.add(p.name);
    if (!VALID_PROTOCOLS.includes(p.protocol)) {
      throw new ConfigError(`Provider ${p.name} has invalid protocol: ${p.protocol}`);
    }
    if (!p.baseUrl) throw new ConfigError(`Provider ${p.name} is missing required field: baseUrl`);
    if (!p.apiKey) throw new ConfigError(`Provider ${p.name} is missing required field: apiKey`);
    try {
      new URL(p.baseUrl);
    } catch {
      throw new ConfigError(`Provider ${p.name} has invalid baseUrl: ${p.baseUrl}`);
    }
    if (p.inputPricePerMTokensUsd !== undefined && p.inputPricePerMTokensUsd < 0) {
      throw new ConfigError(`Provider ${p.name} inputPricePerMTokensUsd must be >= 0`);
    }
    if (p.outputPricePerMTokensUsd !== undefined && p.outputPricePerMTokensUsd < 0) {
      throw new ConfigError(`Provider ${p.name} outputPricePerMTokensUsd must be >= 0`);
    }
  }

  const seenVmNames = new Set<string>();
  for (const vm of file.virtualModels ?? []) {
    if (!vm.name) throw new ConfigError('VirtualModel is missing required field: name');
    if (seenVmNames.has(vm.name)) throw new ConfigError(`Duplicate virtual model name: ${vm.name}`);
    seenVmNames.add(vm.name);
    if (!['RoundRobin', 'WeightedRandom', 'Failover', 'LowestLatency'].includes(vm.strategy)) {
      throw new ConfigError(`VirtualModel ${vm.name} has invalid strategy: ${vm.strategy}`);
    }
    if (!vm.members || vm.members.length === 0) {
      throw new ConfigError(`VirtualModel ${vm.name} must have at least one member`);
    }
    for (const m of vm.members) {
      if (!m.upstreamModelRef.includes('/')) {
        throw new ConfigError(
          `VirtualModel ${vm.name} member upstreamModelRef must be "<provider>/<model>": ${m.upstreamModelRef}`,
        );
      }
    }
  }

  for (const k of file.keys ?? []) {
    if (!k.name) throw new ConfigError('Key is missing required field: name');
    if (k.budgetMode !== undefined && !['soft', 'hard'].includes(k.budgetMode)) {
      throw new ConfigError(`Key ${k.name} has invalid budgetMode: ${k.budgetMode}`);
    }
    if (k.logSampleRate !== undefined && (k.logSampleRate < 0 || k.logSampleRate > 1)) {
      throw new ConfigError(`Key ${k.name} logSampleRate must be in [0, 1]`);
    }
  }
}

function ensureDataDir(path: string): void {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
  }
}

/**
 * Resolve and validate the gateway configuration.
 *
 * @param options.configPath  optional explicit path to JSON config
 * @param options.generateAdminToken  whether to mint a token when none was provided (default true)
 */
export function loadConfig(options: LoadOptions = {}): ResolvedConfig {
  const configPath = options.configPath ?? process.env['GATEWAY_CONFIG'] ?? './gateway.config.json';
  const file = readFileIfExists(configPath);

  const port = asInt(asString(process.env['PORT']), file.port ?? DEFAULT_PORT);
  const dataDir = asString(process.env['GATEWAY_DATA_DIR']) ?? file.dataDir ?? DEFAULT_DATA_DIR;
  ensureDataDir(dataDir);

  const probeIntervalMinutes = asInt(
    asString(process.env['GATEWAY_PROBE_INTERVAL_MINUTES']),
    file.probeIntervalMinutes ?? DEFAULT_PROBE_INTERVAL_MINUTES,
  );
  const failureThreshold = asInt(
    asString(process.env['GATEWAY_FAILURE_THRESHOLD']),
    file.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
  );
  const recoveryThreshold = asInt(
    asString(process.env['GATEWAY_RECOVERY_THRESHOLD']),
    file.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD,
  );
  const retryBudgetRatio = asNumber(
    asString(process.env['GATEWAY_RETRY_BUDGET_RATIO']),
    file.retryBudgetRatio ?? DEFAULT_RETRY_BUDGET_RATIO,
  );
  const cacheEnabled = asBool(
    asString(process.env['GATEWAY_CACHE_ENABLED']),
    file.cacheEnabled ?? true,
  );
  const cacheTtlSeconds = asInt(
    asString(process.env['GATEWAY_CACHE_TTL_SECONDS']),
    file.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
  );
  const cacheMaxEntries = asInt(
    asString(process.env['GATEWAY_CACHE_MAX_ENTRIES']),
    file.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
  );
  const connectTimeoutMs = asInt(
    asString(process.env['GATEWAY_CONNECT_TIMEOUT_MS']),
    file.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const requestTimeoutMs = asInt(
    asString(process.env['GATEWAY_REQUEST_TIMEOUT_MS']),
    file.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const otelExporterOtlpEndpoint =
    asString(process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) ?? file.otelExporterOtlpEndpoint ?? null;

  let adminToken = asString(process.env['GATEWAY_ADMIN_TOKEN']) ?? file.adminToken ?? '';
  if (!adminToken) {
    if (options.generateAdminToken === false) {
      throw new ConfigError('Admin token is required (set GATEWAY_ADMIN_TOKEN or adminToken in config)');
    }
    adminToken = `gw_${randomBytes(24).toString('hex')}`;
    // Print to stdout once so the operator can capture it; subsequent loads reuse file/env.
    process.stdout.write(`[ai-gateway] Generated Admin Token: ${adminToken}\n`);
  }

  const adminEnabled = asBool(asString(process.env['GATEWAY_ADMIN_ENABLED']), file.adminEnabled ?? true);

  const merged: GatewayConfigFile = {
    port,
    adminToken,
    adminEnabled,
    dataDir,
    probeIntervalMinutes,
    failureThreshold,
    recoveryThreshold,
    retryBudgetRatio,
    cacheEnabled,
    cacheTtlSeconds,
    cacheMaxEntries,
    connectTimeoutMs,
    requestTimeoutMs,
    ...(otelExporterOtlpEndpoint ? { otelExporterOtlpEndpoint } : {}),
    providers: file.providers ?? [],
    virtualModels: file.virtualModels ?? [],
    keys: file.keys ?? [],
  };

  validate(merged);

  return {
    port,
    adminToken,
    adminEnabled,
    dataDir,
    probeIntervalMinutes,
    failureThreshold,
    recoveryThreshold,
    retryBudgetRatio,
    cacheEnabled,
    cacheTtlSeconds,
    cacheMaxEntries,
    connectTimeoutMs,
    requestTimeoutMs,
    otelExporterOtlpEndpoint,
    providers: merged.providers ?? [],
    virtualModels: merged.virtualModels ?? [],
    keys: merged.keys ?? [],
  };
}