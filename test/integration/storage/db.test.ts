import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeDatabase,
  migrate,
  MigrationError,
  openDatabase,
  splitSqlStatements,
  type Database,
} from '@/storage/db.js';

let workDir: string;
let db: Database | null = null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-gateway-db-'));
});

afterEach(() => {
  if (db) {
    closeDatabase(db);
    db = null;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons and skips comments', () => {
    const sql = `
      -- one comment
      CREATE TABLE a (id INTEGER);
      -- another comment
      CREATE TABLE b (id INTEGER);
    `;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/CREATE TABLE a/);
    expect(out[1]).toMatch(/CREATE TABLE b/);
  });

  it('returns empty array for empty input', () => {
    expect(splitSqlStatements('')).toEqual([]);
  });

  it('ignores leading comment-only lines', () => {
    const sql = `-- nothing here\n`;
    expect(splitSqlStatements(sql)).toEqual([]);
  });
});

describe('openDatabase', () => {
  it('creates a file at the requested path', () => {
    const path = join(workDir, 'sub', 'gateway.db');
    db = openDatabase(path);
    expect(existsSync(path)).toBe(true);
  });

  it('enables WAL journal mode', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(row[0]?.journal_mode.toLowerCase()).toBe('wal');
  });

  it('enables foreign keys', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    const row = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(row[0]?.foreign_keys).toBe(1);
  });

  it('applies schema on first run', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(1);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'budget_counters',
        'cache_entries',
        'events',
        'keys',
        'probe_results',
        'provider_models',
        'providers',
        'request_logs',
        'response_cache',
        'schema_version',
        'usage_records',
        'virtual_model_members',
        'virtual_models',
      ]),
    );
  });

  it('is idempotent on second open', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    closeDatabase(db);
    db = null;

    db = openDatabase(path);
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(1);
  });

  it('preserves user data across reopens', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    db.prepare(
      `INSERT INTO keys (id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('k1', 'demo', 'hash1', 'gw_demo', Date.now());
    closeDatabase(db);
    db = null;

    db = openDatabase(path);
    const row = db.prepare('SELECT name FROM keys WHERE id = ?').get('k1') as { name: string };
    expect(row.name).toBe('demo');
  });
});

describe('migrate — error paths', () => {
  it('migrate() against an already-migrated db is a no-op', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    const versionBefore = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    migrate(db);
    const versionAfter = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(versionBefore.version).toBe(versionAfter.version);
  });

  it('migration errors are surfaced as MigrationError', () => {
    const path = join(workDir, 'gateway.db');
    db = openDatabase(path);
    db.exec(`DELETE FROM schema_version`);
    db.exec(`DROP TABLE schema_version`);
    expect(() => migrate(db!)).toThrow(MigrationError);
  });
});