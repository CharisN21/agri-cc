// A supply run is a DRAFT until it is closed.
//
// These tests pin down both halves of that: while it is open, everything can be
// corrected; the moment it is closed, nothing can. The second half is asserted
// against the raw database, because "there is no button for it" is not a
// guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `agri-corr-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.SESSION_SECRET = 'test-secret';

const { migrate, getDb, closeDb } = await import('../src/db.js');
const out = await import('../src/repo-outsourcing.js');
const { hashPassword } = await import('../src/auth.js');

migrate({ log: () => {} });
process.on('exit', () => {
  closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s); } catch { /* gone */ } }
});

const db = getDb();
const { hash, salt } = hashPassword('pw');
const userId = db.prepare(
  `INSERT INTO app_user (username, full_name, role, password_hash, password_salt)
   VALUES ('officer', 'Officer', 'field_officer', ?, ?)`,
).run(hash, salt).lastInsertRowid;
const actor = { id: userId, role: 'field_officer' };

db.exec(`
  INSERT INTO location (id, code, name, kind) VALUES (1, 'STR', 'Store', 'store'),
                                                     (2, 'WRD', 'Ward', 'ward');
  INSERT INTO season (id, code, name, starts_on, ends_on, target_g)
    VALUES (1, 'S1', 'Season', '2026-03-01', '2026-11-30', 30000000);
  INSERT INTO item (id, code, name, kind) VALUES (1, 'SEED', 'Seed', 'seed'),
                                                 (2, 'GRAIN', 'Grain', 'grain');
`);
out.addSpotScheduleVersion(1, {
  effective_from: '2026-06-01', base_price_cents: 5200, oil_premium_cents: 150,
  moisture_discount_cents: 200, damage_discount_cents: 120, cess_bp: 50,
}, userId);
const supplierId = out.createSupplier({ name: 'A Supplier', ward_id: 2 }, userId).id;

function newRun(area = 'Somewhere') {
  return out.createRun({ season_id: 1, area, vehicle_reg: 'KAA 1A',
                         started_on: '2026-07-10', notes: '' }, userId).id;
}
function buy(runId, { grossG = 500_000, tareG = 12_000, moistureBp = 950 } = {}) {
  return out.createSpotPurchase({
    runId, supplierId, grossG, tareG,
    moistureBp, oilBp: 4100, foreignBp: 200, damageBp: 300,
    agreedPriceCents: null, priceReason: '',
    purchasedOn: '2026-07-10', purchasedAt: '2026-07-10T10:00:00Z',
    method: 'M-Pesa', reference: 'X', notes: '',
  }, userId);
}

// --- while the run is open, everything is correctable ---------------------
test('the run header can be corrected while the run is open', () => {
  const runId = newRun('Typo aera');
  out.updateRun(runId, { area: 'Bahati market', vehicle_reg: 'KAA 991Z',
                         started_on: '2026-07-11', notes: 'fixed' }, userId);
  const run = out.getRun(runId);
  assert.equal(run.area, 'Bahati market');
  assert.equal(run.vehicle_reg, 'KAA 991Z');
  assert.equal(run.started_on, '2026-07-11');
});

test('a mistyped cost can be corrected, and the correction is audited', () => {
  const runId = newRun();
  const costId = out.addRunCost({ run_id: runId, kind: 'transport',
    description: 'Pickup', amount_cents: 4_500_000, incurred_on: '2026-07-10' }, userId);

  out.updateRunCost(costId, { kind: 'transport', description: 'Pickup',
                              amount_cents: 450_000 }, userId);

  const cost = getDb().prepare('SELECT * FROM run_cost WHERE id = ?').get(costId);
  assert.equal(cost.amount_cents, 450_000, 'KES 45,000 corrected to KES 4,500');
  const audited = getDb().prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'run_cost.update' AND entity_id = ?",
  ).get(costId).n;
  assert.equal(audited, 1);
});

test('a cost line can be removed, and the history survives the deletion', () => {
  const runId = newRun();
  const costId = out.addRunCost({ run_id: runId, kind: 'fuel', description: 'Diesel',
    amount_cents: 300_000, incurred_on: '2026-07-10' }, userId);
  out.deleteRunCost(costId, userId);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM run_cost WHERE id = ?')
    .get(costId).n, 0, 'the row is gone');
  const entry = getDb().prepare(
    "SELECT detail_json FROM audit_log WHERE action = 'run_cost.delete' AND entity_id = ?",
  ).get(costId);
  assert.ok(entry, 'but the audit log remembers it');
  assert.equal(JSON.parse(entry.detail_json).amount_cents, 300_000);
});

// --- voiding a load --------------------------------------------------------
test('voiding a load reverses the grain OUT of the store, without deleting history', () => {
  const runId = newRun();
  const { id: purchaseId } = buy(runId);

  const before = getDb().prepare(
    "SELECT COALESCE(SUM(qty_g), 0) AS g, COUNT(*) AS n FROM stock_movement WHERE ref_table = 'spot_purchase' AND ref_id = ?",
  ).get(purchaseId);
  assert.ok(before.g > 0, 'buying it put grain in the store');

  out.voidSpotPurchase(purchaseId, { reason: 'Wrong supplier', voidedAt: '2026-07-10T12:00:00Z' }, actor);

  const after = getDb().prepare(
    "SELECT COALESCE(SUM(qty_g), 0) AS g, COUNT(*) AS n FROM stock_movement WHERE ref_table = 'spot_purchase' AND ref_id = ?",
  ).get(purchaseId);
  assert.equal(after.g, 0, 'the grain is back out');
  assert.equal(after.n, before.n * 2, 'by a NEW reversing row, not by deleting the old one');
});

test('a voided load is excluded from costing but still visible on the run', () => {
  const runId = newRun();
  const a = buy(runId);
  const b = buy(runId, { grossG: 300_000 });
  out.addRunCost({ run_id: runId, kind: 'transport', description: '',
                   amount_cents: 100_000, incurred_on: '2026-07-10' }, userId);

  const before = out.runSummary(runId).costing;
  out.voidSpotPurchase(b.id, { reason: 'Duplicate entry', voidedAt: '2026-07-10T12:00:00Z' }, actor);
  const after = out.runSummary(runId).costing;

  assert.equal(before.loads, 2);
  assert.equal(after.loads, 1, 'costing drops it');
  assert.ok(after.payableG < before.payableG);
  assert.equal(after.overheadCents, 100_000, 'the trip still cost what it cost');
  assert.equal(
    out.runSummary(runId).purchases.filter((p) => p.voided_at).length, 1,
    'but the void is still on screen, not hidden',
  );
  assert.ok(a.id);
});

test('voiding demands a reason', () => {
  const runId = newRun();
  const { id } = buy(runId);
  assert.throws(() => out.voidSpotPurchase(id, { reason: '   ', voidedAt: 'x' }, actor), /why/);
  assert.throws(() => out.voidSpotPurchase(id, { reason: '', voidedAt: 'x' }, actor), /why/);
});

test('a load that has been paid cannot just be voided', () => {
  const runId = newRun();
  const { id } = buy(runId);
  out.markSpotPaid(id, { reference: 'MP1', paidOn: '2026-07-10' }, userId);
  assert.throws(
    () => out.voidSpotPurchase(id, { reason: 'oops', voidedAt: 'x' }, actor),
    /paid/i,
  );
});

test('a voided load cannot be un-voided', () => {
  const runId = newRun();
  const { id } = buy(runId);
  out.voidSpotPurchase(id, { reason: 'Wrong', voidedAt: '2026-07-10T12:00:00Z' }, actor);
  assert.throws(
    () => getDb().prepare('UPDATE spot_purchase SET voided_at = NULL WHERE id = ?').run(id),
    /un-voided/,
  );
  assert.throws(
    () => out.voidSpotPurchase(id, { reason: 'again', voidedAt: 'x' }, actor),
    /already voided/,
  );
});

// --- a closed run is finished ---------------------------------------------
test('a closed run refuses every correction, at the DATABASE level', () => {
  const runId = newRun();
  const costId = out.addRunCost({ run_id: runId, kind: 'labour', description: 'Gang',
    amount_cents: 50_000, incurred_on: '2026-07-10' }, userId);
  const { id: purchaseId } = buy(runId);
  out.closeRun(runId, { endedOn: '2026-07-11' }, userId);

  const raw = getDb();
  assert.throws(() => raw.prepare("UPDATE supply_run SET area = 'x' WHERE id = ?").run(runId),
    /closed/, 'header frozen');
  assert.throws(() => raw.prepare('UPDATE run_cost SET amount_cents = 1 WHERE id = ?').run(costId),
    /closed run/, 'costs frozen');
  assert.throws(() => raw.prepare('DELETE FROM run_cost WHERE id = ?').run(costId),
    /closed run/, 'costs cannot be removed');
  assert.throws(
    () => raw.prepare("UPDATE spot_purchase SET voided_at = 'x', void_reason = 'y' WHERE id = ?")
      .run(purchaseId),
    /closed run/, 'loads cannot be voided');
  assert.throws(
    () => raw.prepare(
      `INSERT INTO run_cost (run_id, kind, description, amount_cents, incurred_on)
       VALUES (?, 'fuel', '', 1000, '2026-07-12')`).run(runId),
    /not open/, 'and nothing new can be added');
});

test('the repository refuses a correction on a closed run before the trigger has to', () => {
  const runId = newRun();
  const costId = out.addRunCost({ run_id: runId, kind: 'fuel', description: '',
    amount_cents: 1000, incurred_on: '2026-07-10' }, userId);
  out.closeRun(runId, { endedOn: '2026-07-11' }, userId);

  assert.throws(() => out.updateRun(runId, { area: 'x' }, userId), /closed/);
  assert.throws(() => out.updateRunCost(costId, { amount_cents: 5 }, userId), /closed/);
  assert.throws(() => out.deleteRunCost(costId, userId), /closed/);
});

test('reopening a closed run makes it editable again', () => {
  const runId = newRun('Original');
  out.closeRun(runId, { endedOn: '2026-07-11' }, userId);
  assert.throws(() => out.updateRun(runId, { area: 'Changed' }, userId), /closed/);

  out.reopenRun(runId, userId);
  out.updateRun(runId, { area: 'Changed' }, userId);
  assert.equal(out.getRun(runId).area, 'Changed');
});

// --- findability -----------------------------------------------------------
test('open runs are listed so unfinished work is never lost', () => {
  const before = out.openRuns(1).length;
  const a = newRun('Trip A');
  const b = newRun('Trip B');
  const open = out.openRuns(1);
  assert.equal(open.length, before + 2);
  assert.ok(open.some((r) => r.id === a), 'the first is listed');
  assert.ok(open.some((r) => r.id === b), 'so is the second');

  out.closeRun(a, { endedOn: '2026-07-11' }, userId);
  assert.ok(!out.openRuns(1).some((r) => r.id === a), 'closing removes it from the list');
});

test('the open-run list counts live loads, not voided ones', () => {
  const runId = newRun('Counting');
  buy(runId);
  const { id: second } = buy(runId, { grossG: 250_000 });
  assert.equal(out.openRuns(1).find((r) => r.id === runId).loads, 2);

  out.voidSpotPurchase(second, { reason: 'Duplicate', voidedAt: '2026-07-10T12:00:00Z' }, actor);
  assert.equal(out.openRuns(1).find((r) => r.id === runId).loads, 1);
});
