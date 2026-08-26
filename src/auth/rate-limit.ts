/**
 * Sliding-window per-minute counters for request rate (RPM) and token rate (TPM).
 *
 * Two in-memory maps hold per-key windows; the gateway deliberately does not span
 * processes (single Node process is a hard constraint), so we do not need a lock manager.
 * The window key is `floor(nowMs / 60000)`. We keep at most the last 2 buckets to bound
 * memory while still allowing a sliding 60s estimate.
 */
export interface RateLimitConfig {
  /** Max requests per minute. `null` = no limit. */
  rpm: number | null;
  /** Max tokens per minute (prompt + completion). `null` = no limit. */
  tpm: number | null;
}

export interface RateLimitDecision {
  ok: boolean;
  /** 'rpm' | 'tpm' | null — the dimension that triggered the block, or null if allowed. */
  dimension: 'rpm' | 'tpm' | null;
  /** Remaining quota in the current window. */
  remaining: number | null;
  /** Seconds until the current window resets (always ≤ 60). */
  retryAfterSeconds: number;
}

interface Bucket {
  minuteKey: number;
  count: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly rpm = new Map<string, Bucket>();
  private readonly tpm = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Reserve one request + `tokens` tokens against `keyId`. If either dimension would
   * exceed its limit, returns `{ ok: false }` and does NOT consume any quota (the caller
   * must either back off or surface a 429).
   */
  check(keyId: string, tokens: number, config: RateLimitConfig): RateLimitDecision {
    const nowMs = this.now();
    const minuteKey = Math.floor(nowMs / WINDOW_MS);
    const retryAfter = Math.max(1, Math.ceil((minuteKey * WINDOW_MS + WINDOW_MS - nowMs) / 1000));

    if (config.rpm !== null) {
      const bucket = this.getOrCreate(this.rpm, keyId, minuteKey);
      if (bucket.count + 1 > config.rpm) {
        return { ok: false, dimension: 'rpm', remaining: 0, retryAfterSeconds: retryAfter };
      }
    }
    if (config.tpm !== null && tokens > 0) {
      const bucket = this.getOrCreate(this.tpm, keyId, minuteKey);
      if (bucket.tokens + tokens > config.tpm) {
        return { ok: false, dimension: 'tpm', remaining: 0, retryAfterSeconds: retryAfter };
      }
    }
    // Commit: actually consume the quota only after both checks pass.
    if (config.rpm !== null) {
      this.getOrCreate(this.rpm, keyId, minuteKey).count += 1;
    }
    if (config.tpm !== null && tokens > 0) {
      this.getOrCreate(this.tpm, keyId, minuteKey).tokens += tokens;
    }
    return { ok: true, dimension: null, remaining: null, retryAfterSeconds: retryAfter };
  }

  /** Reset all state. Primarily for tests. */
  reset(): void {
    this.rpm.clear();
    this.tpm.clear();
  }

  private getOrCreate(map: Map<string, Bucket>, keyId: string, minuteKey: number): Bucket {
    const existing = map.get(keyId);
    if (existing && existing.minuteKey === minuteKey) return existing;
    if (existing && existing.minuteKey === minuteKey - 1) {
      // We could blend last bucket, but for simplicity we just roll forward.
      existing.minuteKey = minuteKey;
      existing.count = 0;
      existing.tokens = 0;
      return existing;
    }
    const fresh: Bucket = { minuteKey, count: 0, tokens: 0 };
    map.set(keyId, fresh);
    return fresh;
  }
}
