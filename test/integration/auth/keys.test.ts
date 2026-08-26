import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase } from '../../helpers/db.js';
import { generateVirtualKey, hashKey, isModelAllowed, authenticate, parseAllowedModels } from '../../../src/auth/keys.js';
import type { Database } from 'better-sqlite3';
import { KeyRepo } from '../../../src/storage/repos/keys.js';

interface Ctx {
  db: Database;
  keys: KeyRepo;
  cleanup: () => void;
}

let ctx: Ctx;

beforeEach(() => {
  ctx = openTestDatabase();
  ctx.keys = new KeyRepo(ctx.db);
});

afterEach(() => ctx.cleanup());

function makeKey(overrides: Partial<Parameters<KeyRepo['insert']>[0]> = {}) {
  const { plaintext, hash, keyPrefix } = generateVirtualKey();
  const row = ctx.keys.insert({
    id: overrides.id ?? 'k1',
    name: 'test',
    keyHash: hash,
    prefix: keyPrefix,
    allowedModels: overrides.allowedModels ?? null,
    ...overrides,
  });
  return { row, plaintext };
}

describe('authenticate', () => {
  it('returns ok for a valid active key', () => {
    const { row, plaintext } = makeKey();
    const r = authenticate(plaintext, ctx.keys);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key.id).toBe(row.id);
  });

  it('returns not_found for unknown key', () => {
    const r = authenticate('gw-doesnotexist', ctx.keys);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('returns revoked for a revoked key', () => {
    const { row, plaintext } = makeKey();
    ctx.keys.revoke(row.id);
    const r = authenticate(plaintext, ctx.keys);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('revoked');
  });

  it('returns missing for empty / short input', () => {
    expect(authenticate('', ctx.keys).ok).toBe(false);
    expect(authenticate('abc', ctx.keys).ok).toBe(false);
  });
});

describe('hashKey & parseAllowedModels', () => {
  it('round-trips a key through hashKey / findByHash', () => {
    const { row, plaintext } = makeKey();
    const found = ctx.keys.findByHash(hashKey(plaintext));
    expect(found?.id).toBe(row.id);
  });

  it('parseAllowedModels returns null when no whitelist is set', () => {
    const { row } = makeKey();
    expect(parseAllowedModels(row)).toBeNull();
  });

  it('parseAllowedModels returns a Set when set', () => {
    const { row } = makeKey({ allowedModels: ['gpt-4o', 'claude-3-5-sonnet'] });
    const set = parseAllowedModels(row);
    expect(set?.has('gpt-4o')).toBe(true);
    expect(set?.has('claude-3-5-sonnet')).toBe(true);
  });

  it('parseAllowedModels returns null for empty array', () => {
    const { row } = makeKey({ allowedModels: [] });
    expect(parseAllowedModels(row)).toBeNull();
  });
});

describe('isModelAllowed', () => {
  it('allows any model when no whitelist', () => {
    const { row } = makeKey();
    expect(isModelAllowed(row, 'gpt-4o')).toBe(true);
    expect(isModelAllowed(row, 'anything-else')).toBe(true);
  });

  it('enforces the whitelist', () => {
    const { row } = makeKey({ allowedModels: ['gpt-4o'] });
    expect(isModelAllowed(row, 'gpt-4o')).toBe(true);
    expect(isModelAllowed(row, 'gpt-3.5')).toBe(false);
  });

  it('honors wildcard *', () => {
    const { row } = makeKey({ allowedModels: ['*'] });
    expect(isModelAllowed(row, 'whatever')).toBe(true);
  });
});
