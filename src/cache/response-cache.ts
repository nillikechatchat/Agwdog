import type { Database, Statement } from 'better-sqlite3';

export interface ResponseCacheEntry {
  id: string;
  keyId: string | null;
  clientProtocol: string;
  virtualModelId: string | null;
  upstreamProviderId: string | null;
  upstreamModelId: string | null;
  requestJson: string;
  responseJson: string;
  ttlSeconds: number;
  createdAt: number;
  expiresAt: number;
}

interface ResponseCacheRow {
  id: string;
  key_id: string | null;
  client_protocol: string;
  virtual_model_id: string | null;
  upstream_provider_id: string | null;
  upstream_model_id: string | null;
  request_json: string;
  response_json: string;
  ttl_seconds: number;
  created_at: number;
  expires_at: number;
}

/**
 * Continuation cache for the Responses API's `previous_response_id` feature.
 * Stores the full request/response payload so multi-turn conversations can
 * resume a stateful provider response.
 */
export class ResponseContinuationCache {
  private readonly putStmt: Statement;
  private readonly getStmt: Statement;
  private readonly delExpiredStmt: Statement;

  constructor(private readonly db: Database) {
    this.putStmt = db.prepare(`
      INSERT INTO response_cache
        (id, key_id, client_protocol, virtual_model_id, upstream_provider_id, upstream_model_id,
         request_json, response_json, ttl_seconds, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        expires_at = excluded.expires_at
    `);
    this.getStmt = db.prepare(`SELECT * FROM response_cache WHERE id = ? AND expires_at > ?`);
    this.delExpiredStmt = db.prepare(`DELETE FROM response_cache WHERE expires_at <= ?`);
  }

  put(entry: ResponseCacheEntry): void {
    this.putStmt.run(
      entry.id, entry.keyId, entry.clientProtocol, entry.virtualModelId,
      entry.upstreamProviderId, entry.upstreamModelId, entry.requestJson, entry.responseJson,
      entry.ttlSeconds, entry.createdAt, entry.expiresAt,
    );
  }

  get(id: string, now: number = Date.now()): ResponseCacheEntry | null {
    const row = this.getStmt.get(id, now) as ResponseCacheRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      keyId: row.key_id,
      clientProtocol: row.client_protocol,
      virtualModelId: row.virtual_model_id,
      upstreamProviderId: row.upstream_provider_id,
      upstreamModelId: row.upstream_model_id,
      requestJson: row.request_json,
      responseJson: row.response_json,
      ttlSeconds: row.ttl_seconds,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  invalidateExpired(now: number = Date.now()): number {
    return this.delExpiredStmt.run(now).changes;
  }
}
