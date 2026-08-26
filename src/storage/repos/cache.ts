import type { Database } from 'better-sqlite3';
import type { CacheEntryRow, ClientProtocol } from '../types.js';

export interface NewCacheEntryInput {
  fingerprint: string;
  keyId?: string | null;
  clientProtocol: ClientProtocol;
  model: string;
  responseJson: string;
  ttlSeconds?: number;
}

export interface CacheLookupResult {
  entry: CacheEntryRow;
  response: unknown;
  hit: boolean;
}

export class CacheRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert or replace a cache entry keyed by `fingerprint`. The caller has already
   * computed the SHA-256 fingerprint from the request IR; we trust that here.
   */
  put(input: NewCacheEntryInput, now = Date.now()): CacheEntryRow {
    const ttl = input.ttlSeconds ?? 86400;
    const expires = now + ttl * 1000;
    this.db
      .prepare(
        `INSERT INTO cache_entries (
          fingerprint, key_id, client_protocol, model, response_json, hit_count, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          response_json = excluded.response_json,
          expires_at = excluded.expires_at,
          key_id = excluded.key_id,
          client_protocol = excluded.client_protocol,
          model = excluded.model`,
      )
      .run(
        input.fingerprint,
        input.keyId ?? null,
        input.clientProtocol,
        input.model,
        input.responseJson,
        expires,
        now,
      );
    return this.getByFingerprint(input.fingerprint, now) as CacheEntryRow;
  }

  /**
   * Look up an entry by fingerprint. Returns `null` if absent or expired; never
   * throws. The `hit_count` and `last_hit_at` columns are updated atomically on
   * a live hit so the admin dashboard can show popularity.
   */
  getByFingerprint(fingerprint: string, now = Date.now()): CacheEntryRow | null {
    const row = this.db
      .prepare(`SELECT * FROM cache_entries WHERE fingerprint = ?`)
      .get(fingerprint) as CacheEntryRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) return null;
    return row;
  }

  /**
   * Record a cache hit (bumps `hit_count` and `last_hit_at`). Safe to call even
   * if the entry has been concurrently deleted; in that case no row is updated.
   */
  recordHit(fingerprint: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE cache_entries
           SET hit_count = hit_count + 1, last_hit_at = ?
         WHERE fingerprint = ?`,
      )
      .run(now, fingerprint);
  }

  /** Remove an entry (used by the admin DELETE /admin/api/cache endpoint). */
  delete(fingerprint: string): void {
    this.db.prepare(`DELETE FROM cache_entries WHERE fingerprint = ?`).run(fingerprint);
  }

  /** Remove every entry (admin "Clear cache" action). */
  clear(): number {
    const res = this.db.prepare(`DELETE FROM cache_entries`).run();
    return res.changes;
  }

  /** Count live (non-expired) entries. */
  count(now = Date.now()): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM cache_entries WHERE expires_at > ?`)
      .get(now) as { c: number };
    return row.c;
  }

  /** Sweep expired entries; returns the number removed. */
  prune(now = Date.now()): number {
    const res = this.db.prepare(`DELETE FROM cache_entries WHERE expires_at <= ?`).run(now);
    return res.changes;
  }

  /** Convenience: look up + parse the response body + bump hit_count. */
  lookup(fingerprint: string, now = Date.now()): CacheLookupResult | null {
    const entry = this.getByFingerprint(fingerprint, now);
    if (!entry) return null;
    let response: unknown;
    try {
      response = JSON.parse(entry.response_json);
    } catch {
      return null;
    }
    this.recordHit(fingerprint, now);
    return { entry, response, hit: true };
  }
}
