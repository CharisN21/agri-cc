// Correcting things that are not money: farmer and supplier details, and a
// grade typed wrong. The boundary these tests pin down is where "correctable"
// stops — the moment money has been approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `agri-corr2-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.SESSION_SECRET = 'test-secret';

const { migrate, getDb, closeDb } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const corr = await import('../src/repo-corrections.js');
const out = await import('../src/repo-outsourcing.js');
const { hashPassword } = await import('../src/auth.js');

migrate({ log: () => {} });
process.on('exit', () => {
  closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s); } catch { /* gone */ } }
});

const db = getDb();
const users = {};
for (const [u, role] of [['clerk', 'clerk'], ['fin', 'finance'], ['owner', 'owner']]) {
  const { hash, salt } = hashPassword('pw');
  users[u] = db.prepare(
    `INSERT INTO app_user (username, full_name, role, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?)`).run(u, u, role, hash, salt).lastInsertRowid;
}
db.exec(`
  INSERT INTO location (id, code, name, kind) VALUES (1,'STR','Store','store'),
                                                     (2,'WRD','Ward A','ward'),
                                                     (3,'WR2','Ward B','ward');
  INSERT INTO season (id, code, name, starts_on, ends_on, target_g)
    VALUES (1,'S1','Season','2026-03-01','2026-11-30',30000000);
  INSERT INTO price_schedule (id, season_id, version, effective_from, base_price_cents,
    oil_premium_cents, moisture_discount_cents, damage_discount_cents, cess_bp,
    recovery_share_bp, cash_floor_cents)
    VALUES (1,1,1,'2026-03-01',5800,150,200,120,50,5000,200000);
  INSERT INTO item (id, code, name, kind) VALUES (1,'SEED','Seed','seed'),(2,'GRAIN','Grain','grain');
`);

let n = 0;
function newFarmer() {
  n += 1;
  const { id } = repo.createFarmer({
    full_name: `Farmer ${n}`, national_id: `ID${n}`, phone: `25470000${n}`,
    mm_name: `Farmer ${n}`, ward_id: 2, notes: '',
    registered_on: '2026-03-02', registered_at: '2026-03-02T09:00:00Z',
  }, users.clerk);
  const parcelId = repo.createParcel({ farmer_id: id, acreage_bp: 20000, notes: '' }, users.clerk).id;
  const contractId = repo.offerContract({
    farmer_id: id, parcel_id: parcelId, season_id: 1, expected_g: 1_400_000,
    seed_entitlement_g: 8000, recovery_share_bp: 5000, offered_on: '2026-03-05', notes: '',
  }, users.clerk).id;
  repo.signContract(contractId, { signedOn: '2026-03-10', signedAt: 'x' }, users.owner);
  return { id, contractId };
}
function deliver(f, { moistureBp = 900, oilBp = 4200 } = {}) {
  const { id } = repo.createDelivery({
    farmerId: f.id, contractId: f.contractId, grossG: 641_000, tareG: 20_500,
    deliveredOn: '2026-07-10', deliveredAt: 'x', vehicleReg: '', notes: '',
  }, users.clerk);
  repo.gradeDelivery({
    deliveryId: id, moistureBp, oilBp, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-10', testedAt: 'x', notes: '',
  }, users.clerk);
  return id;
}
const stockFor = (id) => db.prepare(
  "SELECT COALESCE(SUM(qty_g),0) AS g FROM stock_movement WHERE ref_table='delivery' AND ref_id=?",
).get(id).g;

// --- farmer details --------------------------------------------------------
test('a farmer phone number can be corrected — the thing that bounces payouts', () => {
  const f = newFarmer();
  const { changed } = corr.updateFarmer(f.id, { phone: '254799999999' },
    { at: '2026-08-01T10:00:00Z' }, users.clerk);
  assert.deepEqual(changed, ['phone']);
  assert.equal(repo.getFarmer(f.id).phone, '254799999999');
});

test('changing a payout field is flagged specifically in the audit log', () => {
  const f = newFarmer();
  corr.updateFarmer(f.id, { mm_name: 'Someone Else', notes: 'spouse account' },
    { at: 'x' }, users.clerk);
  const entry = db.prepare(
    "SELECT detail_json FROM audit_log WHERE action='farmer.update' AND entity_id=? ORDER BY id DESC LIMIT 1",
  ).get(f.id);
  const detail = JSON.parse(entry.detail_json);
  assert.deepEqual(detail.payout_fields_changed, ['mm_name']);
  assert.ok(detail.changed.includes('notes'), 'notes changed too');
  assert.equal(detail.from.mm_name, `Farmer ${n}`);
  assert.equal(detail.to.mm_name, 'Someone Else');
});

test('an edit that changes nothing reports nothing changed', () => {
  const f = newFarmer();
  const before = repo.getFarmer(f.id);
  const { changed } = corr.updateFarmer(f.id, { phone: before.phone }, { at: 'x' }, users.clerk);
  assert.deepEqual(changed, []);
});

test('a farmer cannot be left without a name or a phone number', () => {
  const f = newFarmer();
  assert.throws(() => corr.updateFarmer(f.id, { full_name: '  ' }, { at: 'x' }, users.clerk), /name/);
  assert.throws(() => corr.updateFarmer(f.id, { phone: '' }, { at: 'x' }, users.clerk), /phone/);
});

test('a supplier can be corrected the same way', () => {
  const s = out.createSupplier({ name: 'Wrong Name', phone: '111', ward_id: 2 }, users.clerk);
  corr.updateSupplier(s.id, { name: 'Right Name', phone: '254712345678' }, { at: 'x' }, users.clerk);
  const after = out.getSupplier(s.id);
  assert.equal(after.name, 'Right Name');
  assert.equal(after.phone, '254712345678');
});

// --- re-grading ------------------------------------------------------------
test('a misread moisture can be corrected, and the grade follows', () => {
  const f = newFarmer();
  const id = deliver(f, { moistureBp: 900, oilBp: 4200 });
  assert.equal(repo.getQualityTest(id).grade, 'A');

  const r = corr.regradeDelivery({
    deliveryId: id, moistureBp: 1450, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'moisture meter misread',
  }, { id: users.clerk });

  assert.equal(r.previousGrade, 'A');
  assert.equal(r.grade, 'REJECT', '14.50% moisture is not buyable');
  assert.equal(repo.getDelivery(id).status, 'Rejected');
});

test('re-grading to REJECT takes the grain back OUT of the store', () => {
  const f = newFarmer();
  const id = deliver(f);
  assert.ok(stockFor(id) > 0, 'a bought load is in the store');

  corr.regradeDelivery({
    deliveryId: id, moistureBp: 1500, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'retested wet',
  }, { id: users.clerk });

  assert.equal(stockFor(id), 0, 'and a rejected one is not');
  const rows = db.prepare(
    "SELECT COUNT(*) AS n FROM stock_movement WHERE ref_table='delivery' AND ref_id=?",
  ).get(id).n;
  assert.equal(rows, 2, 'by a reversing row — the arrival is still in the history');
});

test('re-grading a REJECT back to buyable puts the grain in', () => {
  const f = newFarmer();
  const id = deliver(f, { moistureBp: 1500 });
  assert.equal(repo.getQualityTest(id).grade, 'REJECT');
  assert.equal(stockFor(id), 0);

  corr.regradeDelivery({
    deliveryId: id, moistureBp: 900, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'wrong sample tested',
  }, { id: users.clerk });

  assert.equal(repo.getQualityTest(id).grade, 'A');
  assert.equal(stockFor(id), 620_500, 'the load is now in the store');
});

test('re-grading discards a DRAFT settlement, because it was computed from wrong readings', () => {
  const f = newFarmer();
  const id = deliver(f);
  const s = repo.createSettlement(id, { computedOn: '2026-07-10', computedAt: 'x' }, users.clerk);

  const r = corr.regradeDelivery({
    deliveryId: id, moistureBp: 1100, oilBp: 3900, foreignBp: 400, damageBp: 600,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'sample retested',
  }, { id: users.clerk });

  assert.equal(r.discardedSettlement, s.code);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlement WHERE id=?').get(s.id).n, 0);
  const audited = db.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action='settlement.discard' AND entity_id=?",
  ).get(s.id).n;
  assert.equal(audited, 1, 'but the discard is on the record');
});

test('an APPROVED settlement blocks re-grading — money needs a reversal, not an edit', () => {
  const f = newFarmer();
  const id = deliver(f);
  const s = repo.createSettlement(id, { computedOn: '2026-07-10', computedAt: 'x' }, users.clerk);
  repo.approveSettlement(s.id, { approvedAt: 'x' }, { id: users.fin, role: 'finance' });

  assert.throws(() => corr.regradeDelivery({
    deliveryId: id, moistureBp: 1100, oilBp: 3900, foreignBp: 400, damageBp: 600,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'too late',
  }, { id: users.clerk }), /reverse the payment/);

  assert.match(corr.regradeBlockedReason(id), /Approved|Paid/);
});

test('the database refuses the re-grade even if the repository check is bypassed', () => {
  const f = newFarmer();
  const id = deliver(f);
  const s = repo.createSettlement(id, { computedOn: '2026-07-10', computedAt: 'x' }, users.clerk);
  repo.approveSettlement(s.id, { approvedAt: 'x' }, { id: users.fin, role: 'finance' });

  assert.throws(
    () => db.prepare('UPDATE quality_test SET moisture_bp = 1 WHERE delivery_id = ?').run(id),
    /approved settlement/,
  );
});

test('re-grading demands a reason, and records it on the test', () => {
  const f = newFarmer();
  const id = deliver(f);
  assert.throws(() => corr.regradeDelivery({
    deliveryId: id, moistureBp: 950, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-11', testedAt: 'x', reason: '  ',
  }, { id: users.clerk }), /why/);

  corr.regradeDelivery({
    deliveryId: id, moistureBp: 950, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'meter recalibrated',
  }, { id: users.clerk });
  assert.match(repo.getQualityTest(id).notes, /meter recalibrated/);
});

test('an ungraded delivery cannot be re-graded', () => {
  const f = newFarmer();
  const { id } = repo.createDelivery({
    farmerId: f.id, contractId: f.contractId, grossG: 100_000, tareG: 1_000,
    deliveredOn: '2026-07-10', deliveredAt: 'x', vehicleReg: '', notes: '',
  }, users.clerk);
  assert.throws(() => corr.regradeDelivery({
    deliveryId: id, moistureBp: 900, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: 'x', testedAt: 'x', reason: 'nope',
  }, { id: users.clerk }), /not been graded/);
});

test('the re-grade is fully recorded: old readings, new readings, and why', () => {
  const f = newFarmer();
  const id = deliver(f, { moistureBp: 900, oilBp: 4200 });
  corr.regradeDelivery({
    deliveryId: id, moistureBp: 1200, oilBp: 3900, foreignBp: 300, damageBp: 500,
    testedOn: '2026-07-11', testedAt: 'x', reason: 'second sample',
  }, { id: users.clerk });

  const d = JSON.parse(db.prepare(
    "SELECT detail_json FROM audit_log WHERE action='delivery.regrade' AND entity_id=? ORDER BY id DESC LIMIT 1",
  ).get(id).detail_json);
  assert.equal(d.from.moisture_bp, 900);
  assert.equal(d.to.moisture_bp, 1200);
  assert.equal(d.from.grade, 'A');
  assert.equal(d.to.grade, 'B');
  assert.equal(d.reason, 'second sample');
});
