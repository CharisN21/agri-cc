// Data access. The only file that writes to the database.
//
// Two rules hold everywhere below:
//   1. Anything touching money or stock runs inside tx().
//   2. Balances are ALWAYS a SUM over an append-only table. There is no cached
//      balance column anywhere and there must never be one.
import { getDb, tx } from './db.js';
import { formatCode } from './domain/codes.js';
import { divRound } from './domain/units.js';
import { priceDelivery } from './domain/pricing.js';
import { settle } from './domain/settlement.js';
import { grade } from './domain/grading.js';

const CODE_TABLE = {
  farmer: 'farmer', parcel: 'parcel', contract: 'contract', lot: 'lot',
  input_issue: 'input_issue', delivery: 'delivery', quality_test: 'quality_test',
  settlement: 'settlement', payment: 'payment',
};

/** Next document code for an entity, derived from the codes already issued. */
export function nextCode(entity) {
  const table = CODE_TABLE[entity];
  if (!table) throw new RangeError(`no code sequence for ${entity}`);
  const row = getDb().prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(code, INSTR(code, '-') + 1) AS INTEGER)), 0) AS n
       FROM ${table}`,
  ).get();
  return formatCode(entity, row.n + 1);
}

export function audit(actorId, action, entity, entityId, detail = {}) {
  getDb().prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(actorId ?? null, action, entity, entityId ?? null, JSON.stringify(detail));
}

// --- balances, always summed ----------------------------------------------

/** Seed on hand for a lot at a location, in grams. SUM over stock_movement. */
export function stockOnHand({ itemId, lotId = null, locationId }) {
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(qty_g), 0) AS qty FROM stock_movement
      WHERE item_id = ? AND location_id = ? AND lot_id IS ?`,
  ).get(itemId, locationId, lotId);
  return row.qty;
}

/** Farmer's outstanding input credit in cents. SUM over ledger_entry. */
export function farmerBalance(farmerId, seasonId) {
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS bal FROM ledger_entry
      WHERE farmer_id = ? AND season_id = ?`,
  ).get(farmerId, seasonId);
  return row.bal;
}

// --- reference data --------------------------------------------------------
export const currentSeason = () =>
  getDb().prepare("SELECT * FROM season WHERE status = 'open' ORDER BY starts_on DESC").get();

export const currentPriceSchedule = (seasonId) =>
  getDb().prepare(
    'SELECT * FROM price_schedule WHERE season_id = ? ORDER BY version DESC LIMIT 1',
  ).get(seasonId);

export const priceScheduleById = (id) =>
  getDb().prepare('SELECT * FROM price_schedule WHERE id = ?').get(id);

export const wards = () =>
  getDb().prepare("SELECT * FROM location WHERE kind = 'ward' ORDER BY name").all();

export const mainStore = () =>
  getDb().prepare("SELECT * FROM location WHERE kind = 'store' ORDER BY id LIMIT 1").get();

export const seedItem = () =>
  getDb().prepare("SELECT * FROM item WHERE kind = 'seed' ORDER BY id LIMIT 1").get();

export const grainItem = () =>
  getDb().prepare("SELECT * FROM item WHERE kind = 'grain' ORDER BY id LIMIT 1").get();

/** Price schedules are immutable; a change is a new version. */
export function addPriceScheduleVersion(seasonId, fields, actorId) {
  return tx((db) => {
    const prev = currentPriceSchedule(seasonId);
    const version = prev ? prev.version + 1 : 1;
    const info = db.prepare(
      `INSERT INTO price_schedule
         (season_id, version, effective_from, base_price_cents, oil_premium_cents,
          moisture_discount_cents, damage_discount_cents, cess_bp,
          recovery_share_bp, cash_floor_cents)
       VALUES (@season_id, @version, @effective_from, @base_price_cents,
               @oil_premium_cents, @moisture_discount_cents, @damage_discount_cents,
               @cess_bp, @recovery_share_bp, @cash_floor_cents)`,
    ).run({ season_id: seasonId, version, ...fields });
    audit(actorId, 'price_schedule.version', 'price_schedule', info.lastInsertRowid, { version });
    return info.lastInsertRowid;
  });
}

// --- farmers ---------------------------------------------------------------
export function createFarmer(data, actorId) {
  return tx((db) => {
    const code = nextCode('farmer');
    const info = db.prepare(
      `INSERT INTO farmer (code, full_name, national_id, phone, mm_name, ward_id,
                           notes, registered_on, registered_at)
       VALUES (@code, @full_name, @national_id, @phone, @mm_name, @ward_id,
               @notes, @registered_on, @registered_at)`,
    ).run({ code, ...data });
    audit(actorId, 'farmer.create', 'farmer', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

export function listFarmers({ q = '', wardId = null, limit = 200 } = {}) {
  const season = currentSeason();
  return getDb().prepare(
    `SELECT f.*, l.name AS ward_name,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entry le
              WHERE le.farmer_id = f.id AND le.season_id = @season_id) AS balance_cents,
            (SELECT COALESCE(SUM(d.gross_g - d.tare_g), 0) FROM delivery d
              WHERE d.farmer_id = f.id AND d.season_id = @season_id
                AND d.status <> 'Rejected') AS delivered_g,
            (SELECT COALESCE(SUM(c.expected_g), 0) FROM contract c
              WHERE c.farmer_id = f.id AND c.season_id = @season_id
                AND c.status = 'Signed') AS expected_g
       FROM farmer f
       JOIN location l ON l.id = f.ward_id
      WHERE (@q = '' OR f.full_name LIKE @like OR f.code LIKE @like
             OR f.phone LIKE @like OR f.national_id LIKE @like)
        AND (@ward_id IS NULL OR f.ward_id = @ward_id)
      ORDER BY f.code
      LIMIT @limit`,
  ).all({ q, like: `%${q}%`, ward_id: wardId, limit, season_id: season?.id ?? 0 });
}

export const getFarmer = (id) =>
  getDb().prepare(
    `SELECT f.*, l.name AS ward_name FROM farmer f
       JOIN location l ON l.id = f.ward_id WHERE f.id = ?`,
  ).get(id);

export const farmerParcels = (farmerId) =>
  getDb().prepare('SELECT * FROM parcel WHERE farmer_id = ? ORDER BY code').all(farmerId);

export function createParcel(data, actorId) {
  return tx((db) => {
    const code = nextCode('parcel');
    const info = db.prepare(
      `INSERT INTO parcel (farmer_id, code, acreage_bp, gps_lat, gps_lng, notes)
       VALUES (@farmer_id, @code, @acreage_bp, @gps_lat, @gps_lng, @notes)`,
    ).run({ code, gps_lat: null, gps_lng: null, notes: '', ...data });
    audit(actorId, 'parcel.create', 'parcel', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

// --- contracts -------------------------------------------------------------
export function offerContract(data, actorId) {
  return tx((db) => {
    const code = nextCode('contract');
    const info = db.prepare(
      `INSERT INTO contract (code, farmer_id, parcel_id, season_id, expected_g,
                             seed_entitlement_g, recovery_share_bp, offered_on, notes)
       VALUES (@code, @farmer_id, @parcel_id, @season_id, @expected_g,
               @seed_entitlement_g, @recovery_share_bp, @offered_on, @notes)`,
    ).run({ code, notes: '', ...data });
    audit(actorId, 'contract.offer', 'contract', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

export function signContract(contractId, { signedOn, signedAt }, actorId) {
  return tx((db) => {
    const c = db.prepare('SELECT * FROM contract WHERE id = ?').get(contractId);
    if (!c) throw new Error('contract not found');
    if (c.status !== 'Offered') throw new Error(`contract ${c.code} is ${c.status}, not Offered`);
    db.prepare(
      "UPDATE contract SET status = 'Signed', signed_on = ?, signed_at = ? WHERE id = ?",
    ).run(signedOn, signedAt, contractId);
    audit(actorId, 'contract.sign', 'contract', contractId, { code: c.code });
    return true;
  });
}

export const listContracts = ({ seasonId, status = null } = {}) =>
  getDb().prepare(
    `SELECT c.*, f.full_name, f.code AS farmer_code, l.name AS ward_name, p.code AS parcel_code,
            (SELECT COALESCE(SUM(qty_g), 0) FROM input_issue ii WHERE ii.contract_id = c.id) AS issued_g
       FROM contract c
       JOIN farmer f ON f.id = c.farmer_id
       JOIN parcel p ON p.id = c.parcel_id
       JOIN location l ON l.id = f.ward_id
      WHERE c.season_id = @season_id AND (@status IS NULL OR c.status = @status)
      ORDER BY c.code`,
  ).all({ season_id: seasonId, status });

export const getContract = (id) =>
  getDb().prepare(
    `SELECT c.*, f.full_name, f.code AS farmer_code FROM contract c
       JOIN farmer f ON f.id = c.farmer_id WHERE c.id = ?`,
  ).get(id);

// --- lots and seed issue ---------------------------------------------------
export const listLots = (asOf) =>
  getDb().prepare(
    `SELECT lo.*, i.name AS item_name,
            (SELECT COALESCE(SUM(qty_g), 0) FROM stock_movement sm
              WHERE sm.lot_id = lo.id) AS on_hand_g,
            CASE WHEN lo.retest_due_on < @as_of THEN 1 ELSE 0 END AS overdue
       FROM lot lo JOIN item i ON i.id = lo.item_id
      ORDER BY lo.code`,
  ).all({ as_of: asOf });

/**
 * Issue seed from a lot against a SIGNED contract.
 *
 * One transaction writes three things: the stock movement out of the store, the
 * issue record, and the farmer's debit in the ledger. The database rejects the
 * whole thing if the contract is unsigned, the lot is overdue for retest, or
 * the store does not hold enough seed.
 */
export function issueInputs({
  contractId, lotId, qtyG, issuedOn, issuedAt, notes = '',
}, actorId) {
  return tx((db) => {
    const contract = db.prepare('SELECT * FROM contract WHERE id = ?').get(contractId);
    if (!contract) throw new Error('contract not found');
    if (contract.status !== 'Signed') {
      throw new Error('cannot issue inputs against an unsigned contract');
    }
    const lot = db.prepare('SELECT * FROM lot WHERE id = ?').get(lotId);
    if (!lot) throw new Error('lot not found');
    if (lot.retest_due_on < issuedOn) throw new Error('lot is overdue for germination retest');

    const store = mainStore();
    // qty is grams, unit cost is cents per kilogram. Integer division, not a
    // float divide rounded afterwards.
    const valueCents = divRound(qtyG * lot.unit_cost_cents, 1000);
    const code = nextCode('input_issue');

    // Stock out. The no-negative trigger rejects this if the store is short.
    db.prepare(
      `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason,
                                   ref_table, ref_id, notes, created_by)
       VALUES (?, ?, ?, ?, 'issue', 'input_issue', NULL, ?, ?)`,
    ).run(lot.item_id, lot.id, store.id, -qtyG, notes, actorId ?? null);

    const info = db.prepare(
      `INSERT INTO input_issue (code, contract_id, farmer_id, lot_id, qty_g,
                                unit_cost_cents, value_cents, issued_on, issued_at,
                                notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(code, contractId, contract.farmer_id, lotId, qtyG, lot.unit_cost_cents,
          valueCents, issuedOn, issuedAt, notes, actorId ?? null);

    // Debit the farmer: positive means the farmer owes us.
    db.prepare(
      `INSERT INTO ledger_entry (farmer_id, season_id, amount_cents, kind,
                                 ref_table, ref_id, notes, created_by)
       VALUES (?, ?, ?, 'input_credit', 'input_issue', ?, ?, ?)`,
    ).run(contract.farmer_id, contract.season_id, valueCents,
          info.lastInsertRowid, `Seed issue ${code}`, actorId ?? null);

    audit(actorId, 'input.issue', 'input_issue', info.lastInsertRowid,
          { code, qtyG, valueCents });
    return { id: info.lastInsertRowid, code, valueCents };
  });
}

export const listIssues = (seasonId) =>
  getDb().prepare(
    `SELECT ii.*, f.full_name, f.code AS farmer_code, c.code AS contract_code,
            lo.code AS lot_code, lo.kephis_tag
       FROM input_issue ii
       JOIN farmer f ON f.id = ii.farmer_id
       JOIN contract c ON c.id = ii.contract_id
       JOIN lot lo ON lo.id = ii.lot_id
      WHERE c.season_id = ?
      ORDER BY ii.id DESC`,
  ).all(seasonId);

// --- deliveries ------------------------------------------------------------
export function createDelivery({
  farmerId, contractId, grossG, tareG, deliveredOn, deliveredAt, vehicleReg = '', notes = '',
}, actorId) {
  return tx((db) => {
    const contract = db.prepare('SELECT * FROM contract WHERE id = ?').get(contractId);
    if (!contract) throw new Error('contract not found');
    const store = mainStore();
    const code = nextCode('delivery');
    const info = db.prepare(
      `INSERT INTO delivery (code, farmer_id, contract_id, season_id, location_id,
                             gross_g, tare_g, delivered_on, delivered_at,
                             vehicle_reg, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(code, farmerId, contractId, contract.season_id, store.id, grossG, tareG,
          deliveredOn, deliveredAt, vehicleReg, notes, actorId ?? null);
    audit(actorId, 'delivery.create', 'delivery', info.lastInsertRowid, { code, grossG, tareG });
    return { id: info.lastInsertRowid, code };
  });
}

/** Record a quality test. The grade is DERIVED, never typed in. */
export function gradeDelivery({
  deliveryId, moistureBp, oilBp, foreignBp, damageBp, testedOn, testedAt, notes = '',
}, actorId) {
  return tx((db) => {
    const delivery = db.prepare('SELECT * FROM delivery WHERE id = ?').get(deliveryId);
    if (!delivery) throw new Error('delivery not found');
    const existing = db.prepare('SELECT id FROM quality_test WHERE delivery_id = ?').get(deliveryId);
    if (existing) throw new Error(`delivery ${delivery.code} has already been graded`);

    const g = grade({ moistureBp, oilBp, foreignBp });
    const code = nextCode('quality_test');
    const info = db.prepare(
      `INSERT INTO quality_test (code, delivery_id, moisture_bp, oil_bp, foreign_bp,
                                 damage_bp, grade, tested_on, tested_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(code, deliveryId, moistureBp, oilBp, foreignBp, damageBp, g,
          testedOn, testedAt, notes, actorId ?? null);

    db.prepare('UPDATE delivery SET status = ? WHERE id = ?')
      .run(g === 'REJECT' ? 'Rejected' : 'Graded', deliveryId);

    // A bought load enters grain stock. A rejected load never does.
    if (g !== 'REJECT') {
      const grain = grainItem();
      db.prepare(
        `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason,
                                     ref_table, ref_id, notes, created_by)
         VALUES (?, NULL, ?, ?, 'delivery_in', 'delivery', ?, ?, ?)`,
      ).run(grain.id, delivery.location_id, delivery.gross_g - delivery.tare_g,
            deliveryId, `Grade ${g} intake`, actorId ?? null);
    }

    audit(actorId, 'delivery.grade', 'delivery', deliveryId, { code, grade: g });
    return { id: info.lastInsertRowid, code, grade: g };
  });
}

export const listDeliveries = ({ seasonId, status = null, limit = 200 } = {}) =>
  getDb().prepare(
    `SELECT d.*, f.full_name, f.code AS farmer_code, l.name AS ward_name,
            q.grade, q.moisture_bp, q.oil_bp, q.foreign_bp, q.damage_bp,
            s.id AS settlement_id, s.code AS settlement_code, s.status AS settlement_status
       FROM delivery d
       JOIN farmer f ON f.id = d.farmer_id
       JOIN location l ON l.id = f.ward_id
       LEFT JOIN quality_test q ON q.delivery_id = d.id
       LEFT JOIN settlement s ON s.delivery_id = d.id
      WHERE d.season_id = @season_id AND (@status IS NULL OR d.status = @status)
      ORDER BY d.id DESC LIMIT @limit`,
  ).all({ season_id: seasonId, status, limit });

export const getDelivery = (id) =>
  getDb().prepare(
    `SELECT d.*, f.full_name, f.code AS farmer_code, f.phone, f.mm_name, f.national_id,
            l.name AS ward_name, c.code AS contract_code, c.recovery_share_bp,
            c.expected_g
       FROM delivery d
       JOIN farmer f ON f.id = d.farmer_id
       JOIN contract c ON c.id = d.contract_id
       JOIN location l ON l.id = f.ward_id
      WHERE d.id = ?`,
  ).get(id);

export const getQualityTest = (deliveryId) =>
  getDb().prepare('SELECT * FROM quality_test WHERE delivery_id = ?').get(deliveryId);

// --- settlement ------------------------------------------------------------

/** Compute the settlement figures for a delivery WITHOUT writing anything.
 *  The delivery screen uses this to show the working before anyone commits. */
export function previewSettlement(deliveryId) {
  const delivery = getDelivery(deliveryId);
  if (!delivery) throw new Error('delivery not found');
  const q = getQualityTest(deliveryId);
  if (!q) return null;
  if (q.grade === 'REJECT') return { rejected: true, delivery, quality: q };

  const schedule = currentPriceSchedule(delivery.season_id);
  const owed = farmerBalance(delivery.farmer_id, delivery.season_id);
  const priced = priceDelivery({
    netG: delivery.gross_g - delivery.tare_g,
    moistureBp: q.moisture_bp, oilBp: q.oil_bp,
    foreignBp: q.foreign_bp, damageBp: q.damage_bp,
  }, schedule);
  const settled = settle({
    grossValueCents: priced.grossValueCents,
    owedCents: Math.max(0, owed),
    cessBp: schedule.cess_bp,
    recoveryShareBp: delivery.recovery_share_bp ?? schedule.recovery_share_bp,
    cashFloorCents: schedule.cash_floor_cents,
  });
  return { delivery, quality: q, schedule, owed, priced, settled };
}

export function createSettlement(deliveryId, { computedOn, computedAt }, actorId) {
  return tx((db) => {
    const p = previewSettlement(deliveryId);
    if (!p) throw new Error('cannot settle a delivery with no quality test');
    if (p.rejected) throw new Error('a rejected load cannot be settled');
    const existing = db.prepare('SELECT id FROM settlement WHERE delivery_id = ?').get(deliveryId);
    if (existing) throw new Error('this delivery already has a settlement');

    const code = nextCode('settlement');
    const info = db.prepare(
      `INSERT INTO settlement
         (code, delivery_id, farmer_id, season_id, price_schedule_id, payable_g,
          unit_price_cents, gross_value_cents, cess_cents, recovery_cents,
          recovery_cap, net_payable_cents, amount_paid_cents, balance_cents,
          computed_on, computed_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(code, deliveryId, p.delivery.farmer_id, p.delivery.season_id, p.schedule.id,
          p.priced.payableG, p.priced.unitPriceCents, p.priced.grossValueCents,
          p.settled.cessCents, p.settled.recoveryCents, p.settled.recoveryCap,
          p.settled.netPayableCents, p.settled.netPayableCents,
          computedOn, computedAt, p.settled.capExplanation, actorId ?? null);

    db.prepare("UPDATE delivery SET status = 'Settled' WHERE id = ?").run(deliveryId);
    audit(actorId, 'settlement.compute', 'settlement', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

/**
 * Approve a settlement and queue the payout.
 *
 * The transactional outbox lives here: the settlement status change, the debt
 * recovery ledger entry, and the outbox instruction are written in ONE
 * transaction. Either all three land or none do. A separate worker drains the
 * outbox, so a payment provider being down can never lose an approval.
 */
export function approveSettlement(settlementId, { approvedAt }, actor) {
  return tx((db) => {
    const s = db.prepare('SELECT * FROM settlement WHERE id = ?').get(settlementId);
    if (!s) throw new Error('settlement not found');
    if (s.status !== 'Pending') throw new Error(`settlement ${s.code} is already ${s.status}`);

    const q = db.prepare('SELECT created_by FROM quality_test WHERE delivery_id = ?')
      .get(s.delivery_id);
    if (q && q.created_by === actor.id) {
      throw new Error('the grader of a delivery may not approve its settlement');
    }

    db.prepare(
      "UPDATE settlement SET status = 'Approved', approved_by = ?, approved_at = ? WHERE id = ?",
    ).run(actor.id, approvedAt, settlementId);

    // Recovery reduces the debt only now, at approval — not at computation.
    if (s.recovery_cents > 0) {
      db.prepare(
        `INSERT INTO ledger_entry (farmer_id, season_id, amount_cents, kind,
                                   ref_table, ref_id, notes, created_by)
         VALUES (?, ?, ?, 'recovery', 'settlement', ?, ?, ?)`,
      ).run(s.farmer_id, s.season_id, -s.recovery_cents, settlementId,
            `Recovered on ${s.code}`, actor.id);
    }

    // Same transaction: the instruction to pay.
    if (s.net_payable_cents > 0) {
      db.prepare(
        `INSERT INTO outbox (topic, payload_json, idempotency_key)
         VALUES ('payment.requested', ?, ?)`,
      ).run(
        JSON.stringify({
          settlementId, settlementCode: s.code, farmerId: s.farmer_id,
          amountCents: s.net_payable_cents,
        }),
        `payout:${s.code}`,
      );
    } else {
      db.prepare("UPDATE settlement SET status = 'Paid' WHERE id = ?").run(settlementId);
    }

    audit(actor.id, 'settlement.approve', 'settlement', settlementId, { code: s.code });
    return true;
  });
}

export const listSettlements = ({ seasonId, status = null } = {}) =>
  getDb().prepare(
    `SELECT s.*, f.full_name, f.code AS farmer_code, f.mm_name, f.phone,
            d.code AS delivery_code, l.name AS ward_name, q.grade,
            p.code AS payment_code, p.provider_ref, p.method
       FROM settlement s
       JOIN farmer f ON f.id = s.farmer_id
       JOIN delivery d ON d.id = s.delivery_id
       JOIN location l ON l.id = f.ward_id
       LEFT JOIN quality_test q ON q.delivery_id = s.delivery_id
       LEFT JOIN payment p ON p.settlement_id = s.id AND p.status = 'Paid'
      WHERE s.season_id = @season_id AND (@status IS NULL OR s.status = @status)
      ORDER BY s.id DESC`,
  ).all({ season_id: seasonId, status });

export const getSettlement = (id) =>
  getDb().prepare(
    `SELECT s.*, f.full_name, f.code AS farmer_code, f.mm_name, f.national_id, f.phone,
            d.code AS delivery_code, d.gross_g, d.tare_g, d.net_g
       FROM settlement s
       JOIN farmer f ON f.id = s.farmer_id
       JOIN delivery d ON d.id = s.delivery_id
      WHERE s.id = ?`,
  ).get(id);

export const settlementPayments = (settlementId) =>
  getDb().prepare('SELECT * FROM payment WHERE settlement_id = ? ORDER BY id').all(settlementId);
