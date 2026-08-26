import { describe, it, expect } from 'vitest';
import { TokenBucket, VendorRateLimiter } from '../../../src/connector/token-bucket.js';

describe('TokenBucket', () => {
  it('starts full and allows immediate takes', () => {
    const b = new TokenBucket({ refillPerSecond: 10, capacity: 5 }, 0);
    expect(b.reserve(0)).toBe(0);
    expect(b.reserve(0)).toBe(0);
  });

  it('reports wait time when empty', () => {
    const b = new TokenBucket({ refillPerSecond: 10, capacity: 1 }, 0);
    expect(b.reserve(0)).toBe(0);
    const wait = b.reserve(0);
    expect(wait).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    const b = new TokenBucket({ refillPerSecond: 1000, capacity: 1 }, 0);
    expect(b.reserve(0)).toBe(0);
    expect(b.reserve(0)).toBeGreaterThan(0);
    // 1 second later, full again.
    expect(b.reserve(1000)).toBe(0);
  });

  it('aborts on signal', async () => {
    const t0 = Date.now();
    const b = new TokenBucket({ refillPerSecond: 1, capacity: 1 }, t0);
    b.reserve(t0); // tokens 1 -> 0
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(b.take(ctl.signal)).rejects.toThrow();
  });
});

describe('VendorRateLimiter', () => {
  it('per-vendor buckets are independent', async () => {
    const rl = new VendorRateLimiter({ refillPerSecond: 1, capacity: 1 });
    await rl.waitFor('a');
    // Bucket 'a' is drained; bucket 'b' is fresh.
    const t0 = Date.now();
    await rl.waitFor('b');
    expect(Date.now() - t0).toBeLessThan(20);
  });
});
