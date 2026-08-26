import type { Database, Statement } from 'better-sqlite3';
import type { PromptCacheMarker } from './types.js';

interface PromptCacheRow {
  id: string;
  virtual_model_id: string;
  cache_key: string;
  client_protocol: string;
  upstream_provider_id: string | null;
  upstream_model_id: string | null;
  cache_control_json: string;
  prefix_tokens: number;
  cached_tokens: number;
  created_at: number;
  last_hit_at: number | null;
  hit_count: number;
}

/**
 * Tracks `cache_control` markers from Anthropic (and OpenAI's auto-cache
 * for gpt-4o) so the admin UI can show which prefixes are being reused.
 * The actual prompt caching is performed by the upstream provider; this
 * record is purely for observability.
 */
export class PromptCacheTracker {
  private readonly putStmt: Statement;
  private readonly lookupStmt: Statement;
  private readonly touchStmt: Statement;
  private readonly listStmt: Statement;
  private readonly delAllStmt: Statement;

  constructor(private readonly db: Database) {
    this.putStmt = db.prepare(`
      INSERT INTO prompt_cache_records
        (id, virtual_model_id, cache_key, client_protocol, upstream_provider_id, upstream_model_id,
         cache_control_json, prefix_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cache_control_json = excluded.cache_control_json,
        prefix_tokens = excluded.prefix_tokens
    `);
    this.lookupStmt = db.prepare(`SELECT * FROM prompt_cache_records WHERE cache_key = ? LIMIT 1`);
    this.touchStmt = db.prepare(`UPDATE prompt_cache_records SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`);
    this.listStmt = db.prepare(`
      SELECT * FROM prompt_cache_records
      WHERE virtual_model_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    this.delAllStmt = db.prepare(`DELETE FROM prompt_cache_records WHERE virtual_model_id = ?`);
  }

  record(id: string, vmId: string, marker: PromptCacheMarker, upstreamProviderId: string | null, upstreamModelId: string | null, now: number = Date.now()): void {
    this.putStmt.run(
      id, vmId, marker.cacheKey, marker.clientProtocol, upstreamProviderId, upstreamModelId,
      JSON.stringify(marker.cacheControl), marker.prefixTokens, now,
    );
  }

  /** Touch a marker when the upstream reports cached_tokens for a given cache_key. */
  touch(cacheKey: string, now: number = Date.now()): void {
    this.touchStmt.run(now, cacheKey);
  }

  find(cacheKey: string): PromptCacheRow | null {
    return (this.lookupStmt.get(cacheKey) as PromptCacheRow | undefined) ?? null;
  }

  listForVirtualModel(vmId: string, limit: number = 50): PromptCacheRow[] {
    return this.listStmt.all(vmId, limit) as PromptCacheRow[];
  }

  clear(vmId: string): number {
    return this.delAllStmt.run(vmId).changes;
  }
}
