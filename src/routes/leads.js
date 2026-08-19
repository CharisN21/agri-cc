// Ground referral leads: contractors and farmers worth calling.
//
// A working list, not a financial record — so unlike everything else in this
// app these rows are freely editable. What matters is that a call is never
// lost: every contact appends a dated line to the notes rather than
// overwriting what was there.
import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as admin from '../repo-admin.js';
import { createSupplier } from '../repo-outsourcing.js';
import { wards } from '../repo.js';
import { toGrams } from '../domain/units.js';
import { now } from './index.js';

export default function mountLeads(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/', requirePermission('lead.view'), (req, res) => {
    const today = now().on;
    res.render('leads', {
      title: 'Referrals',
      leads: admin.listLeads({
        status: req.query.status || null,
        q: req.query.q || '',
        dueOnly: req.query.due === '1',
        today,
      }),
      stats: admin.leadStats(today),
      wards: wards(),
      today,
      status: req.query.status || '',
      q: req.query.q || '',
      due: req.query.due === '1',
      flash: req.query.err || null,
      ok: req.query.ok || null,
    });
  });

  r.post('/', requirePermission('lead.edit'), (req, res) => {
    try {
      const { code } = admin.createLead({
        name: String(req.body.name || '').trim(),
        phone: String(req.body.phone || '').trim(),
        area: String(req.body.area || '').trim(),
        ward_id: req.body.ward_id ? Number(req.body.ward_id) : null,
        can_supply_g: req.body.can_supply_kg ? toGrams(req.body.can_supply_kg) : 0,
        source: String(req.body.source || '').trim(),
        follow_up_on: req.body.follow_up_on || null,
        notes: req.body.notes || '',
      }, req.user.id);
      res.redirect(`/leads?ok=${encodeURIComponent(`Added ${code}`)}`);
    } catch (err) {
      res.redirect(`/leads?err=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/:id/contact', requirePermission('lead.edit'), (req, res) => {
    try {
      admin.logLeadContact(Number(req.params.id), {
        status: req.body.status,
        notes: req.body.notes || '',
        followUpOn: req.body.follow_up_on || null,
        contactedOn: now().on,
      }, req.user.id);
      res.redirect('/leads?ok=Call+logged');
    } catch (err) {
      res.redirect(`/leads?err=${encodeURIComponent(err.message)}`);
    }
  });

  // Turning a lead into someone we can actually buy from.
  r.post('/:id/convert', requirePermission('lead.edit'), (req, res) => {
    try {
      const lead = admin.getLead(Number(req.params.id));
      if (!lead) throw new Error('lead not found');
      const { id, code } = createSupplier({
        name: lead.name, phone: lead.phone, area: lead.area,
        ward_id: lead.ward_id, mm_name: lead.name,
        notes: `Converted from referral ${lead.code}`,
      }, req.user.id);
      admin.convertLeadToSupplier(lead.id, id, req.user.id);
      res.redirect(`/outsourcing/suppliers?ok=${encodeURIComponent(`${lead.name} is now supplier ${code}`)}`);
    } catch (err) {
      res.redirect(`/leads?err=${encodeURIComponent(err.message)}`);
    }
  });

  app.use('/leads', r);
}
