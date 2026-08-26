import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../../src/auth/rate-limit.js';

describe('RateLimiter — RPM', () => {
  let rl: RateLimiter;
  beforeEach(() => {
    rl = new RateLimiter(() => 1_700_000_000_000);
  });

  it('allows requests below the limit', () => {
    for (let i = 0; i < 5; i++) {
      const r = rl.check('keyA', 0, { rpm: 5, tpm: null });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects when RPM is exhausted', () => {
    for (let i = 0; i < 3; i++) {
      rl.check('keyA', 0, { rpm: 3, tpm: null });
    }
    const r = rl.check('keyA', 0, { rpm: 3, tpm: null });
    expect(r.ok).toBe(false);
    expect(r.dimension).toBe('rpm');
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not consume quota when rejecting', () => {
    for (let i = 0; i < 3; i++) {
      rl.check('keyA', 0, { rpm: 3, tpm: null });
    }
    rl.check('keyA', 0, { rpm: 3, tpm: null }); // rejected
    rl.check('keyA', 0, { rpm: 3, tpm: null }); // still rejected
    const r = rl.check('keyA', 0, { rpm: 3, tpm: null });
    expect(r.ok).toBe(false);
  });

  it('null rpm means no rate limit', () => {
    for (let i = 0; i < 100; i++) {
      const r = rl.check('keyA', 0, { rpm: null, tpm: null });
      expect(r.ok).toBe(true);
    }
  });
});

describe('RateLimiter — TPM', () => {
  let rl: RateLimiter;
  beforeEach(() => {
    rl = new RateLimiter(() => 1_700_000_000_000);
  });

  it('allows tokens below the limit', () => {
    const r = rl.check('keyA', 100, { rpm: null, tpm: 1000 });
    expect(r.ok).toBe(true);
  });

  it('rejects when TPM would be exceeded', () => {
    rl.check('keyA', 800, { rpm: null, tpm: 1000 });
    const r = rl.check('keyA', 300, { rpm: null, tpm: 1000 });
    expect(r.ok).toBe(false);
    expect(r.dimension).toBe('tpm');
  });

  it('does not consume TPM when rejecting', () => {
    rl.check('keyA', 800, { rpm: null, tpm: 1000 });
    rl.check('keyA', 300, { rpm: null, tpm: 1000 }); // rejected
    const r = rl.check('keyA', 100, { rpm: null, tpm: 1000 });
    expect(r.ok).toBe(true);
  });

  it('consumes both RPM and TPM atomically when both configured', () => {
    const r = rl.check('keyA', 500, { rpm: 5, tpm: 1000 });
    expect(r.ok).toBe(true);
    const blocked = rl.check('keyA', 600, { rpm: 5, tpm: 1000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.dimension).toBe('tpm');
    // RPM still has room: 1 used, limit 5
    const rpmOk = rl.check('keyA', 0, { rpm: 5, tpm: 1000 });
    expect(rpmOk.ok).toBe(true);
  });
});

describe('RateLimiter — window rollover', () => {
  it('rolls forward to a new minute when time advances past the window', () => {
    let t = 1_700_000_000_000;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 2; i++) rl.check('keyA', 0, { rpm: 2, tpm: null });
    const blocked = rl.check('keyA', 0, { rpm: 2, tpm: null });
    expect(blocked.ok).toBe(false);

    t += 61_000; // jump past the current minute
    const r = rl.check('keyA', 0, { rpm: 2, tpm: null });
    expect(r.ok).toBe(true);
  });
});
