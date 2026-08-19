// Proof 1 — the append-only rule is enforced by the DATABASE.
//
// This script does NOT import the app's repository layer. It opens the database
// file directly with a raw SQLite driver and issues the kind of write a careless
// script, a stray migration, or a person with a SQL client would issue. If the
// rule only lived in application code, all four of these would succeed.
import Database from 'better-sqlite3';

const db = new Database(process.argv[2] || './data/agri.db');

const attempts = [
  ['UPDATE a stock movement',
   () => db.exec('UPDATE stock_movement SET qty_g = 999999 WHERE id = 1')],
  ['DELETE a stock movement',
   () => db.exec('DELETE FROM stock_movement WHERE id = 1')],
  ['UPDATE a ledger entry',
   () => db.exec('UPDATE ledger_entry SET amount_cents = 0 WHERE id = 1')],
  ['DELETE a ledger entry',
   () => db.exec('DELETE FROM ledger_entry WHERE id = 1')],
  ['UPDATE a price schedule',
   () => db.exec('UPDATE price_schedule SET base_price_cents = 1 WHERE id = 1')],
  ['Overdraw seed stock',
   () => db.prepare(
     `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason)
      VALUES (1, 1, 1, -99999999, 'issue')`).run()],
];

console.log('Attempting writes that must be refused:\n');
let accepted = 0;
for (const [label, run] of attempts) {
  try {
    run();
    console.log(`  ACCEPTED  ${label}   <-- THE INVARIANT IS NOT HOLDING`);
    accepted += 1;
  } catch (err) {
    console.log(`  refused   ${label}\n            ${err.message}`);
  }
}

console.log(`\n${attempts.length - accepted} of ${attempts.length} refused by the database.`);
process.exitCode = accepted === 0 ? 0 : 1;
