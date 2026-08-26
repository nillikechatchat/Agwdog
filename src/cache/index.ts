export { ExactCache, type CachePolicy, type CacheWriteInput, type CacheLookupInput, type CacheHit, type CacheMiss, type CacheLookupOutcome } from './exact.js';
export { SemanticCache, DEFAULT_SEMANTIC_OPTIONS, type SemanticCacheOptions } from './semantic.js';
export { PromptCacheTracker } from './prompt-cache.js';
export { ResponseContinuationCache, type ResponseCacheEntry } from './response-cache.js';
export { CacheOrchestrator, type CacheOrchestratorDeps, type CacheLookupInput as OrchestratorLookupInput } from './orchestrator.js';
export {
  DEFAULT_CACHE_CONFIG,
  cacheKeyFor,
  type CacheConfig,
  type CacheLookupResult,
  type PromptCacheMarker,
} from './types.js';
export {
  setEmbeddingProvider,
  getEmbeddingProvider,
  embed,
  cosineSimilarity,
  normalize,
  serializeEmbedding,
  deserializeEmbedding,
  type EmbeddingProvider,
} from './embedding.js';
