// Seasons, tonnage targets, and the seed cost calculator.
import express from 'express';
import { requireLogin, requirePermission, can } from '../auth.js';
import * as admin from '../repo-admin.js';
import { wards, currentPriceSchedule } from '../repo.js';
import { toGrams, toCents, toBp } from '../domain/units.js';
import { seedCost, breakEvenGrams } from '../domain/seedcost.js';
import { now } from './index.js';

export default function mountAdmin(app) {
  // --- season switching ---------------------------------------------------
  // A GET so it can be a plain link from the season picker. attachContext
  // reads ?season= and remembers it in a cookie.
  app.get('/season/:id', requireLogin, (req, res) => {
    const back = req.query.back || '/';
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(`${back}${sep}season=${Number(req.params.id)}`);
  });

  // --- targets ------------------------------------------------------------
  const t = express.Router();
  t.use(requireLogin);

  t.get('/', requirePermission('target.view'), (req, res) => {
    res.render('targets', {
      title: 'Targets',
      seasons: admin.listSeasons(),
      progress: admin.targetProgress(req.season.id),
      canEdit: can(req.user, 'target.edit'),
      today: now().on,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  t.post('/season', requirePermission('target.edit'), (req, res) => {
    try {
      admin.setSeasonTarget(req.season.id, toGrams(req.body.target_kg), req.user.id);
      res.redirect('/targets?ok=Season+target+updated');
    } catch (err) {
      res.redirect(`/targets?err=${encodeURIComponent(err.message)}`);
    }
  });

  t.post('/ward', requirePermission('target.edit'), (req, res) => {
    try {
      // One form posts every ward at once, so the owner sets the whole
      // breakdown in a single action rather than ward by ward.
      for (const w of wards()) {
        const raw = req.body[`target_${w.id}`];
        if (raw === undefined || String(raw).trim() === '') continue;
        admin.setWardTarget(req.season.id, w.id, toGrams(raw), req.user.id);
      }
      res.redirect('/targets?ok=Ward+targets+updated');
    } catch (err) {
      res.redirect(`/targets?err=${encodeURIComponent(err.message)}`);
    }
  });

  t.post('/seasons', requirePermission('target.edit'), (req, res) => {
    try {
      admin.createSeason({
        code: String(req.body.code || '').trim(),
        name: String(req.body.name || '').trim(),
        starts_on: req.body.starts_on,
        ends_on: req.body.ends_on,
        target_g: toGrams(req.body.target_kg || '0'),
      }, req.user.id);
      res.redirect('/targets?ok=Season+created');
    } catch (err) {
      res.redirect(`/targets?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/targets', t);

  // --- seed cost calculator ----------------------------------------------
  // Deliberately a GET with everything in the query string: a field officer can
  // bookmark or send a worked example, and nothing is written to the database.
  app.get('/calculator', requireLogin, requirePermission('calculator.use'), (req, res) => {
    const rates = admin.seedingRates();
    const lots = admin.issuableLots(now().on);
    const fallbackRate = admin.defaultSeedingRate();
    const schedule = currentPriceSchedule(req.season.id);

    let result = null;
    let error = null;
    const input = {
      acreage: req.query.acreage || '',
      rate_id: req.query.rate_id || String(fallbackRate?.id ?? ''),
      lot_id: req.query.lot_id || String(lots[0]?.id ?? ''),
      price: req.query.price || (schedule ? (schedule.base_price_cents / 100).toFixed(2) : ''),
    };

    if (input.acreage) {
      try {
        const rate = rates.find((x) => String(x.id) === String(input.rate_id)) || fallbackRate;
        const lot = lots.find((x) => String(x.id) === String(input.lot_id)) || lots[0];
        if (!rate) throw new Error('no seeding rate is configured');
        if (!lot) throw new Error('no issuable seed lot — every lot is overdue for retest');
        const calc = seedCost({
          acreageBp: toBp(input.acreage),
          gPerAcre: rate.g_per_acre,
          unitCostCents: lot.unit_cost_cents,
        });
        const expectedPriceCents = input.price ? toCents(input.price) : 0;
        result = {
          ...calc,
          rate,
          lot,
          expectedPriceCents,
          breakEvenG: breakEvenGrams({ valueCents: calc.valueCents, expectedPriceCents }),
          enoughStock: lot.on_hand_g >= calc.qtyG,
        };
      } catch (err) {
        error = err.message;
      }
    }

    res.render('calculator', {
      title: 'Seed cost calculator',
      rates, lots, input, result, error, schedule,
    });
  });
}
