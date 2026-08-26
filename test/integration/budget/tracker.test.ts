import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';
import { generateVirtualKey } from '../../../src/auth/keys.js';
import { BudgetTracker, dayKey, monthKey } from '../../../src/budget/tracker.js';
import { KeyRepo } from '../../../src/storage/repos/keys.js';

let h: TestDbHandle;
let tracker: BudgetTracker;
let keys: KeyRepo;

function makeKey(over: Partial<Parameters<KeyRepo['insert']>[0]> = {}) {
  const { plaintext, hash, keyPrefix } = generateVirtualKey();
  return {
    plaintext,
    row: h.keys.insert({
      id: 'k1',
      name: 'test',
      keyHash: hash,
      prefix: keyPrefix,
      ...over,
    }),
  };
}

beforeEach(() => {
  h = openTestDatabase();
  keys = h.keys;
  tracker = new BudgetTracker(keys, h.events, h.budgets, () => 1_700_000_000_000);
});

afterEach(() => h.cleanup());

describe('dayKey / monthKey', () => {
  it('formats UTC day', () => {
    const ms = Date.UTC(2026, 0, 5, 23, 59); // Jan 5 2026 UTC
    expect(dayKey(ms)).toBe('2026-01-05');
  });

  it('formats UTC month', () => {
    const ms = Date.UTC(2026, 11, 31, 23, 59);
    expect(monthKey(ms)).toBe('2026-12');
  });
});

describe('BudgetTracker.check — hard mode', () => {
  it('rejects when daily budget would be exceeded', () => {
    const { row } = makeKey({ budgetDailyUsd: 1.0, budgetMode: 'hard' });
    expect(tracker.check(row, 0.5).ok).toBe(true);
    tracker.commit(row, 0.5); // commit so the counter is real
    expect(tracker.check(row, 0.6).ok).toBe(false);
  });

  it('rejects when monthly budget would be exceeded', () => {
    const { row } = makeKey({ budgetMonthlyUsd: 5.0, budgetMode: 'hard' });
    tracker.commit(row, 4.0);
    expect(tracker.check(row, 1.5).ok).toBe(false);
  });

  it('rejects when total budget would be exceeded', () => {
    const { row } = makeKey({ budgetTotalUsd: 10.0, budgetMode: 'hard' });
    tracker.commit(row, 9.0);
    expect(tracker.check(row, 2.0).ok).toBe(false);
  });

  it('null budgets mean unlimited', () => {
    const { row } = makeKey({ budgetMode: 'hard' });
    expect(tracker.check(row, 999_999).ok).toBe(true);
  });

  it('zero or negative cost always allowed', () => {
    const { row } = makeKey({ budgetDailyUsd: 0.1, budgetMode: 'hard' });
    expect(tracker.check(row, 0).ok).toBe(true);
    expect(tracker.check(row, -1).ok).toBe(true);
  });
});

describe('BudgetTracker.check — soft mode', () => {
  it('always reports ok even when over budget', () => {
    const { row } = makeKey({ budgetDailyUsd: 0.1, budgetMode: 'soft' });
    expect(tracker.check(row, 1000).ok).toBe(true);
  });
});

describe('BudgetTracker.commit', () => {
  it('persists the cost to all three periods', () => {
    const { row } = makeKey();
    tracker.commit(row, 0.25);
    tracker.commit(row, 0.75);

    const snap = tracker.snapshotFor(row);
    expect(snap.day.spentUsd).toBeCloseTo(1.0);
    expect(snap.month.spentUsd).toBeCloseTo(1.0);
    expect(snap.total.spentUsd).toBeCloseTo(1.0);

    // SQLite side: the row exists.
    const now = 1_700_000_000_000;
    const stored = h.budgets.getCounter(row.id, 'day', dayKey(now));
    expect(stored?.spent_usd).toBeCloseTo(1.0);
  });

  it('emits a budget_warning event when crossing 80% of budget', () => {
    const { row } = makeKey({ budgetDailyUsd: 1.0 });
    tracker.commit(row, 0.85);
    const events = h.events.listByKey(row.id, 10);
    const warnings = events.filter((e) => e.type === 'budget_warning');
    expect(warnings.length).toBe(1);
    const payload = JSON.parse(warnings[0]!.payload_json) as Record<string, unknown>;
    expect(payload['period']).toBe('day');
    expect(payload['threshold']).toBe(0.8);
  });

  it('does not emit a second warning on subsequent commits in the same period', () => {
    const { row } = makeKey({ budgetDailyUsd: 1.0 });
    tracker.commit(row, 0.85);
    tracker.commit(row, 0.10);
    tracker.commit(row, 0.04);
    const events = h.events.listByKey(row.id, 100);
    const warnings = events.filter((e) => e.type === 'budget_warning');
    expect(warnings.length).toBe(1);
  });
});

describe('BudgetTracker.reset', () => {
  it('clears in-memory spent counter and writes a budget_reset event', () => {
    const { row } = makeKey({ budgetDailyUsd: 1.0 });
    tracker.commit(row, 0.5);
    tracker.reset(row.id, 'day', dayKey(1_700_000_000_000));
    const snap = tracker.snapshotFor(row);
    expect(snap.day.spentUsd).toBe(0);
    const events = h.events.listByKey(row.id, 10);
    expect(events.some((e) => e.type === 'budget_reset')).toBe(true);
  });
});
