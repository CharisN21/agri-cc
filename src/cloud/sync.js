// Optional Supabase mirror.
//
// SQLite stays the system of record. This pushes rows one way — local to cloud —
// so that head office, a phone, or a BI tool can read the season without
// reaching into the store's laptop. Nothing in the app depends on it: if
// SUPABASE_URL is blank, every function here is a no-op and the app is
// unchanged.
//
// The push is watermark-based over append-only tables, which is why it can be
// interrupted and resumed without duplicating anything: each table records the
// highest id already sent in sync_state, and upserts are keyed on id.
import { config } from '../config.js';
import { getDb } from '../db.js';
import { isMain } from '../is-main.js';

// Order matters: parents before children, because the cloud copy keeps the
// same foreign keys.
const TABLES = [
  'location', 'season', 'price_schedule', 'app_user_public', 'farmer', 'parcel',
  'contract', 'item', 'lot', 'stock_movement', 'input_issue', 'ledger_entry',
  'delivery', 'quality_test', 'settlement', 'payment',
];

/** app_user is mirrored WITHOUT password material. */
const SELECTS = {
  app_user_public: 'SELECT id, username, full_name, role, active, created_at FROM app_user WHERE id > ? ORDER BY id LIMIT ?',
  delivery: 'SELECT *, (gross_g - tare_g) AS net_g FROM delivery WHERE id > ? ORDER BY id LIMIT ?',
};

const REMOTE_NAME = { app_user_public: 'app_user' };

function selectFor(table) {
  return SELECTS[table] || `SELECT * FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`;
}

export function syncStatus() {
  const db = getDb();
  const state = Object.fromEntries(
    db.prepare('SELECT table_name, last_id, last_run_at, last_error FROM sync_state').all()
      .map((r) => [r.table_name, r]),
  );
  return TABLES.map((t) => {
    const local = t === 'app_user_public'
      ? db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max FROM app_user').get()
      : db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max FROM ${t}`).get();
    const s = state[t] || { last_id: 0, last_run_at: null, last_error: null };
    return {
      table: t, rows: local.n, maxId: local.max,
      pushedTo: s.last_id, pending: Math.max(0, local.max - s.last_id),
      lastRunAt: s.last_run_at, lastError: s.last_error,
    };
  });
}

async function upsert(remoteTable, rows) {
  const res = await fetch(`${config.supabase.url}/rest/v1/${remoteTable}`, {
    method: 'POST',
    headers: {
      apikey: config.supabase.serviceKey,
      Authorization: `Bearer ${config.supabase.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`${remoteTable}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

/** Push every table up to its current maximum id. */
export async function pushAll({ batch = 500, log = () => {} } = {}) {
  if (!config.supabase.enabled) {
    return { enabled: false, pushed: 0, message: 'Supabase is not configured' };
  }
  const db = getDb();
  let pushed = 0;

  for (const table of TABLES) {
    const remote = REMOTE_NAME[table] || table;
    db.prepare('INSERT OR IGNORE INTO sync_state (table_name) VALUES (?)').run(table);
    let { last_id: cursor } = db.prepare('SELECT last_id FROM sync_state WHERE table_name = ?')
      .get(table);

    try {
      for (;;) {
        const rows = db.prepare(selectFor(table)).all(cursor, batch);
        if (rows.length === 0) break;
        await upsert(remote, rows);
        cursor = rows[rows.length - 1].id;
        pushed += rows.length;
        db.prepare(
          "UPDATE sync_state SET last_id = ?, last_run_at = datetime('now'), last_error = NULL WHERE table_name = ?",
        ).run(cursor, table);
        log(`  ${remote}: ${rows.length} row(s) up to id ${cursor}`);
        if (rows.length < batch) break;
      }
    } catch (err) {
      db.prepare(
        "UPDATE sync_state SET last_run_at = datetime('now'), last_error = ? WHERE table_name = ?",
      ).run(err.message, table);
      throw err;
    }
  }
  return { enabled: true, pushed };
}

if (isMain(import.meta.url)) {
  if (!config.supabase.enabled) {
    console.log('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    console.log('Then apply migrations/supabase.sql in the Supabase SQL editor.');
  } else {
    const r = await pushAll({ log: console.log });
    console.log(`Pushed ${r.pushed} row(s) to ${config.supabase.url}`);
  }
}
