import type { Database, Statement } from 'better-sqlite3';
import type { IRRequest, IRResponse, IRTextContent } from '../ir/types.js';
import { cosineSimilarity, deserializeEmbedding, embed, getEmbeddingProvider, serializeEmbedding } from './embedding.js';
import type { CacheLookupResult, SemanticEntry } from './types.js';

export interface SemanticCacheOptions {
  threshold: number;
  defaultTtlSeconds: number;
  maxCandidates: number;
}

export const DEFAULT_SEMANTIC_OPTIONS: SemanticCacheOptions = {
  threshold: 0.92,
  defaultTtlSeconds: 86_400,
  maxCandidates: 64,
};

interface SemanticRow {
  id: string;
  virtual_model_id: string;
  embedding: Buffer;
  embedding_model: string;
  request_json: string;
  response_json: string;
  ttl_seconds: number;
  created_at: number;
  expires_at: number;
  hit_count: number;
}

export class SemanticCache {
  private readonly putStmt: Statement;
  private readonly listStmt: Statement;
  private readonly incStmt: Statement;
  private readonly delExpiredStmt: Statement;
  private readonly delVmStmt: Statement;

  constructor(
    private readonly db: Database,
    private readonly opts: SemanticCacheOptions = DEFAULT_SEMANTIC_OPTIONS,
  ) {
    this.putStmt = db.prepare(`
      INSERT INTO semantic_cache
        (id, virtual_model_id, embedding, embedding_model, request_json, response_json, ttl_seconds, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        expires_at = excluded.expires_at
    `);
    this.listStmt = db.prepare(`
      SELECT id, virtual_model_id, embedding, embedding_model, request_json, response_json,
             ttl_seconds, created_at, expires_at, hit_count
      FROM semantic_cache
      WHERE virtual_model_id = ? AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.incStmt = db.prepare(`UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = ?`);
    this.delExpiredStmt = db.prepare(`DELETE FROM semantic_cache WHERE expires_at <= ?`);
    this.delVmStmt = db.prepare(`DELETE FROM semantic_cache WHERE virtual_model_id = ?`);
  }

  store(id: string, vmId: string, request: IRRequest, response: IRResponse, now: number = Date.now()): SemanticEntry {
    const text = requestToText(request);
    const vector = embed(text);
    const ttl = this.opts.defaultTtlSeconds;
    const emb = serializeEmbedding(vector);
    this.putStmt.run(
      id, vmId, emb, getEmbeddingProvider().model,
      JSON.stringify(request), JSON.stringify(response),
      ttl, now, now + ttl * 1000,
    );
    return {
      id, virtualModelId: vmId, embedding: vector, embeddingModel: getEmbeddingProvider().model,
      request, response, ttlSeconds: ttl, createdAt: now,
    };
  }

  lookup(virtualModelId: string, request: IRRequest, now: number = Date.now()): CacheLookupResult {
    const text = requestToText(request);
    const q = embed(text);
    const rows = this.listStmt.all(virtualModelId, now, this.opts.maxCandidates) as SemanticRow[];
    let best: { row: SemanticRow; sim: number } | null = null;
    for (const row of rows) {
      const v = deserializeEmbedding(row.embedding, q.length);
      const sim = cosineSimilarity(q, v);
      if (!best || sim > best.sim) best = { row, sim };
    }
    if (!best || best.sim < this.opts.threshold) return { kind: 'miss' };
    this.incStmt.run(best.row.id);
    const response = JSON.parse(best.row.response_json) as IRResponse;
    return {
      kind: 'semantic',
      response,
      entryId: best.row.id,
      similarity: best.sim,
      age: now - best.row.created_at,
    };
  }

  invalidateExpired(now: number = Date.now()): number {
    const r = this.delExpiredStmt.run(now);
    return r.changes;
  }

  invalidateVirtualModel(virtualModelId: string): number {
    const r = this.delVmStmt.run(virtualModelId);
    return r.changes;
  }
}

function requestToText(r: IRRequest): string {
  const parts: string[] = [];
  for (const m of r.messages) {
    for (const c of m.content) {
      if (c.type === 'text') parts.push((c as IRTextContent).text);
    }
  }
  return parts.join('\n');
}
