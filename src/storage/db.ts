/**
 * SQLite connection management and migration runner.
 *
 * Single-instance lifecycle:
 *  - `openDatabase(path)` returns a wrapper around `better-sqlite3` with WAL mode and NORMAL sync.
 *  - `migrate(db)` reads `schema.sql`, splits on `;` boundaries, and applies every CREATE TABLE/INDEX
 *    statement against the live database, then writes the version row.
 *
 * The gateway is single-process, so there is exactly one `Database` per gateway instance.
 */

import BetterSqlite3, { type Database as BetterDatabase } from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Database extends BetterDatabase {}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Resolve the absolute path to the bundled `schema.sql` regardless of
 * whether we are running from `src/` (tsx) or `dist/` (compiled).
 */
export function resolveSchemaPath(): string {
  const candidates: string[] = [];

  const fromUrl = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(fromUrl, 'schema.sql'));
  candidates.push(resolve(fromUrl, '../../src/storage/schema.sql'));
  candidates.push(resolve(fromUrl, '../src/storage/schema.sql'));
  candidates.push(resolve(fromUrl, '../../../src/storage/schema.sql'));

  // Fall back to CWD-relative locations (vitest, tsx, CLI)
  const cwd = process.cwd();
  candidates.push(resolve(cwd, 'src/storage/schema.sql'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new MigrationError(`schema.sql not found; cwd=${cwd}; tried: ${candidates.join(', ')}`);
}

/**
 * Split a SQL script into individual statements. The schema file uses
 * `;` as a terminator with no string literals containing `;`, so a simple
 * split-and-trim is sufficient.
 *
 * Top-of-statement `--` comment lines are preserved (SQLite handles them),
 * and chunks that contain only comments are dropped.
 */
export function splitSqlStatements(script: string): string[] {
  const chunks = script.split(/;\s*$/m).map((s) => s.trim());
  const out: string[] = [];
  for (const chunk of chunks) {
    // Drop chunks that contain only comment lines (with optional whitespace).
    const stripped = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^--/.test(l))
      .join('\n')
      .trim();
    if (stripped.length > 0) out.push(chunk);
  }
  return out;
}

/**
 * Apply the schema if the database is empty (no `schema_version` row yet).
 *
 * Throws {@link MigrationError} if migration fails — the caller (boot path)
 * must refuse to start with a clear error message.
 */
export function migrate(db: Database): void {
  try {
    const hasVersion = db.prepare(`SELECT 1 FROM schema_version LIMIT 1`).get();
    if (hasVersion) return;
  } catch {
    // schema_version may not exist yet; fall through to migrate
  }

  const sql = readFileSync(resolveSchemaPath(), 'utf8');
  const statements = splitSqlStatements(sql);
  if (process.env['GATEWAY_DEBUG_MIGRATE'] === '1') {
    process.stderr.write(`[migrate] applying ${statements.length} statements\n`);
  }

  const applyAll = db.transaction(() => {
    for (const stmt of statements) {
      try {
        db.exec(stmt);
      } catch (err) {
        throw new MigrationError(
          `Migration failed on statement: ${stmt.slice(0, 80)}… — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(1);
  });

  try {
    applyAll();
  } catch (err) {
    if (err instanceof MigrationError) throw err;
    throw new MigrationError(`Migration transaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Exported for debugging only; not part of the public surface.
export const _debug = { resolveSchemaPath, splitSqlStatements };

/**
 * Open (or create) a SQLite database at the given path with WAL mode and
 * safe synchronous settings, then apply migrations.
 */
export function openDatabase(dbPath: string): Database {
  const abs = resolve(dbPath);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new BetterSqlite3(abs) as Database;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

/**
 * Close a database, swallowing errors so callers can use it in finally blocks.
 */
export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    /* best effort */
  }
}