import type { Database } from 'better-sqlite3';
import type { BudgetMode, KeyRow, KeyStatus } from '../types.js';

export interface NewKeyInput {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  status?: KeyStatus;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  allowedModels?: string[] | null;
  responseCacheTtlSeconds?: number;
  budgetMode?: BudgetMode;
  budgetDailyUsd?: number | null;
  budgetMonthlyUsd?: number | null;
  budgetTotalUsd?: number | null;
  cacheEnabled?: boolean;
  logRequests?: boolean;
  logSampleRate?: number;
}

export class KeyRepo {
  constructor(private readonly db: Database) {}

  insert(input: NewKeyInput, now = Date.now()): KeyRow {
    this.db
      .prepare(
        `INSERT INTO keys (
          id, name, key_hash, prefix, status, rpm_limit, tpm_limit, allowed_models_json,
          response_cache_ttl_seconds, budget_mode, budget_daily_usd, budget_monthly_usd,
          budget_total_usd, cache_enabled, log_requests, log_sample_rate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.keyHash,
        input.prefix,
        input.status ?? 'active',
        input.rpmLimit ?? null,
        input.tpmLimit ?? null,
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.responseCacheTtlSeconds ?? 86400,
        input.budgetMode ?? 'soft',
        input.budgetDailyUsd ?? null,
        input.budgetMonthlyUsd ?? null,
        input.budgetTotalUsd ?? null,
        input.cacheEnabled === false ? 0 : 1,
        input.logRequests ? 1 : 0,
        input.logSampleRate ?? 1.0,
        now,
      );
    return this.getById(input.id) as KeyRow;
  }

  list(): KeyRow[] {
    return this.db.prepare(`SELECT * FROM keys ORDER BY created_at DESC`).all() as KeyRow[];
  }

  getById(id: string): KeyRow | undefined {
    return this.db.prepare(`SELECT * FROM keys WHERE id = ?`).get(id) as KeyRow | undefined;
  }

  findByHash(hash: string): KeyRow | undefined {
    return this.db.prepare(`SELECT * FROM keys WHERE key_hash = ?`).get(hash) as KeyRow | undefined;
  }

  revoke(id: string, now = Date.now()): void {
    this.db.prepare(`UPDATE keys SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM keys WHERE id = ?`).run(id);
  }
}