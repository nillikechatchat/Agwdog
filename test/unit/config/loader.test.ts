import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig } from '@/config/loader.js';

let workDir: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-gateway-config-'));
  prevEnv = {
    PORT: process.env['PORT'],
    GATEWAY_ADMIN_TOKEN: process.env['GATEWAY_ADMIN_TOKEN'],
    GATEWAY_ADMIN_ENABLED: process.env['GATEWAY_ADMIN_ENABLED'],
    GATEWAY_DATA_DIR: process.env['GATEWAY_DATA_DIR'],
    GATEWAY_CONFIG: process.env['GATEWAY_CONFIG'],
    GATEWAY_PROBE_INTERVAL_MINUTES: process.env['GATEWAY_PROBE_INTERVAL_MINUTES'],
    GATEWAY_FAILURE_THRESHOLD: process.env['GATEWAY_FAILURE_THRESHOLD'],
    GATEWAY_RECOVERY_THRESHOLD: process.env['GATEWAY_RECOVERY_THRESHOLD'],
    GATEWAY_RETRY_BUDGET_RATIO: process.env['GATEWAY_RETRY_BUDGET_RATIO'],
    GATEWAY_CACHE_ENABLED: process.env['GATEWAY_CACHE_ENABLED'],
    GATEWAY_CACHE_TTL_SECONDS: process.env['GATEWAY_CACHE_TTL_SECONDS'],
    GATEWAY_CACHE_MAX_ENTRIES: process.env['GATEWAY_CACHE_MAX_ENTRIES'],
    GATEWAY_CONNECT_TIMEOUT_MS: process.env['GATEWAY_CONNECT_TIMEOUT_MS'],
    GATEWAY_REQUEST_TIMEOUT_MS: process.env['GATEWAY_REQUEST_TIMEOUT_MS'],
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  };
  for (const k of Object.keys(prevEnv)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadConfig — defaults', () => {
  it('returns built-in defaults when no file or env is set', () => {
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json') });
    expect(cfg.port).toBe(3000);
    expect(cfg.adminEnabled).toBe(true);
    expect(cfg.dataDir).toBe('./data');
    expect(cfg.probeIntervalMinutes).toBe(15);
    expect(cfg.failureThreshold).toBe(3);
    expect(cfg.recoveryThreshold).toBe(2);
    expect(cfg.retryBudgetRatio).toBe(0.2);
    expect(cfg.cacheEnabled).toBe(true);
    expect(cfg.cacheTtlSeconds).toBe(300);
    expect(cfg.cacheMaxEntries).toBe(1000);
    expect(cfg.connectTimeoutMs).toBe(5000);
    expect(cfg.requestTimeoutMs).toBe(60000);
    expect(cfg.otelExporterOtlpEndpoint).toBeNull();
    expect(cfg.providers).toEqual([]);
    expect(cfg.virtualModels).toEqual([]);
    expect(cfg.keys).toEqual([]);
  });

  it('throws when admin token is missing and generation is disabled', () => {
    expect(() => loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false })).toThrow(
      ConfigError,
    );
  });

  it('auto-generates an admin token with the gw_ prefix when enabled', () => {
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json') });
    expect(cfg.adminToken.startsWith('gw_')).toBe(true);
    expect(cfg.adminToken.length).toBeGreaterThan('gw_'.length + 16);
  });
});

describe('loadConfig — env overrides', () => {
  it('PORT env wins over defaults', () => {
    process.env['PORT'] = '8080';
    process.env['GATEWAY_ADMIN_TOKEN'] = 'manual';
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false });
    expect(cfg.port).toBe(8080);
  });

  it('numeric env vars are parsed with full type validation', () => {
    process.env['GATEWAY_ADMIN_TOKEN'] = 'manual';
    process.env['GATEWAY_PROBE_INTERVAL_MINUTES'] = '5';
    process.env['GATEWAY_FAILURE_THRESHOLD'] = '4';
    process.env['GATEWAY_RETRY_BUDGET_RATIO'] = '0.1';
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false });
    expect(cfg.probeIntervalMinutes).toBe(5);
    expect(cfg.failureThreshold).toBe(4);
    expect(cfg.retryBudgetRatio).toBe(0.1);
  });

  it('invalid integer in env throws ConfigError', () => {
    process.env['GATEWAY_ADMIN_TOKEN'] = 'manual';
    process.env['PORT'] = 'notanumber';
    expect(() => loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false })).toThrow(
      ConfigError,
    );
  });

  it('boolean env vars accept true/false/1/0', () => {
    process.env['GATEWAY_ADMIN_TOKEN'] = 'manual';
    process.env['GATEWAY_ADMIN_ENABLED'] = '0';
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false });
    expect(cfg.adminEnabled).toBe(false);
  });

  it('OTEL endpoint is read from OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    process.env['GATEWAY_ADMIN_TOKEN'] = 'manual';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://otel:4317';
    const cfg = loadConfig({ configPath: join(workDir, 'missing.json'), generateAdminToken: false });
    expect(cfg.otelExporterOtlpEndpoint).toBe('http://otel:4317');
  });
});

describe('loadConfig — file parsing', () => {
  it('reads port and providers from JSON file', () => {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        port: 4242,
        adminToken: 'file-token',
        providers: [
          {
            name: 'openai',
            protocol: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-x',
            inputPricePerMTokensUsd: 2.5,
            outputPricePerMTokensUsd: 10,
          },
        ],
      }),
    );
    const cfg = loadConfig({ configPath: cfgPath, generateAdminToken: false });
    expect(cfg.port).toBe(4242);
    expect(cfg.adminToken).toBe('file-token');
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]?.name).toBe('openai');
  });

  it('creates dataDir on disk if missing', () => {
    const cfgPath = join(workDir, 'gw.json');
    const dataDir = join(workDir, 'fresh-data');
    writeFileSync(
      cfgPath,
      JSON.stringify({ adminToken: 'file-token', dataDir }),
    );
    expect(existsSync(dataDir)).toBe(false);
    loadConfig({ configPath: cfgPath, generateAdminToken: false });
    expect(existsSync(dataDir)).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(cfgPath, '{ this is not json');
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(ConfigError);
  });
});

describe('loadConfig — provider validation', () => {
  function writeProviders(providers: unknown[]) {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(cfgPath, JSON.stringify({ adminToken: 't', providers }, null, 2));
    return cfgPath;
  }

  it('rejects unknown protocol', () => {
    const cfgPath = writeProviders([
      { name: 'a', protocol: 'Banana', baseUrl: 'https://x', apiKey: 'k' },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/invalid protocol/);
  });

  it('rejects missing baseUrl', () => {
    const cfgPath = writeProviders([
      { name: 'a', protocol: 'OpenAI', apiKey: 'k' } as unknown as object,
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/baseUrl/);
  });

  it('rejects invalid baseUrl', () => {
    const cfgPath = writeProviders([
      { name: 'a', protocol: 'OpenAI', baseUrl: 'not a url', apiKey: 'k' },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/invalid baseUrl/);
  });

  it('rejects negative price', () => {
    const cfgPath = writeProviders([
      { name: 'a', protocol: 'OpenAI', baseUrl: 'https://x', apiKey: 'k', inputPricePerMTokensUsd: -1 },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/>= 0/);
  });

  it('rejects duplicate provider names', () => {
    const cfgPath = writeProviders([
      { name: 'a', protocol: 'OpenAI', baseUrl: 'https://x', apiKey: 'k' },
      { name: 'a', protocol: 'OpenAI-Compatible', baseUrl: 'https://y', apiKey: 'k' },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/Duplicate provider/);
  });
});

describe('loadConfig — virtualModel validation', () => {
  function writeVms(virtualModels: unknown[]) {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        adminToken: 't',
        providers: [{ name: 'p', protocol: 'OpenAI', baseUrl: 'https://x', apiKey: 'k' }],
        virtualModels,
      }),
    );
    return cfgPath;
  }

  it('rejects empty members list', () => {
    const cfgPath = writeVms([{ name: 'gpt', strategy: 'RoundRobin', members: [] }]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/at least one/);
  });

  it('rejects unknown strategy', () => {
    const cfgPath = writeVms([
      { name: 'gpt', strategy: 'RandomWalk', members: [{ upstreamModelRef: 'p/m' }] },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/invalid strategy/);
  });

  it('rejects malformed upstreamModelRef (missing /)', () => {
    const cfgPath = writeVms([
      { name: 'gpt', strategy: 'RoundRobin', members: [{ upstreamModelRef: 'pm' }] },
    ]);
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/provider.*model/);
  });
});

describe('loadConfig — key validation', () => {
  it('rejects logSampleRate out of range', () => {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ adminToken: 't', keys: [{ name: 'k', logSampleRate: 1.5 }] }),
    );
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/logSampleRate/);
  });

  it('rejects invalid budgetMode', () => {
    const cfgPath = join(workDir, 'gw.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ adminToken: 't', keys: [{ name: 'k', budgetMode: 'maybe' }] }),
    );
    expect(() => loadConfig({ configPath: cfgPath, generateAdminToken: false })).toThrow(/budgetMode/);
  });
});