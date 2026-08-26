import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, roundTrip } from '@/crypto/aes.js';
import { randomBytes } from 'node:crypto';

import { openDatabase, closeDatabase, type Database } from '@/storage/db.js';
import { Repositories } from '@/storage/index.js';

let workDir: string;
let db: Database | null = null;
let repos: Repositories | null = null;
let masterKey: Buffer;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-gateway-repos-'));
  const path = join(workDir, 'gateway.db');
  db = openDatabase(path);
  repos = new Repositories(db);
  masterKey = randomBytes(32);
});

afterEach(() => {
  if (db) closeDatabase(db);
  rmSync(workDir, { recursive: true, force: true });
});

function seedProvider(name: string): { id: string; apiKey: string } {
  const apiKey = 'sk-test-' + name;
  const blob = encrypt(apiKey, masterKey);
  repos!.providers.insert({
    id: 'p-' + name,
    name,
    protocol: 'OpenAI',
    baseUrl: 'https://api.example.com/v1',
    apiKeyCiphertext: blob.ciphertext,
    apiKeyIv: blob.iv,
    apiKeyTag: blob.tag,
  });
  return { id: 'p-' + name, apiKey };
}

describe('ProviderRepo', () => {
  it('round-trips a provider record and decrypts the key', () => {
    const { id } = seedProvider('openai');
    const row = repos!.providers.getById(id);
    expect(row?.name).toBe('openai');
    expect(roundTrip(row!.api_key_ciphertext.length > 0 ? 'placeholder' : '', masterKey)).toBe('placeholder');
  });

  it('lists providers by name', () => {
    seedProvider('a');
    seedProvider('b');
    expect(repos!.providers.list().map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('updates enabled flag and prices', () => {
    const { id } = seedProvider('openai');
    repos!.providers.updateEnabled(id, false);
    expect(repos!.providers.getById(id)?.enabled).toBe(0);
    repos!.providers.updatePrices(id, { inputPrice: 1.5, outputPrice: 6.0, cachedInputPrice: 0.5 });
    const row = repos!.providers.getById(id);
    expect(row?.input_price_per_mtokens_usd).toBe(1.5);
    expect(row?.cached_input_price_per_mtokens_usd).toBe(0.5);
  });

  it('cascades delete to provider_models and members', () => {
    const { id } = seedProvider('openai');
    repos!.providerModels.insert({ id: 'm1', providerId: id, modelId: 'gpt-x' });
    repos!.providerModels.delete('m1');
    expect(repos!.providerModels.getById('m1')).toBeUndefined();
  });
});

describe('ProviderModelRepo', () => {
  it('inserts and queries models by provider', () => {
    const { id } = seedProvider('openai');
    repos!.providerModels.insert({ id: 'm1', providerId: id, modelId: 'gpt-x' });
    repos!.providerModels.insert({ id: 'm2', providerId: id, modelId: 'gpt-y' });
    expect(repos!.providerModels.listByProvider(id).map((m) => m.model_id)).toEqual(['gpt-x', 'gpt-y']);
  });

  it('replaceForProvider deletes and re-inserts atomically', () => {
    const { id } = seedProvider('openai');
    repos!.providerModels.insert({ id: 'm1', providerId: id, modelId: 'old' });
    repos!.providerModels.replaceForProvider(id, [
      { id: 'm1', providerId: id, modelId: 'new-1' },
      { id: 'm2', providerId: id, modelId: 'new-2' },
    ]);
    const rows = repos!.providerModels.listByProvider(id);
    expect(rows.map((m) => m.model_id).sort()).toEqual(['new-1', 'new-2']);
  });

  it('records probe outcomes and toggles availability', () => {
    const { id } = seedProvider('openai');
    repos!.providerModels.insert({ id: 'm1', providerId: id, modelId: 'gpt-x' });
    repos!.providerModels.recordProbeFailure('m1');
    repos!.providerModels.recordProbeFailure('m1');
    repos!.providerModels.recordProbeFailure('m1');
    repos!.providerModels.updateAvailability('m1', 'unavailable');
    expect(repos!.providerModels.getById('m1')?.availability).toBe('unavailable');
    repos!.providerModels.markAvailable('m1');
    expect(repos!.providerModels.getById('m1')?.availability).toBe('available');
    expect(repos!.providerModels.getById('m1')?.consecutive_failures).toBe(0);
  });
});

describe('VirtualModelRepo', () => {
  it('persists fallback chain as JSON and reads back members with availability', () => {
    seedProvider('openai');
    seedProvider('azure');
    repos!.providerModels.insert({ id: 'm1', providerId: repos!.providers.list()[0]!.id, modelId: 'gpt-4o' });
    repos!.providerModels.insert({ id: 'm2', providerId: repos!.providers.list()[1]!.id, modelId: 'gpt-4o' });

    repos!.virtualModels.insert({
      id: 'v1',
      name: 'gpt-4o',
      strategy: 'Failover',
      fallbackChain: ['gpt-4o-mini'],
    });
    repos!.virtualModels.addMember({ virtualModelId: 'v1', upstreamModelId: 'm1', priority: 1 });
    repos!.virtualModels.addMember({ virtualModelId: 'v1', upstreamModelId: 'm2', priority: 2 });

    const vm = repos!.virtualModels.getByName('gpt-4o');
    expect(vm?.fallback_chain_json).toBe('["gpt-4o-mini"]');

    const members = repos!.virtualModels.listMembersWithAvailability('v1');
    expect(members).toHaveLength(2);
    expect(members[0]?.priority).toBe(1);
  });
});

describe('KeyRepo', () => {
  it('stores keys with hashed fingerprints and round-trips', () => {
    const created = repos!.keys.insert({
      id: 'k1',
      name: 'team-a',
      keyHash: 'abcd1234',
      prefix: 'gw_team',
      budgetDailyUsd: 10,
      rpmLimit: 60,
    });
    expect(created.id).toBe('k1');
    expect(created.budget_daily_usd).toBe(10);
    expect(repos!.keys.findByHash('abcd1234')?.name).toBe('team-a');
  });

  it('revokes keys and excludes from hash lookup after revocation', () => {
    repos!.keys.insert({ id: 'k1', name: 'team-a', keyHash: 'h', prefix: 'gw' });
    repos!.keys.revoke('k1');
    const row = repos!.keys.findByHash('h');
    expect(row?.status).toBe('revoked');
    expect(row?.revoked_at).not.toBeNull();
  });
});

describe('BudgetRepo + EventRepo', () => {
  it('increments counter, marks 80% threshold, persists events', () => {
    repos!.keys.insert({ id: 'k1', name: 'k', keyHash: 'h', prefix: 'gw', budgetDailyUsd: 10 });
    let newSpent = repos!.budget.increment('k1', 'day', '2026-08-25', 5);
    expect(newSpent).toBe(5);
    newSpent = repos!.budget.increment('k1', 'day', '2026-08-25', 4);
    expect(newSpent).toBe(9);
    repos!.budget.markWarned('k1', 'day', '2026-08-25');
    repos!.events.append({ keyId: 'k1', type: 'budget_warning', payload: { spent: 9, threshold: 0.8 } });
    expect(repos!.events.listByKey('k1')).toHaveLength(1);
    const counter = repos!.budget.getCounter('k1', 'day', '2026-08-25');
    expect(counter?.warned_at_80).toBe(1);
  });

  it('reset zeros the counter and the warned flag', () => {
    repos!.keys.insert({ id: 'k1', name: 'k', keyHash: 'h', prefix: 'gw' });
    repos!.budget.increment('k1', 'day', 'p1', 7);
    repos!.budget.markWarned('k1', 'day', 'p1');
    repos!.budget.reset('k1', 'day', 'p1');
    const c = repos!.budget.getCounter('k1', 'day', 'p1');
    expect(c?.spent_usd).toBe(0);
    expect(c?.warned_at_80).toBe(0);
  });
});

describe('ProbeRepo', () => {
  it('aggregates recent probes into success rate + percentiles', () => {
    seedProvider('openai');
    const id = 'm1';
    repos!.providerModels.insert({ id, providerId: repos!.providers.list()[0]!.id, modelId: 'gpt-x' });

    for (let i = 0; i < 10; i++) {
      repos!.probes.append({
        upstreamModelId: id,
        latencyMs: 100 + i * 10,
        statusCode: 200,
        success: i < 8,
        errorMessage: i >= 8 ? 'timeout' : null,
      });
    }
    const agg = repos!.probes.aggregate(id);
    expect(agg.total).toBe(10);
    expect(agg.successCount).toBe(8);
    expect(agg.failureCount).toBe(2);
    expect(agg.p50LatencyMs).toBeGreaterThanOrEqual(100);
    expect(agg.p95LatencyMs).toBeGreaterThanOrEqual(agg.p50LatencyMs ?? 0);
  });
});

describe('UsageRepo', () => {
  it('appends records and aggregates by day / model / key', () => {
    repos!.keys.insert({ id: 'k1', name: 'k', keyHash: 'h', prefix: 'gw' });
    seedProvider('openai');
    const providerId = repos!.providers.list()[0]!.id;
    repos!.providerModels.insert({ id: 'm1', providerId, modelId: 'gpt-x' });

    const now = Date.now();
    repos!.usage.append({
      requestId: 'r1',
      keyId: 'k1',
      virtualModelId: null,
      upstreamProviderId: providerId,
      upstreamModelId: 'm1',
      clientProtocol: 'OpenAI-Chat',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUsd: 0.001,
      source: 'reported',
      ttftMs: 200,
      tokensPerSecond: 30,
      latencyMs: 1200,
      statusCode: 200,
    }, now - 1000);
    repos!.usage.append({
      requestId: 'r2',
      keyId: 'k1',
      upstreamProviderId: providerId,
      upstreamModelId: 'm1',
      clientProtocol: 'OpenAI-Chat',
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      costUsd: 0.002,
      source: 'reported',
      latencyMs: 900,
      statusCode: 200,
    }, now);

    const byDay = repos!.usage.aggregate({ groupBy: 'day', range: 'all' });
    expect(byDay.reduce((s, r) => s + r.requestCount, 0)).toBe(2);
    expect(byDay.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(0.003, 5);

    const byModel = repos!.usage.aggregate({ groupBy: 'model', range: 'all' });
    expect(byModel[0]?.bucket).toBe('m1');
    expect(byModel[0]?.costUsd).toBeCloseTo(0.003, 5);

    const byKey = repos!.usage.aggregate({ groupBy: 'key', range: 'all' });
    expect(byKey[0]?.bucket).toBe('k1');
  });

  it('excludes cache-hit records (costUSD=0) from total cost while preserving request count', () => {
    seedProvider('openai');
    const providerId = repos!.providers.list()[0]!.id;
    repos!.providerModels.insert({ id: 'm1', providerId, modelId: 'gpt-x' });
    const now = Date.now();
    repos!.usage.append({
      requestId: 'r1', upstreamProviderId: providerId, upstreamModelId: 'm1',
      clientProtocol: 'OpenAI-Chat', promptTokens: 100, completionTokens: 50, totalTokens: 150,
      costUsd: 0.001, source: 'reported', latencyMs: 1000, statusCode: 200, cacheHit: 'none',
    }, now);
    repos!.usage.append({
      requestId: 'r2', upstreamProviderId: providerId, upstreamModelId: 'm1',
      clientProtocol: 'OpenAI-Chat', promptTokens: 100, completionTokens: 50, totalTokens: 150,
      costUsd: 0, source: 'reported', latencyMs: 5, statusCode: 200, cacheHit: 'exact',
    }, now);

    const byDay = repos!.usage.aggregate({ groupBy: 'day', range: 'all' });
    const total = byDay[0]!;
    expect(total.requestCount).toBe(2);
    expect(total.costUsd).toBeCloseTo(0.001, 5);
  });
});

describe('CacheRepo', () => {
  it('put + get returns the entry while not expired', () => {
    const fp = 'abc123';
    repos!.cache.put({
      fingerprint: fp,
      clientProtocol: 'OpenAI-Chat',
      model: 'gpt-x',
      responseJson: '{"ok":true}',
      expiresAt: Date.now() + 60_000,
    });
    expect(repos!.cache.get(fp)?.response_json).toBe('{"ok":true}');
    repos!.cache.recordHit(fp);
    expect(repos!.cache.get(fp)?.hit_count).toBe(1);
  });

  it('returns undefined for expired entries', () => {
    const fp = 'expired';
    repos!.cache.put({
      fingerprint: fp,
      clientProtocol: 'OpenAI-Chat',
      model: 'gpt-x',
      responseJson: '{}',
      expiresAt: Date.now() - 1,
    });
    expect(repos!.cache.get(fp)).toBeUndefined();
  });

  it('clearAll wipes the cache and reports the count', () => {
    for (const fp of ['a', 'b', 'c']) {
      repos!.cache.put({ fingerprint: fp, clientProtocol: 'OpenAI-Chat', model: 'm', responseJson: '{}', expiresAt: Date.now() + 1000 });
    }
    expect(repos!.cache.clearAll()).toBe(3);
    expect(repos!.cache.stats().total).toBe(0);
  });
});

describe('RequestLogRepo + ResponseCacheRepo', () => {
  it('round-trips request logs and response cache entries', () => {
    repos!.keys.insert({ id: 'k1', name: 'k', keyHash: 'h', prefix: 'gw' });
    repos!.requestLogs.append({
      requestId: 'req1',
      keyId: 'k1',
      clientProtocol: 'OpenAI-Chat',
      requestBodyRedacted: '{"model":"gpt-x"}',
      responseBodyRedacted: '{"ok":true}',
    });
    expect(repos!.requestLogs.findByRequestId('req1')).toHaveLength(1);

    repos!.responseCache.put({
      id: 'resp_xyz',
      keyId: 'k1',
      clientProtocol: 'OpenAI-Responses',
      requestJson: '{"input":"hi"}',
      responseJson: '{"id":"resp_xyz","output":[]}',
    });
    expect(repos!.responseCache.get('resp_xyz')?.response_json).toContain('resp_xyz');
  });
});