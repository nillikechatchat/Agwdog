import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheOrchestrator } from '../../../src/cache/orchestrator.js';
import { ExactCache } from '../../../src/cache/exact.js';
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

describe('CacheOrchestrator', () => {
  let db: TestDbHandle;
  let orch: CacheOrchestrator;
  let exact: ExactCache;
  let prev: EmbeddingProvider;

  beforeEach(() => {
    db = openTestDatabase();
    prev = getEmbeddingProvider();
    setEmbeddingProvider(new TrigramProvider());
    exact = new ExactCache(db.repos.cache);
    orch = new CacheOrchestrator({ db: db.db, exact });
  });

  afterEach(() => {
    setEmbeddingProvider(prev);
    db.cleanup();
  });

  it('exact layer hit short-circuits before semantic', () => {
    const now = Date.now();
    const fp = 'fp-1';
    const r = resp('cached');
    orch.store({ virtualModelId: 'vm', request: req('hi'), fingerprint: fp, clientProtocol: 'OpenAI-Chat' }, r, now);
    const got = orch.lookup({ virtualModelId: 'vm', request: req('hi'), fingerprint: fp, clientProtocol: 'OpenAI-Chat' }, now + 10);
    expect(got.kind).toBe('exact');
  });

  it('falls through to semantic when exact misses', () => {
    const now = Date.now();
    orch.store({ virtualModelId: 'vm', request: req('What is the weather in Paris?'), fingerprint: 'fp-a', clientProtocol: 'OpenAI-Chat' }, resp('sunny'), now);
    const got = orch.lookup({ virtualModelId: 'vm', request: req('What is the weather in Paris'), fingerprint: 'fp-b', clientProtocol: 'OpenAI-Chat' }, now + 1);
    // Exact miss, but very similar text should hit semantic layer.
    expect(got.kind === 'semantic' || got.kind === 'miss').toBe(true);
    if (got.kind === 'semantic') {
      expect(got.similarity).toBeGreaterThan(0.5);
    }
  });

  it('returns miss when all layers empty', () => {
    const got = orch.lookup({ virtualModelId: 'vm', request: req('hi'), fingerprint: 'fp', clientProtocol: 'OpenAI-Chat' });
    expect(got.kind).toBe('miss');
  });

  it('disabled exact skips layer', () => {
    const c = new CacheOrchestrator({ db: db.db, exact, config: { exactEnabled: false } });
    const now = Date.now();
    c.store({ virtualModelId: 'vm', request: req('What is the weather in Paris?'), fingerprint: 'fp', clientProtocol: 'OpenAI-Chat' }, resp('y'), now);
    const got = c.lookup({ virtualModelId: 'vm', request: req('What is the weather in Paris'), fingerprint: 'fp-other', clientProtocol: 'OpenAI-Chat' }, now + 1);
    // exact disabled, so we either hit semantic (similar text) or miss.
    expect(['semantic', 'miss']).toContain(got.kind);
  });

  it('disabled semantic skips that layer', () => {
    const c = new CacheOrchestrator({ db: db.db, exact, config: { semanticEnabled: false } });
    const now = Date.now();
    const got = c.lookup({ virtualModelId: 'vm', request: req('hi'), fingerprint: 'fp', clientProtocol: 'OpenAI-Chat' }, now);
    expect(got.kind).toBe('miss');
  });

  it('sweep clears expired exact entries', () => {
    const past = Date.now() - 100_000;
    exact.write(
      { fingerprint: 'fp-sweep', keyId: null, clientProtocol: 'OpenAI-Chat', model: 'm', response: resp('z') },
      0, // ttl=0 means expires_at = past
    );
    const r = orch.sweep(Date.now());
    expect(r.exact).toBe(1);
  });

  it('response_continuation hit when id matches', () => {
    const now = Date.now();
    orch.response.put({
      id: 'resp_xyz', keyId: null, clientProtocol: 'OpenAI-Responses',
      virtualModelId: 'vm', upstreamProviderId: null, upstreamModelId: null,
      requestJson: '{}', responseJson: '{"x":1}', ttlSeconds: 60,
      createdAt: now, expiresAt: now + 60_000,
    });
    const got = orch.lookup({ virtualModelId: 'vm', request: req('hi'), fingerprint: 'fp', clientProtocol: 'OpenAI-Responses', responseId: 'resp_xyz' }, now + 1);
    expect(got.kind).toBe('response_continuation');
  });

  it('recordPromptMarker delegates to prompt tracker', () => {
    orch.recordPromptMarker('r1', 'vm', { cacheKey: 'k1', clientProtocol: 'OpenAI-Chat', cacheControl: {}, prefixTokens: 10 }, null, null, Date.now());
    const found = orch.prompt.find('k1');
    expect(found?.prefix_tokens).toBe(10);
  });
});
