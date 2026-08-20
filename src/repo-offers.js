// Offers, run budgets, and requests for supplementary cost or declared savings.
//
// The trip cost is fixed, so the interesting question on an open run is not
// "what does this farm want per kilo" but "what would the grain actually land
// at if I bought from them". That comparison lives in domain/offers.js; this
// file gets the rows it needs and writes the decisions back.
import { getDb, tx } from './db.js';
import { audit } from './repo.js';
import { rankOffers, targetProgress, budgetPosition } from './domain/offers.js';

const nextIn = (table, prefix, width) => {
  const row = getDb().prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(code, INSTR(code, '-') + 1) AS INTEGER)), 0) AS n FROM ${table}`,
  ).get();
  return `${prefix}-${String(row.n + 1).padStart(width, '0')}`;
};

function assertOpen(db, runId) {
  const run = db.prepare('SELECT * FROM supply_run WHERE id = ?').get(runId);
  if (!run) throw new Error('supply run not found');
  if (run.status !== 'Open') throw new Error(`${run.code} is closed`);
  return run;
}

// --- offers ----------------------------------------------------------------
export function addOffer(data, actorId) {
  return tx((db) => {
    assertOpen(db, data.run_id);
    if (!data.offered_g || data.offered_g <= 0) throw new Error('how much are they offering?');
    const code = nextIn('run_offer', 'OFR', 5);
    const info = db.prepare(
      `INSERT INTO run_offer (code, run_id, supplier_id, offered_g, asking_price_cents,
                              est_moisture_bp, est_oil_bp, notes, offered_on, created_by)
       VALUES (@code, @run_id, @supplier_id, @offered_g, @asking_price_cents,
               @est_moisture_bp, @est_oil_bp, @notes, @offered_on, @created_by)`,
    ).run({
      code, est_moisture_bp: null, est_oil_bp: null, notes: '',
      ...data, created_by: actorId ?? null,
    });
    audit(actorId, 'offer.add', 'run_offer', info.lastInsertRowid,
          { code, offered_g: data.offered_g, asking_price_cents: data.asking_price_cents });
    return { id: info.lastInsertRowid, code };
  });
}

export function decideOffer(offerId, { status, reason = '' }, actorId) {
  return tx((db) => {
    const offer = db.prepare('SELECT * FROM run_offer WHERE id = ?').get(offerId);
    if (!offer) throw new Error('offer not found');
    assertOpen(db, offer.run_id);
    if (status === 'Declined' && !String(reason).trim()) {
      throw new Error('say why this offer was declined');
    }
    db.prepare('UPDATE run_offer SET status = ?, decline_reason = ? WHERE id = ?')
      .run(status, status === 'Declined' ? String(reason).trim() : '', offerId);
    audit(actorId, `offer.${status.toLowerCase()}`, 'run_offer', offerId,
          { code: offer.code, reason });
    return offer.run_id;
  });
}

export function updateOffer(offerId, fields, actorId) {
  return tx((db) => {
    const offer = db.prepare('SELECT * FROM run_offer WHERE id = ?').get(offerId);
    if (!offer) throw new Error('offer not found');
    assertOpen(db, offer.run_id);
    db.prepare(
      `UPDATE run_offer SET offered_g = @offered_g, asking_price_cents = @asking_price_cents,
              notes = @notes WHERE id = @id`,
    ).run({
      id: offerId,
      offered_g: fields.offered_g ?? offer.offered_g,
      asking_price_cents: fields.asking_price_cents ?? offer.asking_price_cents,
      notes: fields.notes ?? offer.notes,
    });
    audit(actorId, 'offer.update', 'run_offer', offerId, { code: offer.code });
    return offer.run_id;
  });
}

export const runOffers = (runId) =>
  getDb().prepare(
    `SELECT o.*, s.name AS supplier_name, s.code AS supplier_code, s.phone, s.area
       FROM run_offer o JOIN supplier s ON s.id = o.supplier_id
      WHERE o.run_id = ? ORDER BY o.asking_price_cents, o.id`,
  ).all(runId);

// --- budget and cost requests ----------------------------------------------
export function requestCostChange(data, actorId) {
  return tx((db) => {
    const run = db.prepare('SELECT * FROM supply_run WHERE id = ?').get(data.run_id);
    if (!run) throw new Error('supply run not found');
    if (!String(data.reason || '').trim()) throw new Error('a cost request must say why');
    if (!data.amount_cents || data.amount_cents <= 0) throw new Error('how much?');
    const code = nextIn('run_cost_request', 'REQ', 5);
    const info = db.prepare(
      `INSERT INTO run_cost_request (code, run_id, direction, kind, amount_cents,
                                     reason, requested_by, requested_on)
       VALUES (@code, @run_id, @direction, @kind, @amount_cents, @reason,
               @requested_by, @requested_on)`,
    ).run({ code, ...data, reason: String(data.reason).trim(), requested_by: actorId ?? null });
    audit(actorId, `run_cost_request.${data.direction}`, 'run_cost_request',
          info.lastInsertRowid, { code, amount_cents: data.amount_cents });
    return { id: info.lastInsertRowid, code };
  });
}

/**
 * The owner decides. Approving a supplementary writes the money onto the run as
 * a real cost, so the landed figure moves the moment it is granted — there is
 * no second step to forget.
 */
export function decideCostRequest(requestId, { status, note = '', decidedAt, fromSavings = false },
                                  actor) {
  return tx((db) => {
    const req = db.prepare('SELECT * FROM run_cost_request WHERE id = ?').get(requestId);
    if (!req) throw new Error('request not found');
    if (req.status !== 'Requested') throw new Error(`${req.code} has already been decided`);
    if (req.requested_by === actor.id) throw new Error('you cannot approve your own cost request');

    db.prepare(
      `UPDATE run_cost_request
          SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, from_savings = ?
        WHERE id = ?`,
    ).run(status, actor.id, decidedAt, note, fromSavings ? 1 : 0, requestId);

    // An approved supplementary is money actually spent on this trip.
    if (status === 'Approved' && req.direction === 'supplementary') {
      db.prepare(
        `INSERT INTO run_cost (run_id, kind, description, amount_cents, incurred_on,
                               is_projected, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).run(req.run_id, req.kind, `Supplementary ${req.code}: ${req.reason}`,
            req.amount_cents, decidedAt.slice(0, 10), actor.id);
    }

    audit(actor.id, `run_cost_request.${status.toLowerCase()}`, 'run_cost_request', requestId,
          { code: req.code, direction: req.direction, amount_cents: req.amount_cents });
    return req.run_id;
  });
}

export const runCostRequests = (runId) =>
  getDb().prepare(
    `SELECT r.*, u.full_name AS requested_by_name, d.full_name AS decided_by_name
       FROM run_cost_request r
       LEFT JOIN app_user u ON u.id = r.requested_by
       LEFT JOIN app_user d ON d.id = r.decided_by
      WHERE r.run_id = ? ORDER BY r.id DESC`,
  ).all(runId);

export const pendingCostRequests = (seasonId) =>
  getDb().prepare(
    `SELECT r.*, sr.code AS run_code, sr.area, u.full_name AS requested_by_name
       FROM run_cost_request r
       JOIN supply_run sr ON sr.id = r.run_id
       LEFT JOIN app_user u ON u.id = r.requested_by
      WHERE sr.season_id = ? AND r.status = 'Requested'
      ORDER BY r.id`,
  ).all(seasonId);

/**
 * The savings pot: money declared unspent on earlier trips and approved by the
 * owner, less anything a later supplementary has already drawn from it.
 */
export function savingsPool(seasonId) {
  const row = getDb().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN r.direction = 'saving' THEN r.amount_cents END), 0) AS declared,
       COALESCE(SUM(CASE WHEN r.direction = 'supplementary' AND r.from_savings = 1
                         THEN r.amount_cents END), 0) AS drawn
       FROM run_cost_request r
       JOIN supply_run sr ON sr.id = r.run_id
      WHERE sr.season_id = ? AND r.status = 'Approved'`,
  ).get(seasonId);
  return {
    declaredCents: row.declared,
    drawnCents: row.drawn,
    availableCents: row.declared - row.drawn,
  };
}

// --- the whole picture for one run -----------------------------------------
export function runPlanning(run, boughtG, actualCostCents, boughtCents = 0) {
  const db = getDb();
  const offers = runOffers(run.id);
  const openOffers = offers.filter((o) => o.status === 'Open');

  const projected = db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS c FROM run_cost WHERE run_id = ? AND is_projected = 1',
  ).get(run.id).c;
  const approvedSupp = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM run_cost_request
      WHERE run_id = ? AND direction = 'supplementary' AND status = 'Approved'`,
  ).get(run.id).c;

  // The firm cost the comparison should use: what we expect this trip to cost,
  // which is the budget once it exists and the actual spend otherwise.
  const firmCostCents = Math.max(projected + approvedSupp, actualCostCents);

  return {
    offers,
    ranking: rankOffers(
      openOffers.map((o) => ({
        id: o.id, code: o.code, supplier_name: o.supplier_name,
        supplier_code: o.supplier_code, status: o.status, notes: o.notes,
        offeredG: o.offered_g, askingPriceCents: o.asking_price_cents,
      })),
      firmCostCents,
      { boughtG, boughtCents },
    ),
    target: targetProgress({
      targetG: run.target_g,
      boughtG,
      offeredG: openOffers.reduce((s, o) => s + o.offered_g, 0),
    }),
    budget: budgetPosition({
      projectedCents: projected,
      actualCents: actualCostCents,
      approvedSupplementaryCents: approvedSupp,
    }),
    requests: runCostRequests(run.id),
  };
}

export function setRunTarget(runId, targetG, actorId) {
  return tx((db) => {
    assertOpen(db, runId);
    db.prepare('UPDATE supply_run SET target_g = ? WHERE id = ?').run(targetG, runId);
    audit(actorId, 'run.target', 'supply_run', runId, { target_g: targetG });
    return true;
  });
}
