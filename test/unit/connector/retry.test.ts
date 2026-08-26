import { describe, it, expect } from 'vitest';
import { computeBackoff, isRetryableStatus, parseRetryAfter } from '../../../src/connector/retry.js';

describe('isRetryableStatus', () => {
  it('retries 408/409/425/429 and 5xx', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(s)).toBe(true);
    }
  });
  it('does not retry 4xx other than the above', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(s)).toBe(false);
    }
  });
});

describe('computeBackoff', () => {
  it('uses Retry-After when present', () => {
    const d = computeBackoff(2, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 4000, multiplier: 2, jitterMs: 0 }, 1500);
    expect(d).toBe(1500);
  });
  it('grows exponentially and caps at maxDelayMs', () => {
    const cfg = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 500, multiplier: 2, jitterMs: 0 };
    expect(computeBackoff(1, cfg)).toBe(100);
    expect(computeBackoff(2, cfg)).toBe(200);
    expect(computeBackoff(3, cfg)).toBe(400);
    expect(computeBackoff(4, cfg)).toBe(500); // capped
  });
  it('adds jitter up to jitterMs', () => {
    const cfg = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, multiplier: 2, jitterMs: 50 };
    const d = computeBackoff(1, cfg);
    expect(d).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThanOrEqual(150);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });
  it('parses HTTP-date', () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });
  it('returns undefined for empty / invalid', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});
