// Data access for outsourcing: suppliers, supply runs, run costs, spot purchases.
//
// Kept separate from repo.js because it is a genuinely different trade: no
// contract, no seed on credit, no debt recovery. We turn up, agree a price, pay
// cash, and carry the grain home — and the interesting question is what the
// carrying cost.
//
// Same two rules as repo.js: money and stock move inside tx(), and nothing is
// cached that could be summed.
import { getDb, tx } from './db.js';
import { formatCode } from './domain/codes.js';
import { grade } from './domain/grading.js';
import { priceSpotPurchase, runCosting, runVsContracted } from './domain/outsourcing.js';
import { audit, grainItem, mainStore, currentPriceSchedule } from './repo.js';

/**
 * What contracted grain actually cost us per tonne this season — gross value
 * plus cess, over the tonnage settled. This is the honest baseline to judge a
 * supply run against. Falls back to the schedule base price before any
 * settlement exists.
 */
export function contractedPerTonneCents(seasonId) {
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(gross_value_cents + cess_cents), 0) AS cents,
            COALESCE(SUM(payable_g), 0) AS g
       FROM settlement WHERE season_id = ? AND status <> 'Rejected'`,
  ).get(seasonId);
  if (row.g > 0) return Math.round((row.cents * 1_000_000) / row.g);
  const sch = currentPriceSchedule(seasonId);
  return sch ? sch.base_price_cents * 1000 : 0;
}

const nextIn = (table, prefix, width) => {
  const row = getDb().prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(code, INSTR(code, '-') + 1) AS INTEGER)), 0) AS n FROM ${table}`,
  ).get();
  return `${prefix}-${String(row.n + 1).padStart(width, '0')}`;
};

// --- spot price schedule ---------------------------------------------------
export const currentSpotSchedule = (seasonId) =>
  getDb().prepare(
    'SELECT * FROM spot_price_schedule WHERE season_id = ? ORDER BY version DESC LIMIT 1',
  ).get(seasonId);

export const spotScheduleById = (id) =>
  getDb().prepare('SELECT * FROM spot_price_schedule WHERE id = ?').get(id);

/** Spot schedules are immutable; a price change is a new version. */
export function addSpotScheduleVersion(seasonId, fields, actorId) {
  return tx((db) => {
    const prev = currentSpotSchedule(seasonId);
    const version = prev ? prev.version + 1 : 1;
    const info = db.prepare(
      `INSERT INTO spot_price_schedule
         (season_id, version, effective_from, base_price_cents, oil_premium_cents,
          moisture_discount_cents, damage_discount_cents, cess_bp)
       VALUES (@season_id, @version, @effective_from, @base_price_cents,
               @oil_premium_cents, @moisture_discount_cents,
               @damage_discount_cents, @cess_bp)`,
    ).run({ season_id: seasonId, version, cess_bp: 50, ...fields });
    audit(actorId, 'spot_price_schedule.version', 'spot_price_schedule',
          info.lastInsertRowid, { version });
    return info.lastInsertRowid;
  });
}

// --- suppliers -------------------------------------------------------------
export function createSupplier(data, actorId) {
  return tx((db) => {
    const code = nextIn('supplier', 'SUP', 4);
    const info = db.prepare(
      `INSERT INTO supplier (code, name, phone, area, ward_id, national_id, mm_name, notes, created_by)
       VALUES (@code, @name, @phone, @area, @ward_id, @national_id, @mm_name, @notes, @created_by)`,
    ).run({
      code, phone: '', area: '', ward_id: null, national_id: null,
      mm_name: '', notes: '', ...data, created_by: actorId ?? null,
    });
    audit(actorId, 'supplier.create', 'supplier', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

export const listSuppliers = ({ q = '' } = {}) =>
  getDb().prepare(
    `SELECT s.*, l.name AS ward_name,
            (SELECT COUNT(*) FROM spot_purchase sp WHERE sp.supplier_id = s.id) AS loads,
            (SELECT COALESCE(SUM(sp.payable_g), 0) FROM spot_purchase sp
              WHERE sp.supplier_id = s.id) AS supplied_g,
            (SELECT COALESCE(SUM(sp.net_payable_cents), 0) FROM spot_purchase sp
              WHERE sp.supplier_id = s.id) AS paid_cents
       FROM supplier s
       LEFT JOIN location l ON l.id = s.ward_id
      WHERE (@q = '' OR s.name LIKE @like OR s.code LIKE @like OR s.phone LIKE @like)
      ORDER BY s.code`,
  ).all({ q, like: `%${q}%` });

export const getSupplier = (id) =>
  getDb().prepare(
    `SELECT s.*, l.name AS ward_name FROM supplier s
       LEFT JOIN location l ON l.id = s.ward_id WHERE s.id = ?`,
  ).get(id);

// --- supply runs -----------------------------------------------------------
export function createRun(data, actorId) {
  return tx((db) => {
    const code = nextIn('supply_run', 'RUN', 4);
    const store = mainStore();
    const info = db.prepare(
      `INSERT INTO supply_run (code, season_id, location_id, field_officer_id,
                               area, vehicle_reg, started_on, notes, created_by)
       VALUES (@code, @season_id, @location_id, @field_officer_id, @area,
               @vehicle_reg, @started_on, @notes, @created_by)`,
    ).run({
      code, location_id: store.id, field_officer_id: actorId ?? null,
      area: '', vehicle_reg: '', notes: '', ...data, created_by: actorId ?? null,
    });
    audit(actorId, 'run.create', 'supply_run', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

export function closeRun(runId, { endedOn }, actorId) {
  return tx((db) => {
    const r = db.prepare('SELECT * FROM supply_run WHERE id = ?').get(runId);
    if (!r) throw new Error('supply run not found');
    if (r.status === 'Closed') throw new Error(`${r.code} is already closed`);
    db.prepare("UPDATE supply_run SET status = 'Closed', ended_on = ? WHERE id = ?")
      .run(endedOn, runId);
    audit(actorId, 'run.close', 'supply_run', runId, { code: r.code });
    return true;
  });
}

export function reopenRun(runId, actorId) {
  return tx((db) => {
    db.prepare("UPDATE supply_run SET status = 'Open', ended_on = NULL WHERE id = ?").run(runId);
    audit(actorId, 'run.reopen', 'supply_run', runId, {});
    return true;
  });
}

export const listRuns = ({ seasonId, status = null } = {}) =>
  getDb().prepare(
    `SELECT r.*, u.full_name AS officer_name,
            (SELECT COUNT(*) FROM spot_purchase sp WHERE sp.run_id = r.id) AS loads,
            (SELECT COALESCE(SUM(sp.payable_g), 0) FROM spot_purchase sp WHERE sp.run_id = r.id) AS payable_g,
            (SELECT COALESCE(SUM(sp.net_payable_cents), 0) FROM spot_purchase sp WHERE sp.run_id = r.id) AS purchase_cents,
            (SELECT COALESCE(SUM(rc.amount_cents), 0) FROM run_cost rc WHERE rc.run_id = r.id) AS overhead_cents
       FROM supply_run r
       LEFT JOIN app_user u ON u.id = r.field_officer_id
      WHERE r.season_id = @season_id AND (@status IS NULL OR r.status = @status)
      ORDER BY r.id DESC`,
  ).all({ season_id: seasonId, status });

export const getRun = (id) =>
  getDb().prepare(
    `SELECT r.*, u.full_name AS officer_name, l.name AS store_name
       FROM supply_run r
       LEFT JOIN app_user u ON u.id = r.field_officer_id
       LEFT JOIN location l ON l.id = r.location_id
      WHERE r.id = ?`,
  ).get(id);

// --- run costs -------------------------------------------------------------
export function addRunCost(data, actorId) {
  return tx((db) => {
    const info = db.prepare(
      `INSERT INTO run_cost (run_id, kind, description, amount_cents, incurred_on, created_by)
       VALUES (@run_id, @kind, @description, @amount_cents, @incurred_on, @created_by)`,
    ).run({ description: '', ...data, created_by: actorId ?? null });
    audit(actorId, 'run.cost', 'supply_run', data.run_id,
          { kind: data.kind, amountCents: data.amount_cents });
    return info.lastInsertRowid;
  });
}

export const runCosts = (runId) =>
  getDb().prepare('SELECT * FROM run_cost WHERE run_id = ? ORDER BY id').all(runId);

export const runPurchases = (runId) =>
  getDb().prepare(
    `SELECT sp.*, s.name AS supplier_name, s.code AS supplier_code, s.phone,
            q.grade, q.moisture_bp, q.oil_bp, q.foreign_bp, q.damage_bp
       FROM spot_purchase sp
       JOIN supplier s ON s.id = sp.supplier_id
       LEFT JOIN quality_test q ON q.spot_purchase_id = sp.id
      WHERE sp.run_id = ? ORDER BY sp.id`,
  ).all(runId);

/** The full picture for one run: what we bought, what it cost, what it landed at. */
export function runSummary(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const purchases = runPurchases(runId);
  const costs = runCosts(runId);
  const costing = runCosting(
    purchases.map((p) => ({
      id: p.id, code: p.code, supplier_name: p.supplier_name,
      payableG: p.payable_g, netPayableCents: p.net_payable_cents,
    })),
    costs.map((c) => ({ kind: c.kind, amountCents: c.amount_cents })),
  );
  const baseline = contractedPerTonneCents(run.season_id);
  return {
    run,
    purchases,
    costs,
    costing,
    comparison: baseline ? runVsContracted(costing, baseline) : null,
    contractedPerTonneCents: baseline,
  };
}

// --- spot purchases --------------------------------------------------------

/** Price a prospective load without writing anything, so the officer can see
 *  the number before agreeing it with the farmer standing in front of them. */
export function previewSpotPurchase({
  seasonId, netG, moistureBp, oilBp, foreignBp, damageBp, agreedPriceCents = null,
}) {
  const schedule = currentSpotSchedule(seasonId);
  if (!schedule) throw new Error('no spot price schedule for this season');
  const g = grade({ moistureBp, oilBp, foreignBp });
  if (g === 'REJECT') return { rejected: true, grade: g, schedule };
  const priced = priceSpotPurchase(
    { netG, moistureBp, oilBp, foreignBp, damageBp, agreedPriceCents }, schedule);
  return { rejected: false, grade: g, schedule, priced };
}

/**
 * Buy a load. One transaction writes the purchase, its grade, and the stock
 * movement bringing the grain into the store.
 */
export function createSpotPurchase({
  runId, supplierId, grossG, tareG, moistureBp, oilBp, foreignBp, damageBp,
  agreedPriceCents = null, priceReason = '', purchasedOn, purchasedAt,
  method = 'M-Pesa', reference = '', notes = '',
}, actorId) {
  return tx((db) => {
    const run = db.prepare('SELECT * FROM supply_run WHERE id = ?').get(runId);
    if (!run) throw new Error('supply run not found');
    if (run.status !== 'Open') throw new Error(`${run.code} is closed`);

    const netG = grossG - tareG;
    const p = previewSpotPurchase({
      seasonId: run.season_id, netG, moistureBp, oilBp, foreignBp, damageBp, agreedPriceCents,
    });

    const code = nextIn('spot_purchase', 'SPT', 5);
    if (p.rejected) {
      // A rejected load is recorded — we drove there, it matters — but nothing
      // is paid and nothing enters stock.
      const info = db.prepare(
        `INSERT INTO spot_purchase
           (code, run_id, supplier_id, season_id, spot_price_schedule_id, gross_g, tare_g,
            payable_g, reference_price_cents, agreed_price_cents, price_basis, price_reason,
            gross_value_cents, cess_cents, net_payable_cents, balance_cents, status,
            purchased_on, purchased_at, method, reference, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'schedule', '', 0, 0, 0, 0, 'Rejected',
                 ?, ?, ?, ?, ?, ?)`,
      ).run(code, runId, supplierId, run.season_id, p.schedule.id, grossG, tareG,
            purchasedOn, purchasedAt, method, reference, notes, actorId ?? null);
      db.prepare(
        `INSERT INTO quality_test (code, spot_purchase_id, moisture_bp, oil_bp, foreign_bp,
                                   damage_bp, grade, tested_on, tested_at, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'REJECT', ?, ?, '', ?)`,
      ).run(nextIn('quality_test', 'QT', 5), info.lastInsertRowid, moistureBp, oilBp,
            foreignBp, damageBp, purchasedOn, purchasedAt, actorId ?? null);
      audit(actorId, 'spot.reject', 'spot_purchase', info.lastInsertRowid, { code });
      return { id: info.lastInsertRowid, code, grade: 'REJECT', rejected: true };
    }

    const { priced } = p;
    if (priced.priceBasis === 'negotiated' && !String(priceReason).trim()) {
      throw new Error('a negotiated price must record why it differs from the schedule');
    }

    const info = db.prepare(
      `INSERT INTO spot_purchase
         (code, run_id, supplier_id, season_id, spot_price_schedule_id, gross_g, tare_g,
          payable_g, reference_price_cents, agreed_price_cents, price_basis, price_reason,
          gross_value_cents, cess_cents, net_payable_cents, amount_paid_cents,
          balance_cents, status, purchased_on, purchased_at, method, reference, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', ?, ?, ?, ?, ?, ?)`,
    ).run(code, runId, supplierId, run.season_id, p.schedule.id, grossG, tareG,
          priced.payableG, priced.referencePriceCents, priced.agreedPriceCents,
          priced.priceBasis, priceReason, priced.grossValueCents, priced.cessCents,
          priced.netPayableCents, priced.netPayableCents,
          purchasedOn, purchasedAt, method, reference, notes, actorId ?? null);

    db.prepare(
      `INSERT INTO quality_test (code, spot_purchase_id, moisture_bp, oil_bp, foreign_bp,
                                 damage_bp, grade, tested_on, tested_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    ).run(nextIn('quality_test', 'QT', 5), info.lastInsertRowid, moistureBp, oilBp,
          foreignBp, damageBp, p.grade, purchasedOn, purchasedAt, actorId ?? null);

    // Outsourced grain is still grain: it enters the same store.
    const grain = grainItem();
    db.prepare(
      `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason,
                                   ref_table, ref_id, notes, created_by)
       VALUES (?, NULL, ?, ?, 'delivery_in', 'spot_purchase', ?, ?, ?)`,
    ).run(grain.id, run.location_id, netG, info.lastInsertRowid,
          `Spot ${p.grade} intake on ${run.code}`, actorId ?? null);

    audit(actorId, 'spot.buy', 'spot_purchase', info.lastInsertRowid,
          { code, grade: p.grade, basis: priced.priceBasis });
    return { id: info.lastInsertRowid, code, grade: p.grade, rejected: false };
  });
}

export function markSpotPaid(purchaseId, { reference, paidOn }, actorId) {
  return tx((db) => {
    const sp = db.prepare('SELECT * FROM spot_purchase WHERE id = ?').get(purchaseId);
    if (!sp) throw new Error('purchase not found');
    if (sp.status !== 'Unpaid') throw new Error(`${sp.code} is ${sp.status}`);
    db.prepare(
      `UPDATE spot_purchase SET status = 'Paid', amount_paid_cents = net_payable_cents,
              balance_cents = 0, reference = ? WHERE id = ?`,
    ).run(reference || sp.reference, purchaseId);
    audit(actorId, 'spot.pay', 'spot_purchase', purchaseId, { code: sp.code, reference, paidOn });
    return true;
  });
}

export const getSpotPurchase = (id) =>
  getDb().prepare(
    `SELECT sp.*, s.name AS supplier_name, s.code AS supplier_code, s.phone, s.mm_name,
            r.code AS run_code, q.grade, q.moisture_bp, q.oil_bp, q.foreign_bp, q.damage_bp
       FROM spot_purchase sp
       JOIN supplier s ON s.id = sp.supplier_id
       JOIN supply_run r ON r.id = sp.run_id
       LEFT JOIN quality_test q ON q.spot_purchase_id = sp.id
      WHERE sp.id = ?`,
  ).get(id);

export const listSpotPurchases = ({ seasonId, status = null } = {}) =>
  getDb().prepare(
    `SELECT sp.*, s.name AS supplier_name, s.code AS supplier_code,
            r.code AS run_code, q.grade
       FROM spot_purchase sp
       JOIN supplier s ON s.id = sp.supplier_id
       JOIN supply_run r ON r.id = sp.run_id
       LEFT JOIN quality_test q ON q.spot_purchase_id = sp.id
      WHERE sp.season_id = @season_id AND (@status IS NULL OR sp.status = @status)
      ORDER BY sp.id DESC`,
  ).all({ season_id: seasonId, status });

/** Season-wide outsourcing totals, for the dashboard. */
export function outsourcingTotals(seasonId) {
  const db = getDb();
  const buys = db.prepare(
    `SELECT COUNT(*) AS loads, COALESCE(SUM(payable_g), 0) AS payable_g,
            COALESCE(SUM(net_payable_cents), 0) AS purchase_cents,
            COALESCE(SUM(CASE WHEN status = 'Unpaid' THEN balance_cents ELSE 0 END), 0) AS unpaid_cents,
            COALESCE(SUM(CASE WHEN price_basis = 'negotiated' THEN 1 ELSE 0 END), 0) AS negotiated,
            COALESCE(SUM((agreed_price_cents - reference_price_cents) * payable_g / 1000), 0) AS variance_cents
       FROM spot_purchase WHERE season_id = ? AND status <> 'Rejected'`,
  ).get(seasonId);
  const over = db.prepare(
    `SELECT COALESCE(SUM(rc.amount_cents), 0) AS overhead_cents
       FROM run_cost rc JOIN supply_run r ON r.id = rc.run_id
      WHERE r.season_id = ?`,
  ).get(seasonId);

  const landed = buys.purchase_cents + over.overhead_cents;
  return {
    ...buys,
    overheadCents: over.overhead_cents,
    landedCents: landed,
    landedPerTonneCents: buys.payable_g
      ? Math.round((landed * 1_000_000) / buys.payable_g) : 0,
    overheadPerTonneCents: buys.payable_g
      ? Math.round((over.overhead_cents * 1_000_000) / buys.payable_g) : 0,
  };
}
