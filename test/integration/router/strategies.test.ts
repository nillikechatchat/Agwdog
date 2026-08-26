import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import { route, RoutingError, type RouterDeps } from '../../../src/router/strategies.js';
import { dryRunRoute } from '../../../src/router/dry-run.js';
import {
  AvailabilityCache,
  VirtualModelIndex,
  UpstreamModelIndex,
} from '../../../src/storage/indexes.js';
import type { Repositories } from '../../../src/storage/index.js';
import type { ProviderRepo } from '../../../src/storage/repos/providers.js';
import type { ProviderModelRepo } from '../../../src/storage/repos/provider-models.js';
import type { VirtualModelRepo } from '../../../src/storage/repos/virtual-models.js';

let h: TestDbHandle;
let repos: Repositories;
let providers: ProviderRepo;
let pms: ProviderModelRepo;
let vms: VirtualModelRepo;

beforeEach(() => {
  h = openTestDatabase();
  repos = h.repos;
  providers = repos.providers;
  pms = repos.providerModels;
  vms = repos.virtualModels;
});

afterEach(() => h.cleanup());

function setupDeps(opts: {
  models: Array<{ providerName: string; protocol: 'OpenAI' | 'OpenAI-Compatible' | 'Anthropic' | 'Gemini' | 'Doubao' | 'Wenxin'; modelId: string; enabled?: boolean; availability?: 'available' | 'degraded' | 'unavailable' }>;
  vms: Array<{ id: string; name: string; strategy: 'RoundRobin' | 'WeightedRandom' | 'Failover' | 'LowestLatency'; members: Array<{ upstreamModelId: string; weight: number; priority: number }>; fallbackChain?: string[] }>;
}): RouterDeps {
  for (const m of opts.models) {
    const providerId = `p-${m.providerName}`;
    providers.insert({
      id: providerId,
      name: m.providerName,
      protocol: m.protocol,
      baseUrl: 'https://example.com',
      apiKeyCiphertext: '',
      apiKeyIv: '',
      apiKeyTag: '',
    });
    pms.insert({
      id: `pm-${m.providerName}-${m.modelId}`,
      providerId,
      modelId: m.modelId,
      enabled: m.enabled ?? true,
    });
    if (m.availability && m.availability !== 'available') {
      pms.updateAvailability(`pm-${m.providerName}-${m.modelId}`, m.availability);
    }
  }
  // Create virtual models + members
  for (const v of opts.vms) {
    vms.insert({
      id: v.id,
      name: v.name,
      strategy: v.strategy,
      fallbackChain: v.fallbackChain ?? [],
    });
    for (const m of v.members) {
      vms.addMember({
        virtualModelId: v.id,
        upstreamModelId: m.upstreamModelId,
        weight: m.weight,
        priority: m.priority,
      });
    }
  }
  const vmi = VirtualModelIndex.fromRepositories(repos);
  const umi = UpstreamModelIndex.fromRepositories(repos);
  const ac = AvailabilityCache.fromRepositories(repos);
  let counter = 0;
  return {
    virtualModels: vmi,
    upstreamModels: umi,
    availability: ac,
    nextCounter: () => ++counter,
  };
}

describe('Router with real DB + Indexes', () => {
  it('routes a model with one upstream to that upstream', () => {
    const deps = setupDeps({
      models: [{ providerName: 'p1', protocol: 'OpenAI', modelId: 'gpt-4o' }],
      vms: [{ id: 'vm1', name: 'gpt-4o', strategy: 'Failover', members: [{ upstreamModelId: 'pm-p1-gpt-4o', weight: 1, priority: 0 }] }],
    });
    const r = route({ modelId: 'gpt-4o' }, deps);
    expect(r.upstream.upstreamModelName).toBe('gpt-4o');
    expect(r.upstream.providerId).toBe('p-p1');
  });

  it('round-robins across three upstreams', () => {
    const deps = setupDeps({
      models: [
        { providerName: 'p1', protocol: 'OpenAI', modelId: 'm1' },
        { providerName: 'p2', protocol: 'OpenAI', modelId: 'm2' },
        { providerName: 'p3', protocol: 'OpenAI', modelId: 'm3' },
      ],
      vms: [{
        id: 'vm1', name: 'mix', strategy: 'RoundRobin',
        members: [
          { upstreamModelId: 'pm-p1-m1', weight: 1, priority: 0 },
          { upstreamModelId: 'pm-p2-m2', weight: 1, priority: 1 },
          { upstreamModelId: 'pm-p3-m3', weight: 1, priority: 2 },
        ],
      }],
    });
    const picks = Array.from({ length: 6 }, () => route({ modelId: 'mix' }, deps).upstream.upstreamModelName);
    expect(picks).toEqual(['m1', 'm2', 'm3', 'm1', 'm2', 'm3']);
  });

  it('falls back across virtual models when the primary upstream is unavailable', () => {
    const deps = setupDeps({
      models: [
        { providerName: 'p1', protocol: 'OpenAI', modelId: 'm1', availability: 'unavailable' },
        { providerName: 'p2', protocol: 'OpenAI', modelId: 'm2' },
      ],
      vms: [
        { id: 'vm1', name: 'primary', strategy: 'Failover', members: [{ upstreamModelId: 'pm-p1-m1', weight: 1, priority: 0 }], fallbackChain: ['backup'] },
        { id: 'vm2', name: 'backup', strategy: 'Failover', members: [{ upstreamModelId: 'pm-p2-m2', weight: 1, priority: 0 }] },
      ],
    });
    // Override the availability cache so m1 starts as unavailable.
    deps.availability.set('pm-p1-m1', {
      status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
      latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
    });
    const r = route({ modelId: 'primary' }, deps);
    expect(r.virtualModel.id).toBe('vm2');
    expect(r.upstream.upstreamModelName).toBe('m2');
  });

  it('throws RoutingError when the model is unknown', () => {
    const deps = setupDeps({ models: [], vms: [] });
    expect(() => route({ modelId: 'nope' }, deps)).toThrow(RoutingError);
  });

  it('throws chain_exhausted when the entire chain is down', () => {
    const deps = setupDeps({
      models: [
        { providerName: 'p1', protocol: 'OpenAI', modelId: 'm1' },
        { providerName: 'p2', protocol: 'OpenAI', modelId: 'm2' },
      ],
      vms: [
        { id: 'vm1', name: 'p', strategy: 'Failover', members: [{ upstreamModelId: 'pm-p1-m1', weight: 1, priority: 0 }], fallbackChain: ['b'] },
        { id: 'vm2', name: 'b', strategy: 'Failover', members: [{ upstreamModelId: 'pm-p2-m2', weight: 1, priority: 0 }] },
      ],
    });
    deps.availability.set('pm-p1-m1', {
      status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
      latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
    });
    deps.availability.set('pm-p2-m2', {
      status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
      latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
    });
    expect(() => route({ modelId: 'p' }, deps)).toThrow(RoutingError);
  });

  it('dry-run does not mutate the round-robin counter', () => {
    const deps = setupDeps({
      models: [
        { providerName: 'p1', protocol: 'OpenAI', modelId: 'm1' },
        { providerName: 'p2', protocol: 'OpenAI', modelId: 'm2' },
      ],
      vms: [{ id: 'vm1', name: 'mix', strategy: 'RoundRobin',
        members: [
          { upstreamModelId: 'pm-p1-m1', weight: 1, priority: 0 },
          { upstreamModelId: 'pm-p2-m2', weight: 1, priority: 1 },
        ] }],
    });
    dryRunRoute('mix', deps);
    dryRunRoute('mix', deps);
    dryRunRoute('mix', deps);
    const pick = route({ modelId: 'mix' }, deps).upstream.upstreamModelName;
    expect(pick).toBe('m1');
  });
});
