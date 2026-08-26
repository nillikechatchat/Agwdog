import type { BudgetRepo } from '../storage/repos/budget.js';
import type { EventRepo } from '../storage/repos/events.js';
import type { KeyRepo } from '../storage/repos/keys.js';
import type { BudgetMode, BudgetPeriod, KeyRow } from '../storage/types.js';

/** A period snapshot held in memory for fast checks; mirrors the SQLite row. */
export interface PeriodState {
  keyId: string;
  periodType: BudgetPeriod;
  periodKey: string;
  spentUsd: number;
  budgetUsd: number | null;
  warnedAt80: boolean;
}

export interface BudgetSnapshot {
  day: PeriodState;
  month: PeriodState;
  total: PeriodState;
}

export interface BudgetCheckResult {
  ok: boolean;
  /** Which period (if any) would be exceeded by the additional cost. */
  exceeded: BudgetPeriod | null;
  snapshot: BudgetSnapshot;
}

/** UTC day key formatted as `YYYY-MM-DD`; used in `budget_counters.period_key`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** UTC month key formatted as `YYYY-MM`. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class BudgetTracker {
  private readonly cache = new Map<string, BudgetSnapshot>();

  constructor(
    private readonly keys: KeyRepo,
    private readonly events: EventRepo,
    private readonly budgets: BudgetRepo,
    private readonly now: () => number = Date.now,
  ) {}

  /** Build (or fetch from cache) the three-period snapshot for a key. */
  snapshotFor(key: KeyRow): BudgetSnapshot {
    const cached = this.cache.get(key.id);
    const nowMs = this.now();
    const dk = dayKey(nowMs);
    const mk = monthKey(nowMs);

    if (cached && cached.day.periodKey === dk && cached.month.periodKey === mk) {
      return cached;
    }
    const fresh: BudgetSnapshot = {
      day: this.loadPeriod(key, 'day', dk, key.budget_daily_usd),
      month: this.loadPeriod(key, 'month', mk, key.budget_monthly_usd),
      total: this.loadPeriod(key, 'total', 'all', key.budget_total_usd),
    };
    this.cache.set(key.id, fresh);
    return fresh;
  }

  /**
   * Check whether the next `costUsd` of usage is allowed for `key`. In `hard` mode,
   * the function does not consume any quota and the caller must surface a 402 when
   * `ok === false`. In `soft` mode the function always reports `ok: true` so the
   * request proceeds and the event is logged after the spend is committed.
   */
  check(key: KeyRow, costUsd: number, mode: BudgetMode = key.budget_mode): BudgetCheckResult {
    const snap = this.snapshotFor(key);
    if (costUsd <= 0) return { ok: true, exceeded: null, snapshot: snap };
    if (mode === 'soft') return { ok: true, exceeded: null, snapshot: snap };

    const nextDay = snap.day.spentUsd + costUsd;
    if (snap.day.budgetUsd !== null && nextDay > snap.day.budgetUsd) {
      return { ok: false, exceeded: 'day', snapshot: snap };
    }
    const nextMonth = snap.month.spentUsd + costUsd;
    if (snap.month.budgetUsd !== null && nextMonth > snap.month.budgetUsd) {
      return { ok: false, exceeded: 'month', snapshot: snap };
    }
    const nextTotal = snap.total.spentUsd + costUsd;
    if (snap.total.budgetUsd !== null && nextTotal > snap.total.budgetUsd) {
      return { ok: false, exceeded: 'total', snapshot: snap };
    }
    return { ok: true, exceeded: null, snapshot: snap };
  }

  /**
   * Commit `costUsd` to all three periods and write any threshold events. The cache is
   * updated in place; on period rollover the next snapshotFor() will reload from SQLite.
   */
  commit(key: KeyRow, costUsd: number): { snapshot: BudgetSnapshot; warnings: BudgetPeriod[] } {
    if (costUsd <= 0) {
      return { snapshot: this.snapshotFor(key), warnings: [] };
    }
    const nowMs = this.now();
    const snap = this.snapshotFor(key);
    const warnings: BudgetPeriod[] = [];

    this.applyOne(key, snap.day, 'day', dayKey(nowMs), costUsd, nowMs, warnings);
    this.applyOne(key, snap.month, 'month', monthKey(nowMs), costUsd, nowMs, warnings);
    this.applyOne(key, snap.total, 'total', 'all', costUsd, nowMs, warnings);

    return { snapshot: snap, warnings };
  }

  /** Reset a specific period counter; used by the admin API and tests. */
  reset(keyId: string, period: BudgetPeriod, periodKey: string, nowMs = this.now()): void {
    const snap = this.cache.get(keyId);
    if (snap) {
      const target = period === 'day' ? snap.day : period === 'month' ? snap.month : snap.total;
      target.spentUsd = 0;
      target.warnedAt80 = false;
    }
    this.events.append({ keyId, type: 'budget_reset', payload: { period, periodKey } }, nowMs);
  }

  /** Drop in-memory state. Primarily for tests. */
  clearCache(): void {
    this.cache.clear();
  }

  private applyOne(
    key: KeyRow,
    state: PeriodState,
    period: BudgetPeriod,
    periodKey: string,
    costUsd: number,
    nowMs: number,
    warnings: BudgetPeriod[],
  ): void {
    if (state.periodKey !== periodKey) {
      const fresh = this.loadPeriod(key, period, periodKey, this.budgetFor(key, period));
      Object.assign(state, fresh);
    }
    const newSpent = this.budgets.increment(key.id, period, periodKey, costUsd, nowMs);
    state.spentUsd = newSpent;
    state.budgetUsd = this.budgetFor(key, period);
    if (state.budgetUsd !== null && !state.warnedAt80 && state.spentUsd >= state.budgetUsd * 0.8) {
      state.warnedAt80 = true;
      this.budgets.markWarned(key.id, period, periodKey, nowMs);
      warnings.push(period);
      this.events.append(
        {
          keyId: key.id,
          type: 'budget_warning',
          payload: {
            period,
            periodKey,
            spentUsd: state.spentUsd,
            budgetUsd: state.budgetUsd,
            threshold: 0.8,
          },
        },
        nowMs,
      );
    }
  }

  private loadPeriod(key: KeyRow, period: BudgetPeriod, periodKey: string, budgetUsd: number | null): PeriodState {
    const row = this.budgets.getCounter(key.id, period, periodKey);
    return {
      keyId: key.id,
      periodType: period,
      periodKey,
      spentUsd: row?.spent_usd ?? 0,
      budgetUsd,
      warnedAt80: row ? row.warned_at_80 === 1 : false,
    };
  }

  private budgetFor(key: KeyRow, period: BudgetPeriod): number | null {
    if (period === 'day') return key.budget_daily_usd ?? null;
    if (period === 'month') return key.budget_monthly_usd ?? null;
    return key.budget_total_usd ?? null;
  }
}
