import type { CacheRepo } from '../storage/repos/cache.js';
import type { ClientProtocol } from '../storage/types.js';

/**
 * Per-key cache policy as defined by the Key row. `enabled=false` disables the
 * exact cache for that key entirely (a "no-cache" key) — the most useful escape
 * hatch for debugging.
 */
export interface CachePolicy {
  enabled: boolean;
  ttlSeconds: number;
}

export interface CacheWriteInput {
  fingerprint: string;
  keyId: string | null;
  clientProtocol: ClientProtocol;
  model: string;
  response: unknown;
}

export interface CacheLookupInput {
  fingerprint: string;
  clientProtocol: ClientProtocol;
  policy: CachePolicy;
  /** Streaming requests always bypass; non-streaming may hit. */
  stream: boolean;
}

export interface CacheHit {
  hit: true;
  response: unknown;
  fingerprint: string;
  age: number; // ms since the entry was created
}

export interface CacheMiss {
  hit: false;
  reason: 'disabled' | 'streaming' | 'protocol_mismatch' | 'not_found' | 'expired';
}

export type CacheLookupOutcome = CacheHit | CacheMiss;

export class ExactCache {
  private nowFn: () => number;

  constructor(
    private readonly repo: CacheRepo,
    now: () => number = Date.now,
  ) {
    this.nowFn = now;
  }

  /** Override the wall-clock function (tests). */
  setNow(fn: () => number): void {
    this.nowFn = fn;
  }

  private now(): number {
    return this.nowFn();
  }

  /**
   * Lookup-by-fingerprint. Streaming requests always miss with `reason: 'streaming'`
   * even when an entry exists — the design intent is that streamed responses are
   * never replayed from cache (we cannot guarantee byte-for-byte upstream timing).
   */
  lookup(input: CacheLookupInput): CacheLookupOutcome {
    if (!input.policy.enabled) return { hit: false, reason: 'disabled' };
    if (input.stream) return { hit: false, reason: 'streaming' };
    const entry = this.repo.getByFingerprint(input.fingerprint, this.now());
    if (!entry) return { hit: false, reason: 'not_found' };
    if (entry.client_protocol !== input.clientProtocol) {
      return { hit: false, reason: 'protocol_mismatch' };
    }
    let response: unknown;
    try {
      response = JSON.parse(entry.response_json);
    } catch {
      return { hit: false, reason: 'expired' };
    }
    this.repo.recordHit(input.fingerprint, this.now());
    return {
      hit: true,
      response,
      fingerprint: input.fingerprint,
      age: this.now() - entry.created_at,
    };
  }

  /** Persist a response keyed by its request fingerprint. No-op for streaming responses. */
  write(input: CacheWriteInput, ttlSeconds: number): void {
    this.repo.put(
      {
        fingerprint: input.fingerprint,
        keyId: input.keyId,
        clientProtocol: input.clientProtocol,
        model: input.model,
        responseJson: JSON.stringify(input.response),
        ttlSeconds,
      },
      this.now(),
    );
  }

  /** Return the live (non-expired) entry count. Used by the admin stats endpoint. */
  size(): number {
    return this.repo.count(this.now());
  }

  /** Drop expired entries; returns the number removed. */
  prune(): number {
    return this.repo.prune(this.now());
  }

  /** Drop all entries. */
  clear(): number {
    return this.repo.clear();
  }
}
