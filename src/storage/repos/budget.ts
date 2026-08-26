import type { Database } from 'better-sqlite3';
import type { BudgetCounterRow, BudgetPeriod } from '../types.js';

export interface BudgetIncrementResult {
  spent: number;
  budget: number | null;
  crossedThreshold: boolean;
  exceeded: boolean;
}

export class BudgetRepo {
  constructor(private readonly db: Database) {}

  getCounter(keyId: string, periodType: BudgetPeriod, periodKey: string): BudgetCounterRow | undefined {
    return this.db
      .prepare(`SELECT * FROM budget_counters WHERE key_id = ? AND period_type = ? AND period_key = ?`)
      .get(keyId, periodType, periodKey) as BudgetCounterRow | undefined;
  }

  listForKey(keyId: string): BudgetCounterRow[] {
    return this.db.prepare(`SELECT * FROM budget_counters WHERE key_id = ?`).all(keyId) as BudgetCounterRow[];
  }

  /**
   * Atomically increment the counter for (key, period, periodKey) and return the new total.
   * If the row does not exist, it is created with the supplied amount.
   */
  increment(keyId: string, periodType: BudgetPeriod, periodKey: string, amount: number, now = Date.now()): number {
    const existing = this.getCounter(keyId, periodType, periodKey);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO budget_counters (key_id, period_type, period_key, spent_usd, warned_at_80, updated_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(keyId, periodType, periodKey, amount, now);
      return amount;
    }
    const newSpent = existing.spent_usd + amount;
    this.db
      .prepare(`UPDATE budget_counters SET spent_usd = ?, updated_at = ? WHERE key_id = ? AND period_type = ? AND period_key = ?`)
      .run(newSpent, now, keyId, periodType, periodKey);
    return newSpent;
  }

  /** Mark the threshold as warned (deduped per period). */
  markWarned(keyId: string, periodType: BudgetPeriod, periodKey: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE budget_counters SET warned_at_80 = 1, updated_at = ?
         WHERE key_id = ? AND period_type = ? AND period_key = ?`,
      )
      .run(now, keyId, periodType, periodKey);
  }

  reset(keyId: string, periodType: BudgetPeriod, periodKey: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE budget_counters SET spent_usd = 0, warned_at_80 = 0, updated_at = ?
         WHERE key_id = ? AND period_type = ? AND period_key = ?`,
      )
      .run(now, keyId, periodType, periodKey);
  }
}