import { describe, it, expect } from 'vitest';
import {
  route,
  tryOne,
  RoutingError,
  type RouterDeps,
} from '../../../src/router/strategies.js';
import { dryRunRoute } from '../../../src/router/dry-run.js';
import {
  AvailabilityCache,
  VirtualModelIndex,
  UpstreamModelIndex,
  type UpstreamModelIndexEntry,
  type VirtualModelIndexEntry,
} from '../../../src/storage/indexes.js';
import type { VirtualModelMemberRow } from '../../../src/storage/types.js';

function member(vmId: string, upstreamId: string, priority: number, weight = 1): VirtualModelMemberRow {
  return {
    virtual_model_id: vmId,
    upstream_model_id: upstreamId,
    weight,
    priority,
    enabled: 1,
    joined_at: 0,
  };
}

function vmEntry(
  id: string,
  name: string,
  strategy: VirtualModelIndexEntry['strategy'],
  members: VirtualModelMemberRow[],
  fallbackChain: string[] = [],
): VirtualModelIndexEntry {
  return {
    id,
    name,
    strategy,
    latencyWindow: 5,
    failureThreshold: 3,
    recoveryThreshold: 2,
    maxRetries: 2,
    fallbackChain,
    members,
  };
}

function upstream(providerId: string, modelId: string, protocol = 'OpenAI-Chat'): UpstreamModelIndexEntry {
  return { providerId, providerName: providerId, providerProtocol: protocol, modelId, upstreamModelName: modelId, availability: 'available' };
}

function buildDeps(opts: {
  vms: VirtualModelIndexEntry[];
  upstreams: UpstreamModelIndexEntry[];
  counterStart?: number;
  rand?: () => number;
}): RouterDeps {
  const vms = new VirtualModelIndex();
  for (const v of opts.vms) vms.add(v);
  const ups = new UpstreamModelIndex();
  for (const u of opts.upstreams) ups.add(u);
  const availability = new AvailabilityCache();
  for (const u of opts.upstreams) availability.set(u.modelId, {
    status: u.availability,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    recentSuccessRate: 1.0,
    latencyMsP50: null,
    latencyMsP95: null,
    unavailableSince: null,
    lastUpdatedAt: 0,
  });
  let counter = opts.counterStart ?? 0;
  const deps: RouterDeps = {
    virtualModels: vms,
    upstreamModels: ups,
    availability,
    nextCounter: () => ++counter,
  };
  if (opts.rand) deps.random = opts.rand;
  return deps;
}

describe('route — model resolution', () => {
  it('throws not_found for an unknown model', () => {
    const deps = buildDeps({ vms: [], upstreams: [] });
    expect(() => route({ modelId: 'unknown' }, deps)).toThrow(RoutingError);
    try { route({ modelId: 'unknown' }, deps); } catch (e) {
      expect((e as RoutingError).reason).toBe('not_found');
    }
  });

  it('returns the only routable member when there is just one', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'gpt-4o', 'Failover', [member('vm1', 'm1', 0)])],
      upstreams: [upstream('p1', 'm1')],
    });
    const r = route({ modelId: 'gpt-4o' }, deps);
    expect(r.upstream.modelId).toBe('m1');
    expect(r.depth).toBe(0);
  });
});

describe('RoundRobin strategy', () => {
  it('rotates through members in stable order', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'rot', 'RoundRobin', [member('vm1', 'm1', 0), member('vm1', 'm2', 1), member('vm1', 'm3', 2)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2'), upstream('p3', 'm3')],
    });
    const picks = [0, 1, 2, 3, 4, 5].map(() => route({ modelId: 'rot' }, deps).upstream.modelId);
    expect(picks).toEqual(['m1', 'm2', 'm3', 'm1', 'm2', 'm3']);
  });
});

describe('WeightedRandom strategy', () => {
  it('eventually hits a high-weight member more often than a low-weight one', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'wr', 'WeightedRandom', [member('vm1', 'm1', 0, 10), member('vm1', 'm2', 1, 1)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
      rand: Math.random,
    });
    const counts = { m1: 0, m2: 0 };
    for (let i = 0; i < 1000; i++) {
      const m = route({ modelId: 'wr' }, deps).upstream.modelId;
      counts[m as 'm1' | 'm2']++;
    }
    expect(counts.m1).toBeGreaterThan(counts.m2 * 5);
  });

  it('respects a seeded random source', () => {
    let seed = 0.5; // 0.5 * total (1+1) = 1.0 -> cumulative crosses 1 at index 1 -> m2
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'wr', 'WeightedRandom', [member('vm1', 'm1', 0, 1), member('vm1', 'm2', 1, 1)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
      rand: () => seed,
    });
    const m = route({ modelId: 'wr' }, deps).upstream.modelId;
    expect(m).toBe('m2');
  });

  it('falls back to the first member when all weights are zero', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'wr', 'WeightedRandom', [member('vm1', 'm1', 0, 0), member('vm1', 'm2', 1, 0)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    expect(route({ modelId: 'wr' }, deps).upstream.modelId).toBe('m1');
  });
});

describe('Failover strategy', () => {
  it('always picks the highest-priority routable member', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'fo', 'Failover', [member('vm1', 'm1', 0), member('vm1', 'm2', 1), member('vm1', 'm3', 2)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2'), upstream('p3', 'm3')],
    });
    expect(route({ modelId: 'fo' }, deps).upstream.modelId).toBe('m1');
  });

  it('skips unavailable members', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'fo', 'Failover', [member('vm1', 'm1', 0), member('vm1', 'm2', 1)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    deps.availability.set('m1', {
      status: 'unavailable',
      consecutiveFailures: 5,
      consecutiveSuccesses: 0,
      recentSuccessRate: 0.0,
      latencyMsP50: null,
      latencyMsP95: null,
      unavailableSince: Date.now(),
      lastUpdatedAt: Date.now(),
    });
    expect(route({ modelId: 'fo' }, deps).upstream.modelId).toBe('m2');
  });

  it('returns null (chain_exhausted later) when every member is unavailable', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'fo', 'Failover', [member('vm1', 'm1', 0)])],
      upstreams: [upstream('p1', 'm1')],
    });
    deps.availability.set('m1', {
      status: 'unavailable',
      consecutiveFailures: 5,
      consecutiveSuccesses: 0,
      recentSuccessRate: 0.0,
      latencyMsP50: null,
      latencyMsP95: null,
      unavailableSince: Date.now(),
      lastUpdatedAt: Date.now(),
    });
    expect(() => route({ modelId: 'fo' }, deps)).toThrow(RoutingError);
  });
});

describe('LowestLatency strategy', () => {
  it('picks the member with the lowest p50 latency', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'll', 'LowestLatency', [member('vm1', 'm1', 0), member('vm1', 'm2', 1), member('vm1', 'm3', 2)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2'), upstream('p3', 'm3')],
    });
    deps.availability.set('m1', { status: 'available', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 1, latencyMsP50: 800, latencyMsP95: null, unavailableSince: null, lastUpdatedAt: 0 });
    deps.availability.set('m2', { status: 'available', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 1, latencyMsP50: 200, latencyMsP95: null, unavailableSince: null, lastUpdatedAt: 0 });
    deps.availability.set('m3', { status: 'available', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 1, latencyMsP50: 500, latencyMsP95: null, unavailableSince: null, lastUpdatedAt: 0 });
    expect(route({ modelId: 'll' }, deps).upstream.modelId).toBe('m2');
  });

  it('treats missing latency as +Infinity (last resort)', () => {
    const deps = buildDeps({
      vms: [vmEntry('vm1', 'll', 'LowestLatency', [member('vm1', 'm1', 0), member('vm1', 'm2', 1)])],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    deps.availability.set('m1', { status: 'available', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 1, latencyMsP50: null, latencyMsP95: null, unavailableSince: null, lastUpdatedAt: 0 });
    deps.availability.set('m2', { status: 'available', consecutiveFailures: 0, consecutiveSuccesses: 0, recentSuccessRate: 1, latencyMsP50: 200, latencyMsP95: null, unavailableSince: null, lastUpdatedAt: 0 });
    expect(route({ modelId: 'll' }, deps).upstream.modelId).toBe('m2');
  });
});

describe('Fallback Chain', () => {
  it('walks to the next virtual model when the primary has no routable member', () => {
    const deps = buildDeps({
      vms: [
        vmEntry('vm1', 'primary', 'Failover', [member('vm1', 'm1', 0)], ['fallback']),
        vmEntry('vm2', 'fallback', 'Failover', [member('vm2', 'm2', 0)]),
      ],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    deps.availability.set('m1', {
      status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
      latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
    });
    const r = route({ modelId: 'primary' }, deps);
    expect(r.upstream.modelId).toBe('m2');
    expect(r.virtualModel.id).toBe('vm2');
    expect(r.depth).toBe(1);
  });

  it('skips non-existent fallbacks gracefully', () => {
    const deps = buildDeps({
      vms: [
        vmEntry('vm1', 'primary', 'Failover', [member('vm1', 'm1', 0)], ['doesnotexist', 'fallback']),
        vmEntry('vm2', 'fallback', 'Failover', [member('vm2', 'm2', 0)]),
      ],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    deps.availability.set('m1', {
      status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
      latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
    });
    const r = route({ modelId: 'primary' }, deps);
    expect(r.virtualModel.id).toBe('vm2');
    expect(r.depth).toBe(2);
  });

  it('throws chain_exhausted when every link is unavailable', () => {
    const deps = buildDeps({
      vms: [
        vmEntry('vm1', 'primary', 'Failover', [member('vm1', 'm1', 0)], ['fallback']),
        vmEntry('vm2', 'fallback', 'Failover', [member('vm2', 'm2', 0)]),
      ],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2')],
    });
    for (const id of ['m1', 'm2']) {
      deps.availability.set(id, {
        status: 'unavailable', consecutiveFailures: 5, consecutiveSuccesses: 0, recentSuccessRate: 0,
        latencyMsP50: null, latencyMsP95: null, unavailableSince: Date.now(), lastUpdatedAt: Date.now(),
      });
    }
    try {
      route({ modelId: 'primary' }, deps);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingError);
      expect((e as RoutingError).reason).toBe('chain_exhausted');
      expect((e as RoutingError).attempts.length).toBe(2);
    }
  });
});

describe('tryOne', () => {
  it('returns null for a virtual model with no members', () => {
    const deps = buildDeps({ vms: [], upstreams: [] });
    expect(tryOne(vmEntry('vm1', 'x', 'Failover', []), 0, deps)).toBeNull();
  });
});

describe('dryRunRoute', () => {
  it('returns the same decision as route() and lists the remaining fallbacks', () => {
    const deps = buildDeps({
      vms: [
        vmEntry('vm1', 'p', 'Failover', [member('vm1', 'm1', 0)], ['f1', 'f2']),
        vmEntry('vm2', 'f1', 'Failover', [member('vm2', 'm2', 0)]),
        vmEntry('vm3', 'f2', 'Failover', [member('vm3', 'm3', 0)]),
      ],
      upstreams: [upstream('p1', 'm1'), upstream('p2', 'm2'), upstream('p3', 'm3')],
    });
    const r = dryRunRoute('p', deps);
    expect(r.decision.upstream.modelId).toBe('m1');
    expect(r.decision.depth).toBe(0);
    expect(r.alternatives).toEqual(['f1', 'f2']);
  });
});
