import type { AvailabilityCache } from '../storage/indexes.js';
import type { UpstreamModelIndex, UpstreamModelIndexEntry, VirtualModelIndex, VirtualModelIndexEntry } from '../storage/indexes.js';
import type { RoutingStrategy, VirtualModelMemberRow } from '../storage/types.js';

/** A routing decision: which provider/model to call, in which virtual model it lives. */
export interface RoutingDecision {
  /** The virtual model entry that produced the pick (may differ from the originally requested one when a Fallback Chain fires). */
  virtualModel: VirtualModelIndexEntry;
  /** The upstream provider + model that should handle the request. */
  upstream: UpstreamModelIndexEntry;
  /** Position in the chain (0 = primary, 1+ = fallback). */
  depth: number;
}

export interface RouteRequestInput {
  /** Client-facing model name (e.g. "gpt-4o" or a custom virtual model name). */
  modelId: string;
  /** When true, the router must still return a decision but no upstream call will actually be made. */
  dryRun?: boolean;
}

export interface RouterDeps {
  virtualModels: VirtualModelIndex;
  upstreamModels: UpstreamModelIndex;
  availability: AvailabilityCache;
  /**
   * Pull the next round-robin counter for a virtual model id. Production wires this
   * to the in-memory index; tests pass a deterministic function.
   */
  nextCounter: (vmId: string) => number;
  /** Source of randomness for the WeightedRandom strategy; injectable for tests. */
  random?: () => number;
}

export class RoutingError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly reason: 'not_found' | 'no_routable_member' | 'chain_exhausted',
    public readonly attempts: VirtualModelIndexEntry[],
  ) {
    super(`Routing failed for model '${modelId}': ${reason}`);
  }
}

/**
 * Resolve a client model id to a single (virtualModel, upstream) pair, honoring
 * the virtual model's RoutingStrategy. When the chosen candidate is `unavailable`
 * (per the AvailabilityCache), the router tries the next member; if the entire
 * primary virtual model is exhausted, the Fallback Chain advances to the next
 * linked virtual model.
 */
export function route(input: RouteRequestInput, deps: RouterDeps): RoutingDecision {
  const primary = deps.virtualModels.resolve(input.modelId);
  if (!primary) {
    throw new RoutingError(input.modelId, 'not_found', []);
  }
  const attempts: VirtualModelIndexEntry[] = [];

  // 1) Try the primary virtual model first.
  let pick = tryOne(primary, 0, deps, input.dryRun === true);
  if (pick) return pick;
  attempts.push(primary);

  // 2) Walk the Fallback Chain.
  for (let i = 0; i < primary.fallbackChain.length; i++) {
    const next = deps.virtualModels.resolve(primary.fallbackChain[i]!);
    if (!next) continue;
    const depth = i + 1;
    const candidate = tryOne(next, depth, deps, input.dryRun === true);
    if (candidate) return candidate;
    attempts.push(next);
  }

  throw new RoutingError(input.modelId, 'chain_exhausted', attempts);
}

/**
 * Resolve a routing decision for a given virtual model entry. The function is
 * pure with respect to the inputs, which makes it easy to test each strategy in
 * isolation.
 */
export function tryOne(vm: VirtualModelIndexEntry, depth: number, deps: RouterDeps, dryRun = false): RoutingDecision | null {
  const candidates = filterRoutable(vm.members, deps);
  if (candidates.length === 0) return null;

  const upstream = pickByStrategy(vm.strategy, candidates, vm, deps, dryRun);
  if (!upstream) return null;
  return { virtualModel: vm, upstream, depth };
}

function filterRoutable(
  members: VirtualModelMemberRow[],
  deps: RouterDeps,
): UpstreamModelIndexEntry[] {
  const out: UpstreamModelIndexEntry[] = [];
  for (const m of members) {
    const list = deps.upstreamModels.lookup(m.upstream_model_id);
    for (const entry of list) {
      if (deps.availability.isRoutable(entry.modelId)) {
        out.push(entry);
        continue;
      }
    }
  }
  // Dedup while preserving order.
  const seen = new Set<string>();
  const dedup: UpstreamModelIndexEntry[] = [];
  for (const e of out) {
    const key = `${e.providerId}::${e.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(e);
  }
  return dedup;
}

function pickByStrategy(
  strategy: RoutingStrategy,
  candidates: UpstreamModelIndexEntry[],
  vm: VirtualModelIndexEntry,
  deps: RouterDeps,
  dryRun = false,
): UpstreamModelIndexEntry | null {
  switch (strategy) {
    case 'RoundRobin':
      return dryRun ? (candidates[0] ?? null) : roundRobin(candidates, vm, deps);
    case 'WeightedRandom':
      return weightedRandom(candidates, vm, deps);
    case 'Failover':
      return failover(candidates, vm, deps);
    case 'LowestLatency':
      return lowestLatency(candidates, vm, deps);
  }
  return null;
}

function roundRobin(
  candidates: UpstreamModelIndexEntry[],
  vm: VirtualModelIndexEntry,
  deps: RouterDeps,
): UpstreamModelIndexEntry | null {
  const counter = deps.nextCounter(vm.id);
  return candidates[(counter - 1) % candidates.length] ?? null;
}

function weightedRandom(
  candidates: UpstreamModelIndexEntry[],
  vm: VirtualModelIndexEntry,
  deps: RouterDeps,
): UpstreamModelIndexEntry | null {
  const weights = candidates.map((c) => memberWeightFor(c, vm));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return candidates[0] ?? null;
  const r = (deps.random ?? Math.random)() * total;
  let acc = 0;
  for (let i = 0; i < candidates.length; i++) {
    acc += weights[i]!;
    if (r < acc) return candidates[i]!;
  }
  return candidates[candidates.length - 1] ?? null;
}

function failover(
  candidates: UpstreamModelIndexEntry[],
  vm: VirtualModelIndexEntry,
  deps: RouterDeps,
): UpstreamModelIndexEntry | null {
  // Pick the highest-priority member whose upstream is currently routable.
  for (const c of candidates) {
    if (deps.availability.isRoutable(c.modelId)) return c;
  }
  return null;
}

function lowestLatency(
  candidates: UpstreamModelIndexEntry[],
  vm: VirtualModelIndexEntry,
  deps: RouterDeps,
): UpstreamModelIndexEntry | null {
  let best: UpstreamModelIndexEntry | null = null;
  let bestP50 = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const a = deps.availability.get(c.modelId);
    const p50 = a?.latencyMsP50 ?? Number.POSITIVE_INFINITY;
    if (p50 < bestP50) {
      bestP50 = p50;
      best = c;
    }
  }
  return best;
}

function memberWeightFor(c: UpstreamModelIndexEntry, vm: VirtualModelIndexEntry): number {
  const member = vm.members.find((m) => m.upstream_model_id === c.modelId);
  if (!member) return 1;
  return Math.max(0, member.weight);
}
