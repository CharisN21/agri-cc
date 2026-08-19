// Outsourcing: buying from farmers we never contracted.
//
// The shape of the screens follows the shape of the trip. You open a run, you
// buy loads onto it, you record what the trip cost, and when you close it the
// app tells you what that grain really landed at — and whether it beat buying
// from your contracted farmers.
import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as out from '../repo-outsourcing.js';
import { wards } from '../repo.js';
import { toGrams, toBp, toCents } from '../domain/units.js';
import { RUN_COST_KINDS } from '../domain/outsourcing.js';
import { now } from './index.js';

export default function mountOutsourcing(app) {
  const r = express.Router();
  r.use(requireLogin);

  // --- runs ---------------------------------------------------------------
  r.get('/', requirePermission('spot.view'), (req, res) => {
    res.render('runs', {
      title: 'Outsourcing',
      runs: out.listRuns({ seasonId: req.season.id, status: req.query.status || null }),
      totals: out.outsourcingTotals(req.season.id),
      spotSchedule: out.currentSpotSchedule(req.season.id),
      status: req.query.status || '',
      today: now().on,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.post('/runs', requirePermission('spot.buy'), (req, res) => {
    try {
      if (!out.currentSpotSchedule(req.season.id)) {
        throw new Error('set a spot price schedule for this season first');
      }
      const { id, code } = out.createRun({
        season_id: req.season.id,
        area: String(req.body.area || '').trim(),
        vehicle_reg: String(req.body.vehicle_reg || '').trim(),
        started_on: req.body.started_on || now().on,
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/outsourcing/runs/${id}?ok=${encodeURIComponent(`Opened ${code}`)}`);
    } catch (err) {
      res.redirect(`/outsourcing?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.get('/runs/:id', requirePermission('spot.view'), (req, res) => {
    const summary = out.runSummary(Number(req.params.id));
    if (!summary) {
      return res.status(404).render('error',
        { title: 'Not found', status: 404, message: 'No such supply run.' });
    }
    // "Price it first" round-trips through the query string so the officer can
    // see the number before agreeing it — and can re-read the same URL later.
    const q = {
      gross_kg: req.query.gross_kg || '', tare_kg: req.query.tare_kg || '',
      moisture: req.query.moisture || '', oil: req.query.oil || '',
      foreign: req.query.foreign || '', damage: req.query.damage || '',
      supplier_id: req.query.supplier_id || '', agreed: req.query.agreed || '',
    };
    let quote = null;
    if (q.gross_kg && q.moisture && q.oil && q.foreign && q.damage) {
      try {
        quote = out.previewSpotPurchase({
          seasonId: summary.run.season_id,
          netG: toGrams(q.gross_kg) - toGrams(q.tare_kg || '0'),
          moistureBp: toBp(q.moisture), oilBp: toBp(q.oil),
          foreignBp: toBp(q.foreign), damageBp: toBp(q.damage),
          agreedPriceCents: q.agreed ? toCents(q.agreed) : null,
        });
      } catch { quote = null; }
    }

    res.render('run', {
      title: summary.run.code,
      ...summary,
      suppliers: out.listSuppliers(),
      costKinds: RUN_COST_KINDS,
      spotSchedule: out.currentSpotSchedule(summary.run.season_id),
      q,
      quote,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.post('/runs/:id/close', requirePermission('spot.buy'), (req, res) => {
    try {
      out.closeRun(Number(req.params.id), { endedOn: now().on }, req.user.id);
      res.redirect(`/outsourcing/runs/${req.params.id}?ok=Run+closed`);
    } catch (err) {
      res.redirect(`/outsourcing/runs/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/runs/:id/reopen', requirePermission('spot.approve'), (req, res) => {
    out.reopenRun(Number(req.params.id), req.user.id);
    res.redirect(`/outsourcing/runs/${req.params.id}?ok=Run+reopened`);
  });

  // --- costs of the trip --------------------------------------------------
  r.post('/runs/:id/costs', requirePermission('spot.buy'), (req, res) => {
    try {
      out.addRunCost({
        run_id: Number(req.params.id),
        kind: req.body.kind,
        description: req.body.description || '',
        amount_cents: toCents(req.body.amount),
        incurred_on: req.body.incurred_on || now().on,
      }, req.user.id);
      res.redirect(`/outsourcing/runs/${req.params.id}?ok=Cost+recorded`);
    } catch (err) {
      res.redirect(`/outsourcing/runs/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  // --- buying a load ------------------------------------------------------
  // The officer can price a load before agreeing it, which is the whole point:
  // you want to know what the grade says before you shake hands.
  r.post('/runs/:id/quote', requirePermission('spot.buy'), (req, res) => {
    const runId = Number(req.params.id);
    try {
      const grossG = toGrams(req.body.gross_kg);
      const tareG = toGrams(req.body.tare_kg || '0');
      const q = new URLSearchParams({
        gross_kg: req.body.gross_kg, tare_kg: req.body.tare_kg || '0',
        moisture: req.body.moisture, oil: req.body.oil,
        foreign: req.body.foreign, damage: req.body.damage,
        supplier_id: req.body.supplier_id || '',
        agreed: req.body.agreed || '',
      });
      if (tareG >= grossG) throw new Error('tare must be less than gross');
      res.redirect(`/outsourcing/runs/${runId}?${q.toString()}#quote`);
    } catch (err) {
      res.redirect(`/outsourcing/runs/${runId}?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/runs/:id/buy', requirePermission('spot.buy'), (req, res) => {
    const runId = Number(req.params.id);
    try {
      const t = now();
      const agreed = String(req.body.agreed || '').trim();
      const { code, grade, rejected } = out.createSpotPurchase({
        runId,
        supplierId: Number(req.body.supplier_id),
        grossG: toGrams(req.body.gross_kg),
        tareG: toGrams(req.body.tare_kg || '0'),
        moistureBp: toBp(req.body.moisture),
        oilBp: toBp(req.body.oil),
        foreignBp: toBp(req.body.foreign),
        damageBp: toBp(req.body.damage),
        agreedPriceCents: agreed === '' ? null : toCents(agreed),
        priceReason: req.body.price_reason || '',
        purchasedOn: t.on,
        purchasedAt: t.at,
        method: req.body.method || 'M-Pesa',
        reference: req.body.reference || '',
        notes: req.body.notes || '',
      }, req.user.id);
      const msg = rejected
        ? `${code} recorded as REJECT — nothing paid, nothing taken into stock`
        : `Bought ${code} at grade ${grade}`;
      res.redirect(`/outsourcing/runs/${runId}?ok=${encodeURIComponent(msg)}`);
    } catch (err) {
      res.redirect(`/outsourcing/runs/${runId}?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/purchases/:id/pay', requirePermission('spot.pay'), (req, res) => {
    try {
      out.markSpotPaid(Number(req.params.id), {
        reference: String(req.body.reference || '').trim(),
        paidOn: now().on,
      }, req.user.id);
      res.redirect(`${req.body.back || '/outsourcing'}?ok=Marked+paid`);
    } catch (err) {
      res.redirect(`${req.body.back || '/outsourcing'}?err=${encodeURIComponent(err.message)}`);
    }
  });

  // --- suppliers ----------------------------------------------------------
  r.get('/suppliers', requirePermission('spot.view'), (req, res) => {
    res.render('suppliers', {
      title: 'Suppliers',
      suppliers: out.listSuppliers({ q: req.query.q || '' }),
      wards: wards(),
      q: req.query.q || '',
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.post('/suppliers', requirePermission('spot.buy'), (req, res) => {
    try {
      const { code } = out.createSupplier({
        name: String(req.body.name || '').trim(),
        phone: String(req.body.phone || '').trim(),
        area: String(req.body.area || '').trim(),
        ward_id: req.body.ward_id ? Number(req.body.ward_id) : null,
        mm_name: String(req.body.mm_name || req.body.name || '').trim(),
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/outsourcing/suppliers?ok=${encodeURIComponent(`Added ${code}`)}`);
    } catch (err) {
      res.redirect(`/outsourcing/suppliers?err=${encodeURIComponent(err.message)}`);
    }
  });

  // --- spot price schedule ------------------------------------------------
  r.post('/spot-price', requirePermission('spot.approve'), (req, res) => {
    try {
      out.addSpotScheduleVersion(req.season.id, {
        effective_from: req.body.effective_from || now().on,
        base_price_cents: toCents(req.body.base_price),
        oil_premium_cents: toCents(req.body.oil_premium),
        moisture_discount_cents: toCents(req.body.moisture_discount),
        damage_discount_cents: toCents(req.body.damage_discount),
        cess_bp: Number(req.body.cess_bp || 50),
      }, req.user.id);
      res.redirect('/outsourcing?ok=New+spot+price+version+saved');
    } catch (err) {
      res.redirect(`/outsourcing?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/outsourcing', r);
}
