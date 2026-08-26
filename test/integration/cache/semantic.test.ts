import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SemanticCache } from '../../../src/cache/semantic.js';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import type { IRRequest, IRResponse, IRTextContent } from '../../../src/ir/types.js';
import {
  setEmbeddingProvider,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from '../../../src/cache/embedding.js';
import { normalize } from '../../../src/cache/embedding.js';

class TrigramProvider implements EmbeddingProvider {
  readonly model = 'trigram';
  readonly dimensions = 16;
  embed(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i + 2 < text.length; i += 1) {
      const n = (text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) * 31 + text.charCodeAt(i + 2);
      v[n % this.dimensions] = (v[n % this.dimensions] ?? 0) + 1;
    }
    return normalize(v);
  }
}

function req(text: string): IRRequest {
  return { model: 'vm', messages: [{ role: 'user', content: [{ type: 'text', text } as IRTextContent] }], stream: false };
}

function resp(text: string): IRResponse {
  return {
    id: 'r1', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'text', text }] }, finishReason: 'stop' }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 },
    finishReason: 'stop',
  };
}

describe('SemanticCache', () => {
  let db: TestDbHandle;
  let cache: SemanticCache;
  let prev: EmbeddingProvider;

  beforeEach(() => {
    db = openTestDatabase();
    prev = getEmbeddingProvider();
    setEmbeddingProvider(new TrigramProvider());
    cache = new SemanticCache(db.db, { threshold: 0.5, defaultTtlSeconds: 60, maxCandidates: 32 });
  });

  afterEach(() => {
    setEmbeddingProvider(prev);
    db.cleanup();
  });

  it('returns miss for empty cache', () => {
    expect(cache.lookup('vm', req('hi')).kind).toBe('miss');
  });

  it('returns hit for very similar text', () => {
    const now = Date.now();
    cache.store('e1', 'vm', req('What is the weather in Paris?'), resp('sunny'), now);
    const result = cache.lookup('vm', req('Tell me the weather in Paris'), now + 100);
    expect(result.kind).toBe('semantic');
    if (result.kind === 'semantic') {
      expect(result.entryId).toBe('e1');
      expect(result.similarity).toBeGreaterThan(0.5);
    }
  });

  it('returns miss for completely different vm', () => {
    const now = Date.now();
    cache.store('e1', 'vm-a', req('a'), resp('a'), now);
    expect(cache.lookup('vm-b', req('a'), now + 100).kind).toBe('miss');
  });

  it('invalidateExpired drops stale entries', () => {
    const past = Date.now() - 100_000;
    cache.store('e1', 'vm', req('hi'), resp('hi'), past);
    const removed = cache.invalidateExpired(Date.now());
    expect(removed).toBe(1);
    expect(cache.lookup('vm', req('hi'), Date.now()).kind).toBe('miss');
  });

  it('invalidateVirtualModel clears all entries for a vm', () => {
    const now = Date.now();
    cache.store('e1', 'vm', req('a'), resp('a'), now);
    cache.store('e2', 'vm', req('b'), resp('b'), now);
    cache.store('e3', 'other', req('c'), resp('c'), now);
    expect(cache.invalidateVirtualModel('vm')).toBe(2);
    expect(cache.lookup('vm', req('a'), now + 1).kind).toBe('miss');
  });
});
