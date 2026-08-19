import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as repo from '../repo.js';
import { toGrams } from '../domain/units.js';
import { now } from './index.js';

export default function mountContracts(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/', requirePermission('contract.view'), (req, res) => {
    const season = repo.currentSeason();
    res.render('contracts', {
      title: 'Contracts',
      contracts: repo.listContracts({ seasonId: season.id, status: req.query.status || null }),
      status: req.query.status || '',
      farmers: repo.listFarmers({ limit: 500 }),
      season,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.post('/', requirePermission('contract.edit'), (req, res) => {
    try {
      const season = repo.currentSeason();
      const farmerId = Number(req.body.farmer_id);
      const parcels = repo.farmerParcels(farmerId);
      if (parcels.length === 0) throw new Error('that farmer has no parcel on file yet');
      const expectedG = toGrams(req.body.expected_kg);
      const { code } = repo.offerContract({
        farmer_id: farmerId,
        parcel_id: Number(req.body.parcel_id || parcels[0].id),
        season_id: season.id,
        expected_g: expectedG,
        seed_entitlement_g: toGrams(req.body.seed_kg || '0'),
        recovery_share_bp: Number(req.body.recovery_share_bp || 5000),
        offered_on: now().on,
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/contracts?ok=${encodeURIComponent(`Offered ${code}`)}`);
    } catch (err) {
      res.redirect(`/contracts?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/:id/sign', requirePermission('contract.edit'), (req, res) => {
    try {
      const t = now();
      repo.signContract(Number(req.params.id), { signedOn: t.on, signedAt: t.at }, req.user.id);
      res.redirect('/contracts?ok=Contract+signed');
    } catch (err) {
      res.redirect(`/contracts?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/contracts', r);
}
