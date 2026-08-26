import { route, type RouterDeps, type RoutingDecision } from './strategies.js';

export interface DryRunResult {
  decision: RoutingDecision;
  /** All fallback chain members that the router would have considered after this one. */
  alternatives: string[];
}

/**
 * Compute a routing decision without actually dispatching to an upstream. The
 * function returns the chosen `RoutingDecision` plus the list of fallback
 * virtual models that would be tried if the chosen upstream failed.
 */
export function dryRunRoute(modelId: string, deps: RouterDeps): DryRunResult {
  const decision = route({ modelId, dryRun: true }, deps);
  const alternatives: string[] = [];
  const primary = decision.virtualModel;
  for (let i = decision.depth; i < primary.fallbackChain.length; i++) {
    const name = primary.fallbackChain[i];
    if (name) alternatives.push(name);
  }
  return { decision, alternatives };
}
