import express from 'express';
import { requireLogin, requirePermission, can } from '../auth.js';
import * as repo from '../repo.js';
import { now } from './index.js';

export default function mountSettlements(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/', requirePermission('settlement.view'), (req, res) => {
    const season = req.season;
    res.render('settlements', {
      title: 'Settlements',
      settlements: repo.listSettlements({ seasonId: season.id, status: req.query.status || null }),
      status: req.query.status || '',
      canApprove: can(req.user, 'settlement.approve'),
      canPay: can(req.user, 'payment.run'),
      ran: req.query.ran || null,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.get('/:id', requirePermission('settlement.view'), (req, res) => {
    const settlement = repo.getSettlement(Number(req.params.id));
    if (!settlement) return res.status(404).render('error',
      { title: 'Not found', status: 404, message: 'No such settlement.' });
    const quality = repo.getQualityTest(settlement.delivery_id);
    res.render('settlement', {
      title: settlement.code,
      settlement,
      quality,
      // The version this settlement actually used — not today's price.
      schedule: repo.priceScheduleById(settlement.price_schedule_id),
      payments: repo.settlementPayments(settlement.id),
      canApprove: can(req.user, 'settlement.approve'),
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  // Approving is where the money is released, so it is the narrowest gate in
  // the app: role check here, individual check in the repo, trigger in the DB.
  r.post('/:id/approve', requirePermission('settlement.approve'), (req, res) => {
    try {
      repo.approveSettlement(Number(req.params.id), { approvedAt: now().at }, req.user);
      res.redirect(`/settlements/${req.params.id}?ok=Approved+and+queued+for+payment`);
    } catch (err) {
      res.redirect(`/settlements/${req.params.id}?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/settlements', r);
}
