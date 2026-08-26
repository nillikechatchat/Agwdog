import type { IRRequest, IRResponse } from '../ir/types.js';

/**
 * Outcome of a cache lookup. The orchestrator (which checks exact, semantic,
 * prompt, and response caches in order) inspects this to decide whether to
 * short-circuit, fall through to the upstream, or augment the request.
 */
export type CacheLookupResult =
  | { kind: 'miss' }
  | { kind: 'exact'; response: IRResponse; fingerprint: string; age: number }
  | { kind: 'semantic'; response: IRResponse; entryId: string; similarity: number; age: number }
  | { kind: 'prompt_prefix'; cachedTokens: number }
  | { kind: 'response_continuation'; responseId: string };

export interface CacheConfig {
  exactEnabled: boolean;
  semanticEnabled: boolean;
  promptCacheEnabled: boolean;
  responseContinuationEnabled: boolean;
  /** Similarity threshold for semantic cache hits (0..1). */
  semanticThreshold: number;
  /** Default TTL in seconds for entries that don't carry their own. */
  defaultTtlSeconds: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  exactEnabled: true,
  semanticEnabled: true,
  promptCacheEnabled: true,
  responseContinuationEnabled: true,
  semanticThreshold: 0.92,
  defaultTtlSeconds: 86_400,
};

/**
 * Generate a deterministic string identifier for an IR request. Used to build
 * the storage key for the response cache (which is keyed on the entire body
 * the client posted, not just our canonical fingerprint).
 */
export function cacheKeyFor(request: IRRequest, clientProtocol: string, keyId: string): string {
  return `${clientProtocol}:${keyId}:${request.model}:${JSON.stringify(request.messages)}`;
}

export interface SemanticEntry {
  id: string;
  virtualModelId: string;
  embedding: Float32Array;
  embeddingModel: string;
  request: IRRequest;
  response: IRResponse;
  ttlSeconds: number;
  createdAt: number;
}

export interface PromptCacheMarker {
  cacheKey: string;
  clientProtocol: string;
  cacheControl: unknown;
  prefixTokens: number;
}
