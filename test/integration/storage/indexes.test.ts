import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDatabase, closeDatabase, type Database } from '@/storage/db.js';
import { Repositories } from '@/storage/index.js';
import { AvailabilityCache, VirtualModelIndex, UpstreamModelIndex } from '@/storage/indexes.js';
import { encrypt } from '@/crypto/aes.js';

let workDir: string;
let db: Database | null = null;
let repos: Repositories | null = null;
const masterKey = randomBytes(32);

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-gateway-idx-'));
  db = openDatabase(join(workDir, 'gateway.db'));
  repos = new Repositories(db);
});

afterEach(() => {
  if (db) closeDatabase(db);
  rmSync(workDir, { recursive: true, force: true });
});

function seedProviderWithModel(providerName: string, modelId: string): { providerId: string; modelRowId: string } {
  const blob = encrypt('sk-test', masterKey);
  const providerId = 'p-' + providerName;
  repos!.providers.insert({
    id: providerId,
    name: providerName,
    protocol: 'OpenAI',
    baseUrl: 'https://api.example.com/v1',
    apiKeyCiphertext: blob.ciphertext,
    apiKeyIv: blob.iv,
    apiKeyTag: blob.tag,
  });
  const modelRowId = 'm-' + providerName + '-' + modelId;
  repos!.providerModels.insert({ id: modelRowId, providerId, modelId });
  return { providerId, modelRowId };
}

describe('AvailabilityCache', () => {
  it('starts every model as available', () => {
    seedProviderWithModel('a', 'gpt-x');
    const cache = AvailabilityCache.fromRepositories(repos!);
    expect(cache.isRoutable(repos!.providerModels.listEnabled()[0]!.id)).toBe(true);
  });

  it('recordFailure 3 times transitions available → unavailable', () => {
    const { modelRowId } = seedProviderWithModel('a', 'gpt-x');
    const cache = AvailabilityCache.fromRepositories(repos!);
    cache.recordFailure(modelRowId, 3);
    cache.recordFailure(modelRowId, 3);
    cache.recordFailure(modelRowId, 3);
    expect(cache.get(modelRowId)?.status).toBe('unavailable');
    expect(cache.isRoutable(modelRowId)).toBe(false);
  });

  it('recordSuccess restores from unavailable after threshold (default 2)', () => {
    const { modelRowId } = seedProviderWithModel('a', 'gpt-x');
    const cache = new AvailabilityCache();
    cache.set(modelRowId, { ...cache.get(modelRowId) ?? { status: 'unavailable', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 0, latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now() }, status: 'unavailable' });
    cache.recordSuccess(modelRowId, 100);
    expect(cache.get(modelRowId)?.status).toBe('unavailable');
    cache.recordSuccess(modelRowId, 100);
    expect(cache.get(modelRowId)?.status).toBe('available');
    expect(cache.get(modelRowId)?.unavailableSince).toBeNull();
  });

  it('updateSuccessRate transitions degraded when < 0.8', () => {
    const { modelRowId } = seedProviderWithModel('a', 'gpt-x');
    const cache = AvailabilityCache.fromRepositories(repos!);
    cache.updateSuccessRate(modelRowId, 0.5);
    expect(cache.get(modelRowId)?.status).toBe('degraded');
    cache.updateSuccessRate(modelRowId, 0.95);
    expect(cache.get(modelRowId)?.status).toBe('available');
  });
});

describe('VirtualModelIndex', () => {
  it('resolve() returns entry for known model', () => {
    const { modelRowId } = seedProviderWithModel('openai', 'gpt-4o');
    repos!.virtualModels.insert({
      id: 'v1',
      name: 'gpt-4o',
      strategy: 'RoundRobin',
      fallbackChain: ['gpt-4o-mini'],
    });
    repos!.virtualModels.addMember({ virtualModelId: 'v1', upstreamModelId: modelRowId });

    const idx = VirtualModelIndex.fromRepositories(repos!);
    const entry = idx.resolve('gpt-4o');
    expect(entry?.strategy).toBe('RoundRobin');
    expect(entry?.fallbackChain).toEqual(['gpt-4o-mini']);
    expect(entry?.members).toHaveLength(1);
  });

  it('resolve() returns undefined for unknown model', () => {
    const idx = VirtualModelIndex.fromRepositories(repos!);
    expect(idx.resolve('nope')).toBeUndefined();
  });

  it('nextRoundRobinCounter increments monotonically', () => {
    seedProviderWithModel('openai', 'gpt-4o');
    repos!.virtualModels.insert({ id: 'v1', name: 'gpt-4o', strategy: 'RoundRobin' });
    const idx = VirtualModelIndex.fromRepositories(repos!);
    expect(idx.nextRoundRobinCounter('v1')).toBe(1);
    expect(idx.nextRoundRobinCounter('v1')).toBe(2);
    expect(idx.nextRoundRobinCounter('v1')).toBe(3);
  });

  it('corrupt fallback_chain_json degrades to empty chain without throwing', () => {
    const { modelRowId } = seedProviderWithModel('openai', 'gpt-4o');
    repos!.virtualModels.insert({
      id: 'v1',
      name: 'gpt-4o',
      strategy: 'Failover',
      fallbackChain: null,
    });
    // Manually corrupt the json
    const db2 = repos!.raw();
    db2.prepare(`UPDATE virtual_models SET fallback_chain_json = ? WHERE id = ?`).run('{not-json', 'v1');
    repos!.virtualModels.addMember({ virtualModelId: 'v1', upstreamModelId: modelRowId });
    const idx = VirtualModelIndex.fromRepositories(repos!);
    const entry = idx.resolve('gpt-4o');
    expect(entry?.fallbackChain).toEqual([]);
  });
});

describe('UpstreamModelIndex', () => {
  it('lookup() returns all providers offering the same model id', () => {
    const { providerId } = seedProviderWithModel('openai', 'gpt-4o');
    const blob2 = encrypt('sk-test', masterKey);
    repos!.providers.insert({
      id: 'p-azure',
      name: 'azure',
      protocol: 'OpenAI-Compatible',
      baseUrl: 'https://example.openai.azure.com',
      apiKeyCiphertext: blob2.ciphertext,
      apiKeyIv: blob2.iv,
      apiKeyTag: blob2.tag,
    });
    repos!.providerModels.insert({ id: 'm-azure-gpt-4o', providerId: 'p-azure', modelId: 'gpt-4o' });

    const idx = UpstreamModelIndex.fromRepositories(repos!);
    const entries = idx.lookupByName('gpt-4o');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.providerName).sort()).toEqual(['azure', 'openai']);
    expect(providerId).toBe('p-openai');
  });

  it('removeProvider drops all entries for that provider', () => {
    seedProviderWithModel('openai', 'gpt-4o');
    const idx = UpstreamModelIndex.fromRepositories(repos!);
    expect(idx.lookupByName('gpt-4o')).toHaveLength(1);
    idx.removeProvider('p-openai');
    expect(idx.lookupByName('gpt-4o')).toHaveLength(0);
  });
});