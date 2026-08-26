import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import { CacheRepo } from '../../../src/storage/repos/cache.js';
import { ExactCache, type CachePolicy } from '../../../src/cache/exact.js';

let h: TestDbHandle;
let cache: ExactCache;
let repo: CacheRepo;
const NOW = 1_700_000_000_000;
const policy: CachePolicy = { enabled: true, ttlSeconds: 60 };

beforeEach(() => {
  h = openTestDatabase();
  repo = new CacheRepo(h.db);
  cache = new ExactCache(repo, () => NOW);
});

afterEach(() => h.cleanup());

describe('ExactCache.write + lookup', () => {
  it('writes and then hits an entry', () => {
    cache.write({ fingerprint: 'fp1', keyId: 'k1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', response: { ok: true } }, 60);
    const r = cache.lookup({ fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', policy, stream: false });
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.response).toEqual({ ok: true });
  });

  it('returns not_found for a missing fingerprint', () => {
    const r = cache.lookup({ fingerprint: 'nope', clientProtocol: 'OpenAI-Chat', policy, stream: false });
    expect(r).toEqual({ hit: false, reason: 'not_found' });
  });

  it('reports age in milliseconds', () => {
    cache.write({ fingerprint: 'fp1', keyId: null, clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', response: { a: 1 } }, 60);
    cache.setNow(() => NOW + 1234);
    const r = cache.lookup({ fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', policy, stream: false });
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.age).toBe(1234);
  });
});

describe('ExactCache policy enforcement', () => {
  beforeEach(() => {
    cache.write({ fingerprint: 'fp1', keyId: null, clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', response: { x: 1 } }, 60);
  });

  it('returns disabled when policy.enabled is false', () => {
    const r = cache.lookup({ fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', policy: { ...policy, enabled: false }, stream: false });
    expect(r).toEqual({ hit: false, reason: 'disabled' });
  });

  it('returns streaming when stream=true (no replay)', () => {
    const r = cache.lookup({ fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', policy, stream: true });
    expect(r).toEqual({ hit: false, reason: 'streaming' });
  });

  it('returns protocol_mismatch when stored protocol differs', () => {
    const r = cache.lookup({ fingerprint: 'fp1', clientProtocol: 'Anthropic-Messages', policy, stream: false });
    expect(r).toEqual({ hit: false, reason: 'protocol_mismatch' });
  });
});

describe('ExactCache admin operations', () => {
  beforeEach(() => {
    cache.write({ fingerprint: 'a', keyId: null, clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', response: {} }, 60);
    cache.write({ fingerprint: 'b', keyId: null, clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', response: {} }, 60);
  });

  it('size returns the live entry count', () => {
    expect(cache.size()).toBe(2);
  });

  it('clear removes all entries', () => {
    expect(cache.clear()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('prune drops only expired entries', () => {
    cache.setNow(() => NOW + 61_000);
    expect(cache.prune()).toBe(2);
    expect(cache.size()).toBe(0);
  });
});
