import type { Database } from 'better-sqlite3';
import type { CacheEntryRow, ClientProtocol } from '../types.js';

export interface NewCacheEntryInput {
  fingerprint: string;
  keyId?: string | null;
  clientProtocol: ClientProtocol;
  model: string;
  responseJson: string;
  expiresAt: number;
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: CacheEntryRow;
}

export class CacheRepo {
  constructor(private readonly db: Database) {}

  get(fingerprint: string): CacheEntryRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cache_entries WHERE fingerprint = ?`)
      .get(fingerprint) as CacheEntryRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    return row;
  }

  put(input: NewCacheEntryInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO cache_entries (
          fingerprint, key_id, client_protocol, model, response_json, hit_count, last_hit_at, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          response_json = excluded.response_json,
          expires_at = excluded.expires_at`,
      )
      .run(input.fingerprint, input.keyId ?? null, input.clientProtocol, input.model, input.responseJson, input.expiresAt, now);
  }

  recordHit(fingerprint: string, now = Date.now()): void {
    this.db
      .prepare(`UPDATE cache_entries SET hit_count = hit_count + 1, last_hit_at = ? WHERE fingerprint = ?`)
      .run(now, fingerprint);
  }

  delete(fingerprint: string): void {
    this.db.prepare(`DELETE FROM cache_entries WHERE fingerprint = ?`).run(fingerprint);
  }

  clearAll(): number {
    const r = this.db.prepare(`DELETE FROM cache_entries`).run();
    return r.changes;
  }

  /** Aggregate stats for the management dashboard. */
  stats(now = Date.now()): { total: number; live: number; expired: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM cache_entries`).get() as { c: number }).c;
    const live = (this.db.prepare(`SELECT COUNT(*) AS c FROM cache_entries WHERE expires_at > ?`).get(now) as { c: number }).c;
    return { total, live, expired: total - live };
  }
}