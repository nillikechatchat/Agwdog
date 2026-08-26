import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import { CacheRepo } from '../../../src/storage/repos/cache.js';

let h: TestDbHandle;
let repo: CacheRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  h = openTestDatabase();
  repo = new CacheRepo(h.db);
});

afterEach(() => h.cleanup());

describe('CacheRepo.put + getByFingerprint', () => {
  it('stores and retrieves an entry', () => {
    repo.put(
      { fingerprint: 'fp1', keyId: 'k1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{"a":1}' },
      NOW,
    );
    const e = repo.getByFingerprint('fp1', NOW + 1000);
    expect(e).not.toBeNull();
    expect(e!.response_json).toBe('{"a":1}');
    expect(e!.hit_count).toBe(0);
  });

  it('overwrites on conflict (UPSERT)', () => {
    repo.put({ fingerprint: 'fp1', keyId: 'k1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{"a":1}' }, NOW);
    repo.put({ fingerprint: 'fp1', keyId: 'k1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{"a":2}' }, NOW);
    const e = repo.getByFingerprint('fp1', NOW + 100);
    expect(e!.response_json).toBe('{"a":2}');
  });

  it('returns null for an expired entry', () => {
    repo.put(
      { fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{}', ttlSeconds: 10 },
      NOW,
    );
    expect(repo.getByFingerprint('fp1', NOW + 5_000)).not.toBeNull();
    expect(repo.getByFingerprint('fp1', NOW + 11_000)).toBeNull();
  });

  it('returns null for a missing fingerprint', () => {
    expect(repo.getByFingerprint('nope', NOW)).toBeNull();
  });
});

describe('CacheRepo.recordHit', () => {
  it('increments hit_count and updates last_hit_at', () => {
    repo.put({ fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{}' }, NOW);
    repo.recordHit('fp1', NOW + 1000);
    repo.recordHit('fp1', NOW + 2000);
    const e = repo.getByFingerprint('fp1', NOW + 2001)!;
    expect(e.hit_count).toBe(2);
    expect(e.last_hit_at).toBe(NOW + 2000);
  });
});

describe('CacheRepo.delete / clear / count / prune', () => {
  beforeEach(() => {
    repo.put({ fingerprint: 'a', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{}', ttlSeconds: 60 }, NOW);
    repo.put({ fingerprint: 'b', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{}', ttlSeconds: 60 }, NOW);
    repo.put({ fingerprint: 'c', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{}', ttlSeconds: 1 }, NOW - 1000);
  });

  it('delete removes a single entry', () => {
    // c is already expired (ttl=1s, created 1s before NOW), so count starts at 2.
    expect(repo.count(NOW)).toBe(2);
    repo.delete('a');
    expect(repo.count(NOW)).toBe(1);
  });

  it('clear removes all entries (including expired)', () => {
    const removed = repo.clear();
    expect(removed).toBe(3);
    expect(repo.count(NOW)).toBe(0);
  });

  it('count only includes live entries', () => {
    expect(repo.count(NOW)).toBe(2); // c is expired
  });

  it('prune removes expired entries only', () => {
    const removed = repo.prune(NOW);
    expect(removed).toBe(1);
    expect(repo.count(NOW)).toBe(2);
  });
});

describe('CacheRepo.lookup', () => {
  it('parses the response and bumps hit_count', () => {
    repo.put(
      { fingerprint: 'fp1', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: '{"hello":"world"}' },
      NOW,
    );
    const r = repo.lookup('fp1', NOW + 100);
    expect(r).not.toBeNull();
    expect(r!.hit).toBe(true);
    expect(r!.response).toEqual({ hello: 'world' });
    const refreshed = repo.getByFingerprint('fp1', NOW + 101)!;
    expect(refreshed.hit_count).toBe(1);
  });

  it('returns null for expired / missing entries', () => {
    expect(repo.lookup('absent', NOW)).toBeNull();
  });

  it('returns null when the response body is corrupt', () => {
    repo.put({ fingerprint: 'bad', clientProtocol: 'OpenAI-Chat', model: 'gpt-4o', responseJson: 'not-json' }, NOW);
    expect(repo.lookup('bad', NOW)).toBeNull();
  });
});
