import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as repo from '../repo.js';
import { toGrams, toBp } from '../domain/units.js';
import { now } from './index.js';

export default function mountFarmers(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/', requirePermission('farmer.view'), (req, res) => {
    const wardId = req.query.ward ? Number(req.query.ward) : null;
    res.render('farmers', {
      title: 'Farmers',
      farmers: repo.listFarmers({ q: req.query.q || '', wardId }),
      wards: repo.wards(),
      q: req.query.q || '',
      wardId,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.get('/new', requirePermission('farmer.edit'), (req, res) => {
    res.render('farmer_new', { title: 'Register a farmer', wards: repo.wards(), flash: null });
  });

  r.post('/', requirePermission('farmer.edit'), (req, res) => {
    const t = now();
    try {
      const { code, id } = repo.createFarmer({
        full_name: String(req.body.full_name || '').trim(),
        national_id: String(req.body.national_id || '').trim(),
        phone: String(req.body.phone || '').trim(),
        mm_name: String(req.body.mm_name || req.body.full_name || '').trim(),
        ward_id: Number(req.body.ward_id),
        notes: req.body.notes || '',
        registered_on: t.on,
        registered_at: t.at,
      }, req.user.id);

      // A farmer with no parcel cannot be contracted, so capture it here.
      if (req.body.acreage) {
        repo.createParcel({
          farmer_id: id,
          acreage_bp: toBp(req.body.acreage),
          notes: req.body.parcel_notes || '',
        }, req.user.id);
      }
      res.redirect(`/farmers/${id}?ok=${encodeURIComponent(`Registered ${code}`)}`);
    } catch (err) {
      res.status(400).render('farmer_new', {
        title: 'Register a farmer', wards: repo.wards(), flash: err.message,
      });
    }
  });

  r.get('/:id', requirePermission('farmer.view'), (req, res) => {
    const farmer = repo.getFarmer(Number(req.params.id));
    if (!farmer) return res.status(404).render('error',
      { title: 'Not found', status: 404, message: 'No such farmer.' });
    const season = req.season;
    res.render('farmer', {
      title: farmer.full_name,
      farmer,
      parcels: repo.farmerParcels(farmer.id),
      balanceCents: repo.farmerBalance(farmer.id, season.id),
      contracts: repo.listContracts({ seasonId: season.id })
        .filter((c) => c.farmer_id === farmer.id),
      deliveries: repo.listDeliveries({ seasonId: season.id })
        .filter((d) => d.farmer_id === farmer.id),
      settlements: repo.listSettlements({ seasonId: season.id })
        .filter((s) => s.farmer_id === farmer.id),
      ok: req.query.ok || null,
    });
  });

  r.post('/:id/parcels', requirePermission('farmer.edit'), (req, res) => {
    try {
      repo.createParcel({
        farmer_id: Number(req.params.id),
        acreage_bp: toBp(req.body.acreage),
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/farmers/${req.params.id}?ok=Parcel+added`);
    } catch (err) {
      res.redirect(`/farmers/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/farmers', r);
  // toGrams is imported for symmetry with the other routers; kept explicit so
  // the unit boundary is visible in every file that crosses it.
  void toGrams;
}
