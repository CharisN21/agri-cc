import express from 'express';
import { config } from '../config.js';
import {
  findUserByUsername, verifyPassword, makeSessionCookie,
  requireLogin, requirePermission, can,
} from '../auth.js';
import * as repo from '../repo.js';
import { dashboard, widgetSummary } from '../dashboard.js';
import { drainOutbox } from '../payments/worker.js';
import mountFarmers from './farmers.js';
import mountContracts from './contracts.js';
import mountDeliveries from './deliveries.js';
import mountSettlements from './settlements.js';
import mountExports from './exports.js';

/** The app's idea of "now", in the two shapes the schema stores. */
export function now() {
  const d = new Date();
  return { on: d.toISOString().slice(0, 10), at: d.toISOString(), iso: d.toISOString() };
}

export default function mountRoutes(app) {
  // --- session ------------------------------------------------------------
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { title: 'Sign in', error: null, next: req.query.next || '/' });
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = findUserByUsername(String(username || '').trim());
    if (!user || !verifyPassword(String(password || ''), user.password_hash, user.password_salt)) {
      return res.status(401).render('login', {
        title: 'Sign in', error: 'That username and password do not match.',
        next: req.body.next || '/',
      });
    }
    res.setHeader('Set-Cookie',
      `sid=${makeSessionCookie(user.id)}; HttpOnly; SameSite=Lax; Path=/`);
    res.redirect(req.body.next || '/');
  });

  app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.redirect('/login');
  });

  // --- home ---------------------------------------------------------------
  app.get('/', requireLogin, (req, res) => {
    res.redirect(can(req.user, 'dashboard.view') ? '/dashboard' : '/deliveries');
  });

  // --- dashboard ----------------------------------------------------------
  app.get('/dashboard', requireLogin, requirePermission('dashboard.view'), (req, res) => {
    const season = repo.currentSeason();
    res.render('dashboard', {
      title: 'Owner dashboard',
      d: dashboard(season.id, { asOf: now().on }),
    });
  });

  // --- host-app widget ----------------------------------------------------
  // Deliberately tiny and query-cheap: a host dashboard embedding this must
  // never hang because our page is slow.
  app.get('/api/widget', (req, res) => {
    try {
      const season = repo.currentSeason();
      if (!season) return res.status(503).json({ error: 'no open season' });
      res.set('Cache-Control', 'public, max-age=30');
      res.json(widgetSummary(season.id, { asOf: now().on }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- payment worker, run by hand from the settlements screen ------------
  app.post('/payments/run', requireLogin, requirePermission('payment.run'),
    async (req, res, next) => {
      try {
        const r = await drainOutbox();
        res.redirect(`/settlements?ran=${r.paid}&dup=${r.duplicate}&failed=${r.failed}`);
      } catch (err) { next(err); }
    });

  // --- seed lots and issue ------------------------------------------------
  const issues = express.Router();
  issues.use(requireLogin);

  issues.get('/', requirePermission('delivery.view'), (req, res) => {
    const season = repo.currentSeason();
    res.render('issues', {
      title: 'Input issue',
      lots: repo.listLots(now().on),
      issues: repo.listIssues(season.id),
      contracts: repo.listContracts({ seasonId: season.id, status: 'Signed' }),
      today: now().on,
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  issues.post('/', requirePermission('issue.create'), (req, res, next) => {
    try {
      const t = now();
      const { code } = repo.issueInputs({
        contractId: Number(req.body.contract_id),
        lotId: Number(req.body.lot_id),
        qtyG: Math.round(Number(req.body.qty_kg) * 1000),
        issuedOn: t.on,
        issuedAt: t.at,
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/issues?ok=${encodeURIComponent(`Issued ${code}`)}`);
    } catch (err) {
      res.redirect(`/issues?err=${encodeURIComponent(err.message)}`);
      next; // handled
    }
  });

  app.use('/issues', issues);

  mountFarmers(app);
  mountContracts(app);
  mountDeliveries(app);
  mountSettlements(app);
  mountExports(app);

  // --- cloud mirror status ------------------------------------------------
  app.get('/cloud', requireLogin, requirePermission('dashboard.view'), async (req, res) => {
    const { syncStatus } = await import('../cloud/sync.js');
    res.render('cloud', {
      title: 'Cloud mirror',
      enabled: config.supabase.enabled,
      url: config.supabase.url,
      state: syncStatus(),
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  app.post('/cloud/push', requireLogin, requirePermission('dashboard.view'),
    async (req, res, next) => {
      try {
        const { pushAll } = await import('../cloud/sync.js');
        const r = await pushAll();
        res.redirect(`/cloud?ok=${encodeURIComponent(`Pushed ${r.pushed} row(s)`)}`);
      } catch (err) {
        res.redirect(`/cloud?err=${encodeURIComponent(err.message)}`);
        next;
      }
    });
}
