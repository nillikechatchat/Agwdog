import { unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/db.js';
import { Repositories } from '../../src/storage/index.js';
import type { KeyRepo } from '../../src/storage/repos/keys.js';
import type { BudgetRepo } from '../../src/storage/repos/budget.js';
import type { EventRepo } from '../../src/storage/repos/events.js';

export interface TestDbHandle {
  db: Database.Database;
  repos: Repositories;
  keys: KeyRepo;
  budgets: BudgetRepo;
  events: EventRepo;
  cleanup: () => void;
}

/** Open a temp SQLite DB with the gateway schema applied. The handle's `cleanup()`
 * closes the connection and removes the file. */
export function openTestDatabase(): TestDbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'gw-test-'));
  const file = join(dir, 'gateway.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db as never);
  const repos = new Repositories(db as never);
  return {
    db,
    repos,
    keys: repos.keys,
    budgets: repos.budget,
    events: repos.events,
    cleanup: () => {
      try { db.close(); } catch { /* noop */ }
      for (const suffix of ['', '-wal', '-shm']) {
        const p = file + suffix;
        if (existsSync(p)) {
          try { unlinkSync(p); } catch { /* noop */ }
        }
      }
    },
  };
}
