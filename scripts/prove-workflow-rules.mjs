// Proof 2 — the workflow rules are enforced by the DATABASE too.
//
// Again, no application code: raw SQL only. These are the four ways a person
// could quietly break the business if the rules lived only in route handlers.
import Database from 'better-sqlite3';

const db = new Database(process.argv[2] || './data/agri.db');
const today = new Date().toISOString().slice(0, 10);

const unsigned = db.prepare("SELECT id, code FROM contract WHERE status <> 'Signed' LIMIT 1").get();
const goodLot = db.prepare('SELECT id, code FROM lot WHERE retest_due_on >= ? LIMIT 1').get(today);
const staleLot = db.prepare('SELECT id, code FROM lot WHERE retest_due_on < ? LIMIT 1').get(today);
const signed = db.prepare("SELECT id, code FROM contract WHERE status = 'Signed' LIMIT 1").get();
// Every seeded delivery is graded, so make a throwaway ungraded one to attack.
// It lives inside a savepoint that is rolled back either way, so this script
// never leaves anything behind in your database.
function withUngradedDelivery(fn) {
  db.exec('SAVEPOINT prove');
  try {
    const any = db.prepare('SELECT * FROM delivery LIMIT 1').get();
    const info = db.prepare(
      `INSERT INTO delivery (code, farmer_id, contract_id, season_id, location_id,
         gross_g, tare_g, delivered_on, delivered_at)
       VALUES ('GRN-99901', ?, ?, ?, ?, 500000, 10000, ?, ?)`,
    ).run(any.farmer_id, any.contract_id, any.season_id, any.location_id,
          today, `${today}T08:00:00Z`);
    return fn({ id: info.lastInsertRowid, code: 'GRN-99901' });
  } finally {
    db.exec('ROLLBACK TO prove');
    db.exec('RELEASE prove');
  }
}
const paid = db.prepare("SELECT * FROM payment WHERE status = 'Paid' LIMIT 1").get();

const attempts = [
  [`Issue seed against unsigned contract ${unsigned?.code}`, unsigned && goodLot, () =>
    db.prepare(
      `INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
         unit_cost_cents, value_cents, issued_on, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ISS-99901', unsigned.id, 1, goodLot.id, 4000, 32000, 12800, today, `${today}T10:00:00Z`)],

  [`Issue seed from lot ${staleLot?.code}, overdue for retest`, signed && staleLot, () =>
    db.prepare(
      `INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
         unit_cost_cents, value_cents, issued_on, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ISS-99902', signed.id, 1, staleLot.id, 4000, 29800, 11920, today, `${today}T10:00:00Z`)],

  ['Settle a delivery that has no quality test', true, () =>
    withUngradedDelivery((d) => db.prepare(
      `INSERT INTO settlement (code, delivery_id, farmer_id, season_id, price_schedule_id,
         payable_g, unit_price_cents, gross_value_cents, cess_cents, recovery_cents,
         recovery_cap, net_payable_cents, balance_cents, computed_on, computed_at)
       VALUES ('STL-99901', ?, 1, 1, 1, 1000, 5800, 5800, 29, 0, 'none', 5771, 5771, ?, ?)`,
    ).run(d.id, today, `${today}T12:00:00Z`))],

  [`Pay ${paid?.code} a second time with the same idempotency key`, paid, () =>
    db.prepare(
      `INSERT INTO payment (code, settlement_id, farmer_id, amount_cents, idempotency_key, status)
       VALUES ('PMT-99901', ?, ?, ?, ?, 'Paid')`,
    ).run(paid.settlement_id, paid.farmer_id, paid.amount_cents, paid.idempotency_key)],

  ['Write to the generated net weight column', true, () =>
    db.exec('UPDATE delivery SET net_g = 1 WHERE id = 1')],
];

console.log('Attempting writes that must be refused:\n');
let accepted = 0; let skipped = 0;
for (const [label, ready, run] of attempts) {
  if (!ready) { console.log(`  skipped   ${label} (no suitable seed row)`); skipped += 1; continue; }
  try {
    run();
    console.log(`  ACCEPTED  ${label}   <-- THE INVARIANT IS NOT HOLDING`);
    accepted += 1;
  } catch (err) {
    console.log(`  refused   ${label}\n            ${err.message}`);
  }
}

console.log(`\n${attempts.length - accepted - skipped} refused, ${accepted} wrongly accepted.`);
process.exitCode = accepted === 0 ? 0 : 1;
