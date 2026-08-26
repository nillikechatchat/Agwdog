import type { Database } from 'better-sqlite3';
import type { ClientProtocol, ResponseCacheRow } from '../types.js';

export interface NewResponseCacheInput {
  id: string;
  keyId?: string | null;
  clientProtocol: ClientProtocol;
  virtualModelId?: string | null;
  upstreamProviderId?: string | null;
  upstreamModelId?: string | null;
  requestJson: string;
  responseJson: string;
  ttlSeconds?: number;
}

export class ResponseCacheRepo {
  constructor(private readonly db: Database) {}

  put(input: NewResponseCacheInput, now = Date.now()): void {
    const ttl = input.ttlSeconds ?? 86400;
    const expires = now + ttl * 1000;
    this.db
      .prepare(
        `INSERT INTO response_cache (
          id, key_id, client_protocol, virtual_model_id, upstream_provider_id, upstream_model_id,
          request_json, response_json, ttl_seconds, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          response_json = excluded.response_json,
          expires_at = excluded.expires_at`,
      )
      .run(
        input.id,
        input.keyId ?? null,
        input.clientProtocol,
        input.virtualModelId ?? null,
        input.upstreamProviderId ?? null,
        input.upstreamModelId ?? null,
        input.requestJson,
        input.responseJson,
        ttl,
        now,
        expires,
      );
  }

  get(id: string): ResponseCacheRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM response_cache WHERE id = ?`)
      .get(id) as ResponseCacheRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    return row;
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM response_cache WHERE id = ?`).run(id);
  }
}