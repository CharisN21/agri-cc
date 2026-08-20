// Corrections to things that are not money.
//
// The rule this file exists to express: reference data can be edited, money
// cannot. A farmer's phone number is reference data — getting it wrong is
// exactly why a payout bounces, and refusing to let anyone fix it protects
// nothing. A settlement is money: it is never edited, only reversed.
//
// Everything here writes to audit_log, which is where the history of a mutable
// row belongs.
import { getDb, tx } from './db.js';
import { audit, grainItem } from './repo.js';
import { grade } from './domain/grading.js';

const FARMER_FIELDS = ['full_name', 'national_id', 'phone', 'mm_name', 'ward_id',
                       'status', 'notes'];

/** Correct a farmer's details. Payout fields are called out in the audit. */
export function updateFarmer(farmerId, fields, { at }, actorId) {
  return tx((db) => {
    const before = db.prepare('SELECT * FROM farmer WHERE id = ?').get(farmerId);
    if (!before) throw new Error('farmer not found');

    const next = {};
    for (const f of FARMER_FIELDS) next[f] = fields[f] ?? before[f];
    if (!String(next.full_name).trim()) throw new Error('a farmer needs a name');
    if (!String(next.phone).trim()) throw new Error('a farmer needs a phone number');

    db.prepare(
      `UPDATE farmer SET full_name = @full_name, national_id = @national_id,
              phone = @phone, mm_name = @mm_name, ward_id = @ward_id,
              status = @status, notes = @notes, updated_at = @at
        WHERE id = @id`,
    ).run({ ...next, at, id: farmerId });

    const changed = FARMER_FIELDS.filter((f) => String(before[f]) !== String(next[f]));
    audit(actorId, 'farmer.update', 'farmer', farmerId, {
      code: before.code,
      changed,
      // The two fields that decide whether money reaches the right person.
      payout_fields_changed: changed.filter((f) => f === 'phone' || f === 'mm_name'),
      from: Object.fromEntries(changed.map((f) => [f, before[f]])),
      to: Object.fromEntries(changed.map((f) => [f, next[f]])),
    });
    return { changed };
  });
}

/** Correct a supplier's details. Same reasoning as farmers. */
export function updateSupplier(supplierId, fields, { at }, actorId) {
  return tx((db) => {
    const before = db.prepare('SELECT * FROM supplier WHERE id = ?').get(supplierId);
    if (!before) throw new Error('supplier not found');

    const keys = ['name', 'phone', 'area', 'ward_id', 'mm_name', 'notes'];
    const next = {};
    for (const k of keys) next[k] = fields[k] ?? before[k];
    if (!String(next.name).trim()) throw new Error('a supplier needs a name');

    db.prepare(
      `UPDATE supplier SET name = @name, phone = @phone, area = @area,
              ward_id = @ward_id, mm_name = @mm_name, notes = @notes, updated_at = @at
        WHERE id = @id`,
    ).run({ ...next, at, id: supplierId });

    const changed = keys.filter((k) => String(before[k]) !== String(next[k]));
    audit(actorId, 'supplier.update', 'supplier', supplierId, {
      code: before.code,
      changed,
      payout_fields_changed: changed.filter((k) => k === 'phone' || k === 'mm_name'),
    });
    return { changed };
  });
}

/**
 * Re-grade a delivery.
 *
 * Allowed only while the settlement is still a draft. A Pending settlement is a
 * computed opinion — nothing has moved, no ledger entry exists, no payment was
 * queued — so it is discarded and recomputed from the corrected readings. Once
 * a settlement is Approved the money is committed and the honest answer is a
 * reversal; the trigger in 004 enforces that whatever this function does.
 *
 * Grain is moved out of and back into the store rather than having its original
 * movement edited, because stock_movement is append-only and the store's
 * history should show what actually happened.
 */
export function regradeDelivery({
  deliveryId, moistureBp, oilBp, foreignBp, damageBp, testedOn, testedAt, reason,
}, actor) {
  return tx((db) => {
    const delivery = db.prepare('SELECT * FROM delivery WHERE id = ?').get(deliveryId);
    if (!delivery) throw new Error('delivery not found');
    const before = db.prepare('SELECT * FROM quality_test WHERE delivery_id = ?')
      .get(deliveryId);
    if (!before) throw new Error('this delivery has not been graded yet');
    if (!String(reason || '').trim()) {
      throw new Error('say why this load is being re-graded');
    }

    const settlement = db.prepare('SELECT * FROM settlement WHERE delivery_id = ?')
      .get(deliveryId);
    if (settlement && settlement.status !== 'Pending') {
      throw new Error(
        `${settlement.code} is ${settlement.status}: reverse the payment rather than re-grading`,
      );
    }

    const newGrade = grade({ moistureBp, oilBp, foreignBp });

    audit(actor.id, 'delivery.regrade', 'delivery', deliveryId, {
      code: delivery.code,
      reason: String(reason).trim(),
      from: { moisture_bp: before.moisture_bp, oil_bp: before.oil_bp,
              foreign_bp: before.foreign_bp, damage_bp: before.damage_bp,
              grade: before.grade },
      to: { moisture_bp: moistureBp, oil_bp: oilBp, foreign_bp: foreignBp,
            damage_bp: damageBp, grade: newGrade },
    });

    // A draft settlement computed from the wrong readings is worthless.
    if (settlement) {
      audit(actor.id, 'settlement.discard', 'settlement', settlement.id, {
        code: settlement.code,
        reason: 'delivery re-graded',
        net_payable_cents: settlement.net_payable_cents,
      });
      db.prepare('DELETE FROM settlement WHERE id = ?').run(settlement.id);
    }

    // Take the old intake back out of the store.
    const priorIntake = db.prepare(
      "SELECT * FROM stock_movement WHERE ref_table = 'delivery' AND ref_id = ?",
    ).all(deliveryId);
    for (const mv of priorIntake) {
      if (mv.qty_g > 0) {
        db.prepare(
          `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason,
                                       ref_table, ref_id, notes, created_by)
           VALUES (?, ?, ?, ?, 'adjustment', 'delivery', ?, ?, ?)`,
        ).run(mv.item_id, mv.lot_id, mv.location_id, 0 - mv.qty_g, deliveryId,
              `Re-grade of ${delivery.code}`, actor.id ?? null);
      }
    }

    db.prepare(
      `UPDATE quality_test
          SET moisture_bp = ?, oil_bp = ?, foreign_bp = ?, damage_bp = ?, grade = ?,
              tested_on = ?, tested_at = ?, created_by = ?, notes = ?
        WHERE delivery_id = ?`,
    ).run(moistureBp, oilBp, foreignBp, damageBp, newGrade, testedOn, testedAt,
          actor.id ?? null,
          `${before.notes ? `${before.notes} ` : ''}[re-graded ${testedOn}: ${String(reason).trim()}]`,
          deliveryId);

    db.prepare('UPDATE delivery SET status = ? WHERE id = ?')
      .run(newGrade === 'REJECT' ? 'Rejected' : 'Graded', deliveryId);

    // And put it back, if we are still buying it.
    if (newGrade !== 'REJECT') {
      const grain = grainItem();
      db.prepare(
        `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason,
                                     ref_table, ref_id, notes, created_by)
         VALUES (?, NULL, ?, ?, 'delivery_in', 'delivery', ?, ?, ?)`,
      ).run(grain.id, delivery.location_id, delivery.gross_g - delivery.tare_g,
            deliveryId, `Grade ${newGrade} intake after re-grade`, actor.id ?? null);
    }

    return {
      grade: newGrade,
      previousGrade: before.grade,
      discardedSettlement: settlement ? settlement.code : null,
    };
  });
}

/** Can this delivery still be re-graded, and if not, why not? */
export function regradeBlockedReason(deliveryId) {
  const s = getDb().prepare(
    'SELECT code, status FROM settlement WHERE delivery_id = ?',
  ).get(deliveryId);
  if (s && s.status !== 'Pending') {
    return `${s.code} is ${s.status} — the payment must be reversed instead`;
  }
  return null;
}
