// These tests go straight at the DATABASE. No application code is imported
// except the schema loader, because the point is that the invariants hold even
// against a hostile SQL client that never touches our repo layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.js';

/** A minimal but complete world: user, ward, store, season, prices, farmer,
 *  parcel, contract (unsigned), item, lot. */
function world() {
  const db = openMemoryDb();
  db.exec(`
    INSERT INTO app_user (id, username, full_name, role, password_hash, password_salt)
      VALUES (1, 'clerk', 'Clerk', 'clerk', 'x', 'y'),
             (2, 'fin', 'Finance', 'finance', 'x', 'y');
    INSERT INTO location (id, code, name, kind) VALUES (1, 'STR', 'Store', 'store'),
                                                       (2, 'WRD', 'Ward', 'ward');
    INSERT INTO season (id, code, name, starts_on, ends_on, target_g)
      VALUES (1, 'S1', 'Season', '2026-03-01', '2026-11-30', 30000000);
    INSERT INTO price_schedule (id, season_id, version, effective_from,
      base_price_cents, oil_premium_cents, moisture_discount_cents, damage_discount_cents)
      VALUES (1, 1, 1, '2026-03-01', 5800, 150, 200, 120);
    INSERT INTO farmer (id, code, full_name, national_id, phone, mm_name, ward_id,
                        registered_on, registered_at)
      VALUES (1, 'FRM-0001', 'A Farmer', '123', '2547', 'A Farmer', 2,
              '2026-03-02', '2026-03-02T09:00:00Z');
    INSERT INTO parcel (id, farmer_id, code, acreage_bp) VALUES (1, 1, 'PCL-0001', 10000);
    INSERT INTO contract (id, code, farmer_id, parcel_id, season_id, expected_g,
                          seed_entitlement_g, offered_on)
      VALUES (1, 'CTR-0001', 1, 1, 1, 700000, 4000, '2026-03-05');
    INSERT INTO item (id, code, name, kind) VALUES (1, 'SEED', 'Seed', 'seed'),
                                                   (2, 'GRAIN', 'Grain', 'grain');
    INSERT INTO lot (id, code, item_id, kephis_tag, germination_bp, retest_due_on,
                     unit_cost_cents, received_on)
      VALUES (1, 'LOT-0001', 1, 'K/1', 9000, '2027-01-01', 32000, '2026-02-20');
    INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason)
      VALUES (1, 1, 1, 100000, 'receipt');
  `);
  return db;
}

const signContract = (db) =>
  db.exec("UPDATE contract SET status = 'Signed', signed_on = '2026-03-10' WHERE id = 1");

test('stock_movement is append-only: UPDATE is rejected', () => {
  const db = world();
  assert.throws(
    () => db.exec('UPDATE stock_movement SET qty_g = 999999 WHERE id = 1'),
    /append-only/,
  );
});

test('stock_movement is append-only: DELETE is rejected', () => {
  const db = world();
  assert.throws(() => db.exec('DELETE FROM stock_movement WHERE id = 1'), /append-only/);
});

test('ledger_entry is append-only: UPDATE and DELETE are both rejected', () => {
  const db = world();
  db.exec(`INSERT INTO ledger_entry (farmer_id, season_id, amount_cents, kind)
           VALUES (1, 1, 12800, 'input_credit')`);
  assert.throws(() => db.exec('UPDATE ledger_entry SET amount_cents = 1 WHERE id = 1'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM ledger_entry WHERE id = 1'), /append-only/);
});

test('stock can never go negative — the movement is rejected, not clamped', () => {
  const db = world();
  // 100,000g on hand. Taking 100,000g is fine.
  db.exec(`INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason)
           VALUES (1, 1, 1, -100000, 'issue')`);
  assert.equal(
    db.prepare('SELECT SUM(qty_g) AS q FROM stock_movement WHERE lot_id = 1').get().q, 0,
  );
  // Taking one more gram is not.
  assert.throws(
    () => db.exec(`INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason)
                   VALUES (1, 1, 1, -1, 'issue')`),
    /negative/,
  );
  // And nothing was written.
  assert.equal(
    db.prepare('SELECT SUM(qty_g) AS q FROM stock_movement WHERE lot_id = 1').get().q, 0,
  );
});

test('seed cannot be issued against an unsigned contract', () => {
  const db = world();
  assert.equal(db.prepare('SELECT status FROM contract WHERE id = 1').get().status, 'Offered');
  assert.throws(
    () => db.exec(`INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
                     unit_cost_cents, value_cents, issued_on, issued_at)
                   VALUES ('ISS-00001', 1, 1, 1, 4000, 32000, 12800,
                           '2026-03-15', '2026-03-15T10:00:00Z')`),
    /unsigned contract/,
  );
});

test('seed CAN be issued once the contract is signed', () => {
  const db = world();
  signContract(db);
  db.exec(`INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
             unit_cost_cents, value_cents, issued_on, issued_at)
           VALUES ('ISS-00001', 1, 1, 1, 4000, 32000, 12800,
                   '2026-03-15', '2026-03-15T10:00:00Z')`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM input_issue').get().n, 1);
});

test('seed cannot be issued from a lot overdue for germination retest', () => {
  const db = world();
  signContract(db);
  db.exec(`INSERT INTO lot (id, code, item_id, kephis_tag, germination_bp, retest_due_on,
                            unit_cost_cents, received_on)
           VALUES (2, 'LOT-0002', 1, 'K/2', 8100, '2026-01-01', 29800, '2025-12-01')`);
  assert.throws(
    () => db.exec(`INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
                     unit_cost_cents, value_cents, issued_on, issued_at)
                   VALUES ('ISS-00002', 1, 1, 2, 4000, 29800, 11920,
                           '2026-03-15', '2026-03-15T10:00:00Z')`),
    /overdue for germination retest/,
  );
});

test('a settlement cannot exist for a delivery with no quality test', () => {
  const db = world();
  db.exec(`INSERT INTO delivery (id, code, farmer_id, contract_id, season_id, location_id,
             gross_g, tare_g, delivered_on, delivered_at)
           VALUES (1, 'GRN-00001', 1, 1, 1, 1, 620500, 20500,
                   '2026-07-10', '2026-07-10T11:00:00Z')`);
  assert.throws(
    () => db.exec(`INSERT INTO settlement (code, delivery_id, farmer_id, season_id,
                     price_schedule_id, payable_g, unit_price_cents, gross_value_cents,
                     cess_cents, recovery_cents, recovery_cap, net_payable_cents,
                     balance_cents, computed_on, computed_at)
                   VALUES ('STL-00001', 1, 1, 1, 1, 600000, 5800, 3480000, 17400, 0,
                           'none', 3462600, 3462600, '2026-07-10', '2026-07-10T12:00:00Z')`),
    /no quality test/,
  );
});

test('net weight is generated from gross and tare, and cannot be written to', () => {
  const db = world();
  db.exec(`INSERT INTO delivery (id, code, farmer_id, contract_id, season_id, location_id,
             gross_g, tare_g, delivered_on, delivered_at)
           VALUES (1, 'GRN-00001', 1, 1, 1, 1, 641000, 20500,
                   '2026-07-10', '2026-07-10T11:00:00Z')`);
  assert.equal(db.prepare('SELECT net_g FROM delivery WHERE id = 1').get().net_g, 620500);
  assert.throws(
    () => db.exec('UPDATE delivery SET net_g = 999999 WHERE id = 1'),
    /cannot INSERT into generated column|generated column/i,
  );
});

test('a delivery whose tare is not less than its gross is refused', () => {
  const db = world();
  assert.throws(
    () => db.exec(`INSERT INTO delivery (code, farmer_id, contract_id, season_id, location_id,
                     gross_g, tare_g, delivered_on, delivered_at)
                   VALUES ('GRN-00002', 1, 1, 1, 1, 20000, 20000,
                           '2026-07-10', '2026-07-10T11:00:00Z')`),
    /CHECK constraint/i,
  );
});

test('price schedules are immutable: UPDATE and DELETE are both rejected', () => {
  const db = world();
  assert.throws(
    () => db.exec('UPDATE price_schedule SET base_price_cents = 9900 WHERE id = 1'),
    /immutable/,
  );
  assert.throws(() => db.exec('DELETE FROM price_schedule WHERE id = 1'), /immutable/);
  // Changing a price means adding a version.
  db.exec(`INSERT INTO price_schedule (season_id, version, effective_from,
             base_price_cents, oil_premium_cents, moisture_discount_cents, damage_discount_cents)
           VALUES (1, 2, '2026-06-01', 5900, 150, 200, 120)`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_schedule').get().n, 2);
});

test('a payment idempotency key can only be used once', () => {
  const db = world();
  db.exec(`
    INSERT INTO delivery (id, code, farmer_id, contract_id, season_id, location_id,
      gross_g, tare_g, delivered_on, delivered_at)
      VALUES (1, 'GRN-00001', 1, 1, 1, 1, 641000, 20500, '2026-07-10', '2026-07-10T11:00:00Z');
    INSERT INTO quality_test (code, delivery_id, moisture_bp, oil_bp, foreign_bp, damage_bp,
      grade, tested_on, tested_at)
      VALUES ('QT-00001', 1, 900, 4200, 100, 200, 'A', '2026-07-10', '2026-07-10T11:30:00Z');
    INSERT INTO settlement (id, code, delivery_id, farmer_id, season_id, price_schedule_id,
      payable_g, unit_price_cents, gross_value_cents, cess_cents, recovery_cents,
      recovery_cap, net_payable_cents, balance_cents, computed_on, computed_at)
      VALUES (1, 'STL-00001', 1, 1, 1, 1, 620500, 6100, 3785050, 18925, 0, 'none',
              3766125, 3766125, '2026-07-10', '2026-07-10T12:00:00Z');
    INSERT INTO payment (code, settlement_id, farmer_id, amount_cents, idempotency_key, status)
      VALUES ('PMT-00001', 1, 1, 3766125, 'payout:STL-00001', 'Paid');
  `);
  assert.throws(
    () => db.exec(`INSERT INTO payment (code, settlement_id, farmer_id, amount_cents,
                     idempotency_key, status)
                   VALUES ('PMT-00002', 1, 1, 3766125, 'payout:STL-00001', 'Paid')`),
    /UNIQUE constraint/i,
  );
});

test('the grader of a delivery may not approve its own settlement', () => {
  const db = world();
  db.exec(`
    INSERT INTO delivery (id, code, farmer_id, contract_id, season_id, location_id,
      gross_g, tare_g, delivered_on, delivered_at)
      VALUES (1, 'GRN-00001', 1, 1, 1, 1, 641000, 20500, '2026-07-10', '2026-07-10T11:00:00Z');
    INSERT INTO quality_test (code, delivery_id, moisture_bp, oil_bp, foreign_bp, damage_bp,
      grade, tested_on, tested_at, created_by)
      VALUES ('QT-00001', 1, 900, 4200, 100, 200, 'A', '2026-07-10', '2026-07-10T11:30:00Z', 1);
    INSERT INTO settlement (id, code, delivery_id, farmer_id, season_id, price_schedule_id,
      payable_g, unit_price_cents, gross_value_cents, cess_cents, recovery_cents,
      recovery_cap, net_payable_cents, balance_cents, computed_on, computed_at)
      VALUES (1, 'STL-00001', 1, 1, 1, 1, 620500, 6100, 3785050, 18925, 0, 'none',
              3766125, 3766125, '2026-07-10', '2026-07-10T12:00:00Z');
  `);
  // User 1 graded it, so user 1 cannot approve it.
  assert.throws(
    () => db.exec("UPDATE settlement SET status = 'Approved', approved_by = 1 WHERE id = 1"),
    /may not approve/,
  );
  // User 2 can.
  db.exec("UPDATE settlement SET status = 'Approved', approved_by = 2 WHERE id = 1");
  assert.equal(db.prepare('SELECT approved_by FROM settlement WHERE id = 1').get().approved_by, 2);
});

test('a contract cannot be marked Signed without a signing date', () => {
  const db = world();
  assert.throws(
    () => db.exec("UPDATE contract SET status = 'Signed' WHERE id = 1"),
    /must carry signed_on/,
  );
});

test('audit_log is append-only', () => {
  const db = world();
  db.exec("INSERT INTO audit_log (actor_id, action, entity, entity_id) VALUES (1, 'x', 'farmer', 1)");
  assert.throws(() => db.exec("UPDATE audit_log SET action = 'y' WHERE id = 1"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log WHERE id = 1'), /append-only/);
});
