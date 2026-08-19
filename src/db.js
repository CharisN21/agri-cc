// Database handle, migration runner, and the transaction helper.
//
// Everything that touches money or stock must run inside tx(). The invariants
// live in migrations/*.sql as triggers; this file only opens the door.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT } from './config.js';

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open a throwaway in-memory database with the schema applied. Used by tests. */
export function openMemoryDb() {
  const mem = new Database(':memory:');
  mem.pragma('foreign_keys = ON');
  for (const file of migrationFiles()) {
    mem.exec(fs.readFileSync(file.path, 'utf8'));
  }
  return mem;
}

// Only NNN_name.sql is a local migration. migrations/ also holds supabase.sql,
// which is Postgres and must never be handed to SQLite.
const LOCAL_MIGRATION = /^\d{3,}_.+\.sql$/;

function migrationFiles() {
  const dir = path.join(ROOT, 'migrations');
  return fs.readdirSync(dir)
    .filter((f) => LOCAL_MIGRATION.test(f))
    .sort()
    .map((name) => ({ name, path: path.join(dir, name) }));
}

export function migrate({ log = console.log } = {}) {
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(
    d.prepare('SELECT name FROM schema_migration').all().map((r) => r.name),
  );
  let count = 0;
  for (const file of migrationFiles()) {
    if (applied.has(file.name)) continue;
    const sql = fs.readFileSync(file.path, 'utf8');
    d.exec('BEGIN');
    try {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migration (name) VALUES (?)').run(file.name);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`migration ${file.name} failed: ${err.message}`);
    }
    log(`  applied ${file.name}`);
    count += 1;
  }
  if (count === 0) log('  schema already up to date');
  return count;
}

/**
 * Run fn inside a transaction. Nested calls join the outer transaction rather
 * than opening a second one, so a route handler can call a repo function that
 * itself calls tx() without surprises.
 */
export function tx(fn) {
  const d = getDb();
  if (d.inTransaction) return fn(d);
  return d.transaction(fn)(d);
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
