import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import { generateVirtualKey } from '../../../src/auth/keys.js';
import { RateLimiter } from '../../../src/auth/rate-limit.js';
import { BudgetTracker } from '../../../src/budget/tracker.js';
import { authenticateRequest } from '../../../src/auth/pipeline.js';
import type { KeyRepo } from '../../../src/storage/repos/keys.js';

let h: TestDbHandle;
let keys: KeyRepo;
let rl: RateLimiter;
let budget: BudgetTracker;

beforeEach(() => {
  h = openTestDatabase();
  keys = h.keys;
  rl = new RateLimiter(() => 1_700_000_000_000);
  budget = new BudgetTracker(keys, h.events, h.budgets, () => 1_700_000_000_000);
});

afterEach(() => h.cleanup());

function makeKey(over: Partial<Parameters<KeyRepo['insert']>[0]> = {}) {
  const { plaintext, hash, keyPrefix } = generateVirtualKey();
  return {
    plaintext,
    row: keys.insert({
      id: 'k1',
      name: 'test',
      keyHash: hash,
      prefix: keyPrefix,
      ...over,
    }),
  };
}

function buildInput(token: string | null, modelId = 'gpt-4o') {
  return {
    authorizationHeader: token ? `Bearer ${token}` : undefined,
    modelId,
    estimatedTokens: 100,
    estimatedCostUsd: 0.01,
  };
}

const deps = () => ({ keys, rateLimiter: rl, budget });

describe('authenticateRequest — token checks', () => {
  it('rejects when no Authorization header is present', () => {
    const r = authenticateRequest(buildInput(null), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(401);
      expect(r.errorCode).toBe('unauthorized');
    }
  });

  it('rejects when the token is unknown', () => {
    const r = authenticateRequest(buildInput('gw-doesnotexist'), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('invalid_api_key');
  });

  it('rejects a revoked key with key_revoked', () => {
    const { plaintext, row } = makeKey();
    keys.revoke(row.id);
    const r = authenticateRequest(buildInput(plaintext), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('key_revoked');
  });

  it('accepts a valid key with no constraints', () => {
    const { plaintext, row } = makeKey();
    const r = authenticateRequest(buildInput(plaintext), deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key.id).toBe(row.id);
  });
});

describe('authenticateRequest — whitelist', () => {
  it('rejects when the requested model is not in allowedModels (403)', () => {
    const { plaintext } = makeKey({ allowedModels: ['gpt-4o'] });
    const r = authenticateRequest(buildInput(plaintext, 'claude-3-5-sonnet'), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(403);
      expect(r.errorCode).toBe('model_not_allowed');
    }
  });

  it('accepts an allowed model', () => {
    const { plaintext } = makeKey({ allowedModels: ['gpt-4o'] });
    const r = authenticateRequest(buildInput(plaintext, 'gpt-4o'), deps());
    expect(r.ok).toBe(true);
  });
});

describe('authenticateRequest — rate limit', () => {
  it('returns 429 with Retry-After when RPM exhausted', () => {
    const { plaintext } = makeKey({ rpmLimit: 2 });
    expect(authenticateRequest(buildInput(plaintext), deps()).ok).toBe(true);
    expect(authenticateRequest(buildInput(plaintext), deps()).ok).toBe(true);
    const r = authenticateRequest(buildInput(plaintext), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(429);
      expect(r.errorCode).toBe('rate_limit_rpm');
      expect(r.headers?.['Retry-After']).toBeDefined();
    }
  });

  it('returns 429 when TPM would be exceeded', () => {
    const { plaintext } = makeKey({ tpmLimit: 150 });
    expect(authenticateRequest({ ...buildInput(plaintext), estimatedTokens: 100 }, deps()).ok).toBe(true);
    const r = authenticateRequest({ ...buildInput(plaintext), estimatedTokens: 100 }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('rate_limit_tpm');
  });
});

describe('authenticateRequest — budget', () => {
  it('returns 402 when hard budget would be exceeded', () => {
    const { plaintext } = makeKey({ budgetDailyUsd: 0.05, budgetMode: 'hard' });
    const r = authenticateRequest({ ...buildInput(plaintext), estimatedCostUsd: 0.10 }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(402);
      expect(r.errorCode).toBe('budget_exceeded');
    }
  });

  it('soft mode lets the request through even when over budget', () => {
    const { plaintext } = makeKey({ budgetDailyUsd: 0.05, budgetMode: 'soft' });
    const r = authenticateRequest({ ...buildInput(plaintext), estimatedCostUsd: 100 }, deps());
    expect(r.ok).toBe(true);
  });
});
