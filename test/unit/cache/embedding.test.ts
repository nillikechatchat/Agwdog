import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  embed,
  normalize,
  serializeEmbedding,
  deserializeEmbedding,
} from '../../../src/cache/embedding.js';
import type { EmbeddingProvider } from '../../../src/cache/embedding.js';

class AltProvider implements EmbeddingProvider {
  readonly model = 'alt-v1';
  readonly dimensions = 8;
  embed(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i += 1) v[i] = (text.charCodeAt(i % text.length) || 0) / 255;
    return normalize(v);
  }
}

describe('embedding', () => {
  it('embed returns a 64-dim normalized vector', () => {
    const v = embed('hello world');
    expect(v.length).toBe(64);
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[i]! * v[i]!;
    expect(Math.abs(s - 1)).toBeLessThan(0.01);
  });

  it('cosine of identical vectors is 1', () => {
    const v = embed('same text');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('cosine of different vectors is < 1', () => {
    const a = embed('apple');
    const b = embed('banana');
    expect(cosineSimilarity(a, b)).toBeLessThan(1);
  });

  it('serialize + deserialize round-trips', () => {
    const v = embed('round trip');
    const buf = serializeEmbedding(v);
    const out = deserializeEmbedding(buf, 64);
    expect(out.length).toBe(64);
    for (let i = 0; i < v.length; i += 1) expect(out[i]).toBeCloseTo(v[i]!, 6);
  });

  it('cosine returns 0 for different-length vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('embedding provider swap', () => {
  it('uses the active provider', async () => {
    const { setEmbeddingProvider, getEmbeddingProvider } = await import('../../../src/cache/embedding.js');
    const prev = getEmbeddingProvider();
    setEmbeddingProvider(new AltProvider());
    try {
      expect(getEmbeddingProvider().model).toBe('alt-v1');
      const v = embed('x');
      expect(v.length).toBe(8);
    } finally {
      setEmbeddingProvider(prev);
    }
  });
});
