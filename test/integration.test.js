// End-to-end tests against a real (temporary) database file, exercising the
// repository layer and the outbox worker rather than raw SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the app at a scratch database BEFORE anything imports config.
const dbFile = path.join(os.tmpdir(), `agri-cc-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.SESSION_SECRET = 'test-secret';

const { migrate, getDb, closeDb } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const { hashPassword } = await import('../src/auth.js');
const { can } = await import('../src/auth.js');
const { drainOutbox } = await import('../src/payments/worker.js');
const { SimulatedProvider, setProvider } = await import('../src/payments/provider.js');

migrate({ log: () => {} });

process.on('exit', () => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbFile + suffix); } catch { /* already gone */ }
  }
});

// --- a small world we can settle against ----------------------------------
const db = getDb();
const users = {};
for (const [username, role] of [['clerk', 'clerk'], ['fin', 'finance'],
                                ['owner', 'owner'], ['field', 'field_officer']]) {
  const { hash, salt } = hashPassword('pw');
  users[username] = db.prepare(
    `INSERT INTO app_user (username, full_name, role, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(username, username, role, hash, salt).lastInsertRowid;
}
db.exec(`
  INSERT INTO location (id, code, name, kind) VALUES (1, 'STR', 'Store', 'store'),
                                                     (2, 'WRD', 'Ward', 'ward');
  INSERT INTO season (id, code, name, starts_on, ends_on, target_g)
    VALUES (1, 'S1', 'Season', '2026-03-01', '2026-11-30', 30000000);
  INSERT INTO price_schedule (id, season_id, version, effective_from, base_price_cents,
    oil_premium_cents, moisture_discount_cents, damage_discount_cents, cess_bp,
    recovery_share_bp, cash_floor_cents)
    VALUES (1, 1, 1, '2026-03-01', 5800, 150, 200, 120, 50, 5000, 200000);
  INSERT INTO item (id, code, name, kind) VALUES (1, 'SEED', 'Seed', 'seed'),
                                                 (2, 'GRAIN', 'Grain', 'grain');
  INSERT INTO lot (id, code, item_id, kephis_tag, germination_bp, retest_due_on,
                   unit_cost_cents, received_on)
    VALUES (1, 'LOT-0001', 1, 'K/1', 9000, '2027-01-01', 32000, '2026-02-20');
  INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason)
    VALUES (1, 1, 1, 500000, 'receipt');
`);

function makeFarmerWithSignedContract(n) {
  const { id: farmerId } = repo.createFarmer({
    full_name: `Farmer ${n}`, national_id: `ID${n}`, phone: `25470000000${n}`,
    mm_name: `Farmer ${n}`, ward_id: 2, notes: '',
    registered_on: '2026-03-02', registered_at: '2026-03-02T09:00:00Z',
  }, users.field);
  const { id: parcelId } = repo.createParcel(
    { farmer_id: farmerId, acreage_bp: 20000, notes: '' }, users.field);
  const { id: contractId } = repo.offerContract({
    farmer_id: farmerId, parcel_id: parcelId, season_id: 1, expected_g: 1_400_000,
    seed_entitlement_g: 8000, recovery_share_bp: 5000, offered_on: '2026-03-05', notes: '',
  }, users.owner);
  repo.signContract(contractId, { signedOn: '2026-03-10', signedAt: '2026-03-10T11:00:00Z' },
                    users.owner);
  return { farmerId, contractId };
}

function deliverAndGrade({ farmerId, contractId }, grader = users.field) {
  const { id: deliveryId } = repo.createDelivery({
    farmerId, contractId, grossG: 641_000, tareG: 20_500,
    deliveredOn: '2026-07-10', deliveredAt: '2026-07-10T11:00:00Z',
    vehicleReg: 'KAA 111A', notes: 'test load',
  }, users.clerk);
  repo.gradeDelivery({
    deliveryId, moistureBp: 900, oilBp: 4200, foreignBp: 100, damageBp: 200,
    testedOn: '2026-07-10', testedAt: '2026-07-10T11:30:00Z', notes: '',
  }, grader);
  return deliveryId;
}

// --- role separation -------------------------------------------------------
test('a clerk may not approve a settlement; finance and owner may', () => {
  assert.equal(can({ role: 'clerk' }, 'settlement.approve'), false);
  assert.equal(can({ role: 'field_officer' }, 'settlement.approve'), false);
  assert.equal(can({ role: 'finance' }, 'settlement.approve'), true);
  assert.equal(can({ role: 'owner' }, 'settlement.approve'), true);
  assert.equal(can({ role: 'ops_manager' }, 'settlement.approve'), true);
});

test('a clerk CAN do the jobs a clerk actually does', () => {
  assert.equal(can({ role: 'clerk' }, 'delivery.create'), true);
  assert.equal(can({ role: 'clerk' }, 'delivery.grade'), true);
  assert.equal(can({ role: 'clerk' }, 'settlement.compute'), true);
});

test('the person who graded cannot approve, whatever their role', () => {
  const f = makeFarmerWithSignedContract('grader');
  repo.issueInputs({ contractId: f.contractId, lotId: 1, qtyG: 8000,
                     issuedOn: '2026-03-15', issuedAt: '2026-03-15T10:00:00Z', notes: '' },
                   users.field);
  // Grade it as the finance user — who is otherwise allowed to approve.
  const deliveryId = deliverAndGrade(f, users.fin);
  const { id: settlementId } = repo.createSettlement(deliveryId,
    { computedOn: '2026-07-10', computedAt: '2026-07-10T12:00:00Z' }, users.clerk);

  assert.throws(
    () => repo.approveSettlement(settlementId, { approvedAt: '2026-07-11T09:00:00Z' },
                                 { id: users.fin, role: 'finance' }),
    /may not approve/,
  );
  // A different approver is fine.
  repo.approveSettlement(settlementId, { approvedAt: '2026-07-11T09:00:00Z' },
                         { id: users.owner, role: 'owner' });
  assert.equal(
    db.prepare('SELECT status FROM settlement WHERE id = ?').get(settlementId).status,
    'Approved',
  );
});

// --- the outbox ------------------------------------------------------------
test('approval writes the outbox row in the SAME transaction as the status change', () => {
  const f = makeFarmerWithSignedContract('outbox');
  const deliveryId = deliverAndGrade(f);
  const { id: settlementId, code } = repo.createSettlement(deliveryId,
    { computedOn: '2026-07-10', computedAt: '2026-07-10T12:00:00Z' }, users.clerk);

  const before = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key = ?")
    .get(`payout:${code}`).n;
  assert.equal(before, 0);

  repo.approveSettlement(settlementId, { approvedAt: '2026-07-11T09:00:00Z' },
                         { id: users.fin, role: 'finance' });

  const s = db.prepare('SELECT * FROM settlement WHERE id = ?').get(settlementId);
  const o = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(`payout:${code}`);
  assert.equal(s.status, 'Approved');
  assert.ok(o, 'the instruction exists');
  assert.equal(o.status, 'pending');
  // Both landed; neither can exist without the other.
  assert.equal(JSON.parse(o.payload_json).amountCents, s.net_payable_cents);
});

test('a failed approval leaves NOTHING behind — no status change, no outbox row', () => {
  const f = makeFarmerWithSignedContract('rollback');
  const deliveryId = deliverAndGrade(f, users.fin);
  const { id: settlementId, code } = repo.createSettlement(deliveryId,
    { computedOn: '2026-07-10', computedAt: '2026-07-10T12:00:00Z' }, users.clerk);

  assert.throws(() => repo.approveSettlement(
    settlementId, { approvedAt: '2026-07-11T09:00:00Z' }, { id: users.fin, role: 'finance' }));

  const s = db.prepare('SELECT * FROM settlement WHERE id = ?').get(settlementId);
  assert.equal(s.status, 'Pending', 'status was rolled back');
  assert.equal(s.approved_by, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key = ?')
      .get(`payout:${code}`).n, 0, 'no orphan instruction',
  );
});

test('draining the outbox twice produces exactly ONE payment', async () => {
  const f = makeFarmerWithSignedContract('idem');
  const deliveryId = deliverAndGrade(f);
  const { id: settlementId } = repo.createSettlement(deliveryId,
    { computedOn: '2026-07-10', computedAt: '2026-07-10T12:00:00Z' }, users.clerk);
  repo.approveSettlement(settlementId, { approvedAt: '2026-07-11T09:00:00Z' },
                         { id: users.fin, role: 'finance' });

  const first = await drainOutbox();
  assert.ok(first.paid >= 1);

  const paymentsAfterFirst = repo.settlementPayments(settlementId);
  assert.equal(paymentsAfterFirst.length, 1);

  // Force the same instruction back into the queue and drain again — this is
  // the retry that must not double-pay.
  db.prepare("UPDATE outbox SET status = 'pending', processed_at = NULL WHERE idempotency_key = ?")
    .run(paymentsAfterFirst[0].idempotency_key);

  const second = await drainOutbox();
  assert.equal(second.duplicate, 1, 'the second drain recognised the duplicate');
  assert.equal(second.paid, 0, 'and paid nobody again');
  assert.equal(repo.settlementPayments(settlementId).length, 1, 'still exactly one payment');
});

test('a provider failure leaves the instruction queued for retry, unpaid', async () => {
  const f = makeFarmerWithSignedContract('fail');
  const deliveryId = deliverAndGrade(f);
  const { id: settlementId, code } = repo.createSettlement(deliveryId,
    { computedOn: '2026-07-10', computedAt: '2026-07-10T12:00:00Z' }, users.clerk);
  repo.approveSettlement(settlementId, { approvedAt: '2026-07-11T09:00:00Z' },
                         { id: users.fin, role: 'finance' });

  setProvider(new SimulatedProvider({ failKeys: new Set([`payout:${code}`]) }));
  const r = await drainOutbox();
  assert.ok(r.failed >= 1);
  assert.equal(repo.settlementPayments(settlementId).length, 0, 'nobody was paid');
  const o = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(`payout:${code}`);
  assert.equal(o.status, 'pending', 'queued for another go');
  assert.ok(o.attempts >= 1);
  assert.match(o.last_error, /simulated/);
  setProvider(new SimulatedProvider());
});

// --- reproducibility -------------------------------------------------------
test('a stored settlement can be recomputed from stored data alone', async () => {
  const { priceDelivery } = await import('../src/domain/pricing.js');
  const { settle } = await import('../src/domain/settlement.js');

  for (const s of db.prepare('SELECT * FROM settlement').all()) {
    const d = db.prepare('SELECT * FROM delivery WHERE id = ?').get(s.delivery_id);
    const q = db.prepare('SELECT * FROM quality_test WHERE delivery_id = ?').get(s.delivery_id);
    // The version the settlement itself recorded — not "the current price".
    const sch = repo.priceScheduleById(s.price_schedule_id);

    const priced = priceDelivery({
      netG: d.net_g, moistureBp: q.moisture_bp, oilBp: q.oil_bp,
      foreignBp: q.foreign_bp, damageBp: q.damage_bp,
    }, sch);
    assert.equal(priced.payableG, s.payable_g, `payable weight for ${s.code}`);
    assert.equal(priced.unitPriceCents, s.unit_price_cents, `unit price for ${s.code}`);
    assert.equal(priced.grossValueCents, s.gross_value_cents, `gross value for ${s.code}`);

    // Re-run the settlement against the debt the farmer actually carried at the
    // time: the ledger before this settlement's own recovery entry.
    const owedThen = db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger_entry
        WHERE farmer_id = ? AND season_id = ?
          AND NOT (kind = 'recovery' AND ref_table = 'settlement' AND ref_id = ?)`,
    ).get(s.farmer_id, s.season_id, s.id).b;

    const again = settle({
      grossValueCents: s.gross_value_cents,
      owedCents: Math.max(0, owedThen),
      cessBp: sch.cess_bp,
      recoveryShareBp: sch.recovery_share_bp,
      cashFloorCents: sch.cash_floor_cents,
    });
    assert.equal(again.cessCents, s.cess_cents, `cess for ${s.code}`);
    assert.equal(again.recoveryCents, s.recovery_cents, `recovery for ${s.code}`);
    assert.equal(again.recoveryCap, s.recovery_cap, `binding cap for ${s.code}`);
    assert.equal(again.netPayableCents, s.net_payable_cents, `net payable for ${s.code}`);
    assert.equal(
      s.net_payable_cents,
      s.gross_value_cents - s.cess_cents - s.recovery_cents,
      `the stored settlement is internally consistent for ${s.code}`,
    );
  }
});

test('every farmer balance equals the SUM of their ledger, with no cached column', () => {
  const cols = db.prepare('PRAGMA table_info(farmer)').all().map((c) => c.name);
  for (const forbidden of ['balance', 'balance_cents', 'debt_cents', 'owed_cents']) {
    assert.ok(!cols.includes(forbidden), `farmer must not cache ${forbidden}`);
  }
  for (const f of db.prepare('SELECT id FROM farmer').all()) {
    const summed = db.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger_entry WHERE farmer_id = ? AND season_id = 1',
    ).get(f.id).b;
    assert.equal(repo.farmerBalance(f.id, 1), summed);
  }
});
