import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseContinuationCache } from '../../../src/cache/response-cache.js';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';

describe('ResponseContinuationCache', () => {
  let db: TestDbHandle;
  let cache: ResponseContinuationCache;

  beforeEach(() => {
    db = openTestDatabase();
    cache = new ResponseContinuationCache(db.db);
  });

  it('puts and gets an entry', () => {
    const now = Date.now();
    cache.put({
      id: 'resp_1', keyId: null, clientProtocol: 'OpenAI-Responses',
      virtualModelId: 'vm', upstreamProviderId: 'p', upstreamModelId: 'm',
      requestJson: '{}', responseJson: '{"x":1}', ttlSeconds: 60,
      createdAt: now, expiresAt: now + 60_000,
    });
    const got = cache.get('resp_1', now + 100);
    expect(got?.responseJson).toBe('{"x":1}');
  });

  it('returns null for unknown id', () => {
    expect(cache.get('nope', Date.now())).toBeNull();
  });

  it('returns null for expired entry', () => {
    const past = Date.now() - 1000;
    cache.put({
      id: 'r', keyId: null, clientProtocol: 'OpenAI-Chat',
      virtualModelId: null, upstreamProviderId: null, upstreamModelId: null,
      requestJson: '{}', responseJson: '{}', ttlSeconds: 1,
      createdAt: past - 10_000, expiresAt: past,
    });
    expect(cache.get('r', Date.now())).toBeNull();
  });

  it('invalidateExpired drops stale entries', () => {
    const past = Date.now() - 1000;
    cache.put({
      id: 'r', keyId: null, clientProtocol: 'OpenAI-Chat',
      virtualModelId: null, upstreamProviderId: null, upstreamModelId: null,
      requestJson: '{}', responseJson: '{}', ttlSeconds: 1,
      createdAt: past - 10_000, expiresAt: past,
    });
    expect(cache.invalidateExpired(Date.now())).toBe(1);
  });
});
