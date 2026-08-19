import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as repo from '../repo.js';
import { toGrams, toBp } from '../domain/units.js';
import { gradeReason } from '../domain/grading.js';
import { now } from './index.js';

export default function mountDeliveries(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/', requirePermission('delivery.view'), (req, res) => {
    const season = req.season;
    res.render('deliveries', {
      title: 'Deliveries',
      deliveries: repo.listDeliveries({ seasonId: season.id, status: req.query.status || null }),
      contracts: repo.listContracts({ seasonId: season.id, status: 'Signed' }),
      status: req.query.status || '',
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  // Weigh in a load. Net weight is NOT accepted from the form — it is derived.
  r.post('/', requirePermission('delivery.create'), (req, res) => {
    try {
      const t = now();
      const contract = repo.getContract(Number(req.body.contract_id));
      if (!contract) throw new Error('choose a signed contract');
      const { id, code } = repo.createDelivery({
        farmerId: contract.farmer_id,
        contractId: contract.id,
        grossG: toGrams(req.body.gross_kg),
        tareG: toGrams(req.body.tare_kg || '0'),
        deliveredOn: t.on,
        deliveredAt: t.at,
        vehicleReg: req.body.vehicle_reg || '',
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/deliveries/${id}?ok=${encodeURIComponent(`Weighed in as ${code}`)}`);
    } catch (err) {
      res.redirect(`/deliveries?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.get('/:id', requirePermission('delivery.view'), (req, res) => {
    const delivery = repo.getDelivery(Number(req.params.id));
    if (!delivery) return res.status(404).render('error',
      { title: 'Not found', status: 404, message: 'No such delivery.' });
    const quality = repo.getQualityTest(delivery.id);
    let preview = null;
    try { preview = repo.previewSettlement(delivery.id); } catch { preview = null; }
    res.render('delivery', {
      title: delivery.code,
      delivery,
      quality,
      reason: quality ? gradeReason({
        moistureBp: quality.moisture_bp, oilBp: quality.oil_bp, foreignBp: quality.foreign_bp,
      }) : null,
      preview,
      existingSettlement: repo.listSettlements({ seasonId: delivery.season_id })
        .find((s) => s.delivery_id === delivery.id) || null,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  // Record the quality test. The grade is derived from the readings, never
  // chosen by the person entering them.
  r.post('/:id/grade', requirePermission('delivery.grade'), (req, res) => {
    try {
      const t = now();
      const { grade } = repo.gradeDelivery({
        deliveryId: Number(req.params.id),
        moistureBp: toBp(req.body.moisture),
        oilBp: toBp(req.body.oil),
        foreignBp: toBp(req.body.foreign),
        damageBp: toBp(req.body.damage),
        testedOn: t.on,
        testedAt: t.at,
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/deliveries/${req.params.id}?ok=${encodeURIComponent(`Graded ${grade}`)}`);
    } catch (err) {
      res.redirect(`/deliveries/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/:id/settle', requirePermission('settlement.compute'), (req, res) => {
    try {
      const t = now();
      const { id, code } = repo.createSettlement(Number(req.params.id),
        { computedOn: t.on, computedAt: t.at }, req.user.id);
      res.redirect(`/settlements/${id}?ok=${encodeURIComponent(`Created ${code}`)}`);
    } catch (err) {
      res.redirect(`/deliveries/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/deliveries', r);
}
