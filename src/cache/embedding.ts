/**
 * Pluggable embedding provider. The default is a deterministic hash-based
 * pseudo-embedder suitable for tests and offline operation; real deployments
 * can swap in an OpenAI / Cohere / local model via `setEmbeddingProvider`.
 */
export interface EmbeddingProvider {
  /** Stable identifier for the embedding model (e.g. `text-embedding-3-small`). */
  readonly model: string;
  /** Dimensionality of the vectors. */
  readonly dimensions: number;
  /** Embed the textual part of an IR request. */
  embed(text: string): Float32Array;
}

class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hash-v1';
  readonly dimensions = 64;

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Fill the vector with 32-bit hash variants.
    for (let i = 0; i < this.dimensions; i += 1) {
      h ^= h << 13; h >>>= 0;
      h ^= h >>> 17;
      h ^= h << 5; h >>>= 0;
      v[i] = ((h >>> 0) / 0xffffffff) * 2 - 1; // -1..1
    }
    return normalize(v);
  }
}

let activeProvider: EmbeddingProvider = new HashEmbeddingProvider();

export function setEmbeddingProvider(p: EmbeddingProvider): void {
  activeProvider = p;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return activeProvider;
}

export function embed(text: string): Float32Array {
  return activeProvider.embed(text);
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i]! / n;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function serializeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function deserializeEmbedding(buf: Buffer, dimensions: number): Float32Array {
  const out = new Float32Array(dimensions);
  const src = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  out.set(src.subarray(0, dimensions));
  return out;
}
