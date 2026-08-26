/**
 * A simple token-bucket rate limiter, applied per provider (vendor) to avoid
 * bursting beyond what the upstream allows. Thread-safe within a single Node
 * process (no async locks; the bucket is mutated atomically).
 */
export interface TokenBucketConfig {
  /** Sustained tokens-per-second. */
  refillPerSecond: number;
  /** Maximum bucket capacity (burst). */
  capacity: number;
}

export const DEFAULT_VENDOR_BUCKET: TokenBucketConfig = {
  refillPerSecond: 50,
  capacity: 100,
};

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly cfg: TokenBucketConfig;
  private readonly waiters: Array<() => void> = [];

  constructor(cfg: TokenBucketConfig = DEFAULT_VENDOR_BUCKET, now: number = Date.now()) {
    this.cfg = cfg;
    this.tokens = cfg.capacity;
    this.lastRefillMs = now;
  }

  /** Returns ms to wait before `take()` can succeed, or 0 if immediate. */
  reserve(now: number = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit * 1000) / this.cfg.refillPerSecond);
  }

  /** Take a token or block (via returned promise) until one is available. */
  async take(signal?: AbortSignal): Promise<void> {
    while (true) {
      const wait = this.reserve();
      if (wait === 0) return;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          const idx = this.waiters.indexOf(resolve as unknown as () => void);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve();
        }, wait);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            const idx = this.waiters.indexOf(resolve as unknown as () => void);
            if (idx >= 0) this.waiters.splice(idx, 1);
            reject(new Error('aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }

  private refill(now: number): void {
    if (now <= this.lastRefillMs) return;
    const delta = ((now - this.lastRefillMs) / 1000) * this.cfg.refillPerSecond;
    this.tokens = Math.min(this.cfg.capacity, this.tokens + delta);
    this.lastRefillMs = now;
  }
}

export class VendorRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  constructor(private readonly defaultCfg: TokenBucketConfig = DEFAULT_VENDOR_BUCKET) {}

  bucketFor(vendorId: string, cfg?: TokenBucketConfig): TokenBucket {
    let b = this.buckets.get(vendorId);
    if (!b) {
      b = new TokenBucket(cfg ?? this.defaultCfg);
      this.buckets.set(vendorId, b);
    }
    return b;
  }

  async waitFor(vendorId: string, signal?: AbortSignal): Promise<void> {
    return this.bucketFor(vendorId).take(signal);
  }
}
