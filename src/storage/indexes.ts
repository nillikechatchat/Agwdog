/**
 * In-memory indexes kept in sync with SQLite for hot-path lookups.
 *
 * Built once at boot from `Repositories`, mutated synchronously by every Admin
 * API write that affects routing/availability, and read by the Router on every
 * incoming request. Updates are O(1) and visible to the router within the same
 * tick (Correctness Property 13: availability write-propagation ≤ 100ms).
 */

import type {
  Availability,
  ProviderModelRow,
  RoutingStrategy,
  VirtualModelMemberRow,
  VirtualModelRow,
} from './types.js';
import type { Repositories } from './index.js';

export interface AvailabilityEntry {
  status: Availability;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  recentSuccessRate: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  unavailableSince: number | null;
  lastUpdatedAt: number;
}

export interface VirtualModelIndexEntry {
  id: string;
  name: string;
  strategy: RoutingStrategy;
  latencyWindow: number;
  failureThreshold: number;
  recoveryThreshold: number;
  maxRetries: number;
  fallbackChain: string[];
  members: VirtualModelMemberRow[];
}

export interface UpstreamModelIndexEntry {
  providerId: string;
  providerName: string;
  providerProtocol: string;
  modelId: string;
  availability: Availability;
}

/**
 * Three-state machine in-memory cache for upstream availability.
 *
 * Promotion/demotion rules mirror `ProbeRepo.recordProbe*` and the admin-API
 * mutation paths. Defaults are conservative (all routes start `available`).
 */
export class AvailabilityCache {
  private readonly entries = new Map<string, AvailabilityEntry>();

  /** Load availability for every model currently in the database. */
  static fromRepositories(repos: Repositories): AvailabilityCache {
    const cache = new AvailabilityCache();
    for (const m of repos.providerModels.listEnabled()) {
      cache.entries.set(m.id, AvailabilityCache.fromRow(m));
    }
    return cache;
  }

  static fromRow(m: ProviderModelRow): AvailabilityEntry {
    return {
      status: m.availability,
      consecutiveFailures: m.consecutive_failures,
      consecutiveSuccesses: m.consecutive_successes,
      recentSuccessRate: 1.0,
      latencyMsP50: m.latency_ms_p50,
      latencyMsP95: m.latency_ms_p95,
      unavailableSince: m.unavailable_since,
      lastUpdatedAt: Date.now(),
    };
  }

  get(upstreamModelId: string): AvailabilityEntry | undefined {
    return this.entries.get(upstreamModelId);
  }

  /** Returns true if the entry is at least "degraded" (i.e., should still be eligible). */
  isRoutable(upstreamModelId: string): boolean {
    const e = this.entries.get(upstreamModelId);
    return e ? e.status !== 'unavailable' : true;
  }

  set(upstreamModelId: string, entry: AvailabilityEntry): void {
    this.entries.set(upstreamModelId, entry);
  }

  recordSuccess(upstreamModelId: string, latencyMs: number | null, now = Date.now()): void {
    const e = this.ensure(upstreamModelId);
    e.consecutiveSuccesses += 1;
    e.consecutiveFailures = 0;
    e.lastUpdatedAt = now;
    if (latencyMs !== null) {
      e.latencyMsP50 = e.latencyMsP50 === null ? latencyMs : Math.round(e.latencyMsP50 * 0.7 + latencyMs * 0.3);
    }
    if (e.status === 'unavailable' && e.consecutiveSuccesses >= 2) {
      e.status = 'available';
      e.unavailableSince = null;
    } else if (e.status === 'degraded' && e.recentSuccessRate >= 0.8) {
      e.status = 'available';
    }
  }

  recordFailure(upstreamModelId: string, failureThreshold = 3, now = Date.now()): void {
    const e = this.ensure(upstreamModelId);
    e.consecutiveFailures += 1;
    e.consecutiveSuccesses = 0;
    e.lastUpdatedAt = now;
    if (e.status === 'available' && e.consecutiveFailures >= failureThreshold) {
      e.status = 'unavailable';
      e.unavailableSince = now;
    } else if (e.status === 'available' && e.recentSuccessRate < 0.8) {
      e.status = 'degraded';
    } else if (e.status === 'degraded' && e.consecutiveFailures >= failureThreshold) {
      e.status = 'unavailable';
      e.unavailableSince = now;
    }
  }

  updateSuccessRate(upstreamModelId: string, successRate: number, now = Date.now()): void {
    const e = this.ensure(upstreamModelId);
    e.recentSuccessRate = successRate;
    e.lastUpdatedAt = now;
    if (e.status === 'available' && successRate < 0.8) e.status = 'degraded';
    if (e.status === 'degraded' && successRate >= 0.8) e.status = 'available';
  }

  /** Add a brand-new model to the cache. */
  add(upstreamModelId: string): void {
    if (!this.entries.has(upstreamModelId)) {
      this.entries.set(upstreamModelId, AvailabilityCache.fresh());
    }
  }

  /** Remove a model (e.g. provider deletion). */
  remove(id: string): void {
    this.entries.delete(id);
  }

  all(): ReadonlyMap<string, AvailabilityEntry> {
    return this.entries;
  }

  private ensure(upstreamModelId: string): AvailabilityEntry {
    let e = this.entries.get(upstreamModelId);
    if (!e) {
      e = AvailabilityCache.fresh();
      this.entries.set(upstreamModelId, e);
    }
    return e;
  }

  private static fresh(): AvailabilityEntry {
    return {
      status: 'available',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      recentSuccessRate: 1.0,
      latencyMsP50: null,
      latencyMsP95: null,
      unavailableSince: null,
      lastUpdatedAt: Date.now(),
    };
  }
}

export class VirtualModelIndex {
  private readonly byName = new Map<string, VirtualModelIndexEntry>();
  private readonly roundRobinCounters = new Map<string, number>();

  static fromRepositories(repos: Repositories): VirtualModelIndex {
    const idx = new VirtualModelIndex();
    for (const vm of repos.virtualModels.list()) {
      idx.add(VirtualModelIndex.fromRow(vm, repos.virtualModels.listMembers(vm.id)));
    }
    return idx;
  }

  static fromRow(row: VirtualModelRow, members: VirtualModelMemberRow[]): VirtualModelIndexEntry {
    let fallbackChain: string[] = [];
    if (row.fallback_chain_json) {
      try {
        const parsed: unknown = JSON.parse(row.fallback_chain_json);
        if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
          fallbackChain = parsed;
        }
      } catch {
        // Corrupt JSON in DB; fall back to empty chain rather than crashing routing.
      }
    }
    return {
      id: row.id,
      name: row.name,
      strategy: row.strategy,
      latencyWindow: row.latency_window ?? 5,
      failureThreshold: row.failure_threshold ?? 3,
      recoveryThreshold: row.recovery_threshold ?? 2,
      maxRetries: row.max_retries ?? 2,
      fallbackChain,
      members: members.filter((m) => m.enabled === 1).sort((a, b) => a.priority - b.priority),
    };
  }

  add(entry: VirtualModelIndexEntry): void {
    this.byName.set(entry.name, entry);
  }

  remove(idOrName: string): void {
    if (this.byName.has(idOrName)) {
      this.byName.delete(idOrName);
      return;
    }
    for (const [k, v] of this.byName) {
      if (v.id === idOrName) this.byName.delete(k);
    }
    this.roundRobinCounters.delete(idOrName);
  }

  /** Resolve a client-facing model name to its virtual-model entry, if any. */
  resolve(name: string): VirtualModelIndexEntry | undefined {
    return this.byName.get(name);
  }

  all(): ReadonlyMap<string, VirtualModelIndexEntry> {
    return this.byName;
  }

  nextRoundRobinCounter(vmId: string): number {
    const next = (this.roundRobinCounters.get(vmId) ?? 0) + 1;
    this.roundRobinCounters.set(vmId, next);
    return next;
  }
}

/**
 * Reverse index from upstream `model_id` to every ProviderModel row that
 * advertises it (used by `/v1/models` and dry-run).
 */
export class UpstreamModelIndex {
  private readonly byModelId = new Map<string, UpstreamModelIndexEntry[]>();

  static fromRepositories(repos: Repositories): UpstreamModelIndex {
    const idx = new UpstreamModelIndex();
    for (const p of repos.providers.list()) {
      for (const m of repos.providerModels.listByProvider(p.id)) {
        idx.add({
          providerId: p.id,
          providerName: p.name,
          providerProtocol: p.protocol,
          modelId: m.model_id,
          availability: m.availability,
        });
      }
    }
    return idx;
  }

  add(entry: UpstreamModelIndexEntry): void {
    const list = this.byModelId.get(entry.modelId) ?? [];
    // Avoid duplicates if a provider/model combination is added twice.
    if (!list.some((e) => e.providerId === entry.providerId)) {
      list.push(entry);
    }
    this.byModelId.set(entry.modelId, list);
  }

  removeProvider(providerId: string): void {
    for (const [k, list] of this.byModelId) {
      const filtered = list.filter((e) => e.providerId !== providerId);
      if (filtered.length === 0) this.byModelId.delete(k);
      else this.byModelId.set(k, filtered);
    }
  }

  lookup(modelId: string): UpstreamModelIndexEntry[] {
    return this.byModelId.get(modelId) ?? [];
  }
}