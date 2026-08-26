import type { Database } from 'better-sqlite3';
import type { IRRequest, IRResponse } from '../ir/types.js';
import { ExactCache } from './exact.js';
import { PromptCacheTracker } from './prompt-cache.js';
import { ResponseContinuationCache } from './response-cache.js';
import { SemanticCache } from './semantic.js';
import {
  DEFAULT_CACHE_CONFIG,
  type CacheConfig,
  type CacheLookupResult,
  type PromptCacheMarker,
} from './types.js';

export interface CacheOrchestratorDeps {
  db: Database;
  exact: ExactCache;
  config?: Partial<CacheConfig>;
}

export interface CacheLookupInput {
  virtualModelId: string;
  request: IRRequest;
  fingerprint: string;
  responseId?: string;
  keyId?: string;
  clientProtocol: string;
}

export class CacheOrchestrator {
  readonly config: CacheConfig;
  readonly semantic: SemanticCache;
  readonly prompt: PromptCacheTracker;
  readonly response: ResponseContinuationCache;
  private readonly exact: ExactCache;

  constructor(deps: CacheOrchestratorDeps) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...(deps.config ?? {}) };
    this.exact = deps.exact;
    this.semantic = new SemanticCache(deps.db, {
      threshold: this.config.semanticThreshold,
      defaultTtlSeconds: this.config.defaultTtlSeconds,
      maxCandidates: 64,
    });
    this.prompt = new PromptCacheTracker(deps.db);
    this.response = new ResponseContinuationCache(deps.db);
  }

  /**
   * Check the cache layers in priority order:
   *  1. exact   (fingerprint match)
   *  2. semantic (embedding similarity)
   *  3. response (previous_response_id continuation)
   * Returns the first hit; `miss` if none.
   */
  lookup(input: CacheLookupInput, now: number = Date.now()): CacheLookupResult {
    if (this.config.exactEnabled) {
      const exact = this.exact.lookup({
        fingerprint: input.fingerprint,
        clientProtocol: input.clientProtocol as 'OpenAI-Chat' | 'OpenAI-Responses' | 'Anthropic-Messages' | 'Gemini-GenerateContent',
        policy: { enabled: true, ttlSeconds: this.config.defaultTtlSeconds },
        stream: input.request.stream === true,
      });
      if (exact.hit) {
        return {
          kind: 'exact',
          response: exact.response as IRResponse,
          fingerprint: input.fingerprint,
          age: exact.age,
        };
      }
    }
    if (this.config.semanticEnabled) {
      const sem = this.semantic.lookup(input.virtualModelId, input.request, now);
      if (sem.kind === 'semantic') return sem;
    }
    if (this.config.responseContinuationEnabled && input.responseId) {
      const cont = this.response.get(input.responseId, now);
      if (cont) {
        return { kind: 'response_continuation', responseId: cont.id };
      }
    }
    return { kind: 'miss' };
  }

  store(
    input: CacheLookupInput,
    response: IRResponse,
    now: number = Date.now(),
  ): void {
    if (this.config.exactEnabled) {
      this.exact.write(
        {
          fingerprint: input.fingerprint,
          keyId: input.keyId ?? null,
          clientProtocol: input.clientProtocol as 'OpenAI-Chat' | 'OpenAI-Responses' | 'Anthropic-Messages' | 'Gemini-GenerateContent',
          model: input.request.model,
          response,
        },
        this.config.defaultTtlSeconds,
      );
    }
    if (this.config.semanticEnabled) {
      const id = `sem-${input.fingerprint}-${now}`;
      this.semantic.store(id, input.virtualModelId, input.request, response, now);
    }
  }

  recordPromptMarker(id: string, vmId: string, marker: PromptCacheMarker, providerId: string | null, modelId: string | null, now: number = Date.now()): void {
    if (!this.config.promptCacheEnabled) return;
    this.prompt.record(id, vmId, marker, providerId, modelId, now);
  }

  /** Sweep expired entries across all cache tables. */
  sweep(now: number = Date.now()): { exact: number; semantic: number; response: number } {
    return {
      exact: this.exact.prune(),
      semantic: this.semantic.invalidateExpired(now),
      response: this.response.invalidateExpired(now),
    };
  }
}
