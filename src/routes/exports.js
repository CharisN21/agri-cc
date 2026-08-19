// CSV export, one entity per file, named BRAND-entity-YYYY-MM-DD.csv, with a
// TOTAL row at the bottom — the convention already in use in the sibling app.
//
// A note on the "full money story" convention. The sibling app's export carries
// unit price, total, unit cost, total cost and gross profit on every line. We
// carry that here ONLY where a real cost exists (seed issued from a lot has a
// genuine unit cost). We deliberately do NOT emit a gross-profit column on
// grain purchases: we buy grain and do not record selling it, so any "profit"
// column there would be the sale value wearing a different hat.
import express from 'express';
import { requireLogin, requirePermission } from '../auth.js';
import * as repo from '../repo.js';
import { config } from '../config.js';
import { exportFilename } from '../domain/codes.js';
import { fromCents, fromGrams, fromBp } from '../domain/units.js';
import { now } from './index.js';

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(headers, rows, totalRow) {
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  if (totalRow) lines.push(totalRow.map(esc).join(','));
  return `${lines.join('\n')}\n`;
}

const DEFS = {
  farmers: (seasonId) => {
    const rows = repo.listFarmers({ limit: 10000 });
    const headers = ['Code', 'Name', 'National ID', 'Phone', 'Mobile money name',
      'Name matches ID', 'Ward', 'Status', 'Expected kg', 'Delivered kg',
      'Balance owed', 'Registered', 'Notes'];
    const body = rows.map((f) => [
      f.code, f.full_name, f.national_id, f.phone, f.mm_name,
      f.mm_name.trim().toLowerCase() === f.full_name.trim().toLowerCase() ? 'Yes' : 'NO',
      f.ward_name, f.status, fromGrams(f.expected_g), fromGrams(f.delivered_g),
      fromCents(f.balance_cents), f.registered_on, f.notes,
    ]);
    const total = ['TOTAL', '', '', '', '', '', '', '',
      fromGrams(rows.reduce((s, f) => s + f.expected_g, 0)),
      fromGrams(rows.reduce((s, f) => s + f.delivered_g, 0)),
      fromCents(rows.reduce((s, f) => s + f.balance_cents, 0)), '', ''];
    return { headers, body, total };
  },

  deliveries: (seasonId) => {
    const rows = repo.listDeliveries({ seasonId, limit: 10000 });
    const headers = ['Code', 'Date', 'Time', 'Farmer code', 'Farmer', 'Ward',
      'Gross kg', 'Tare kg', 'Net kg', 'Moisture %', 'Oil %', 'Foreign %', 'Damage %',
      'Grade', 'Status', 'Settlement', 'Vehicle', 'Notes'];
    const body = rows.map((d) => [
      d.code, d.delivered_on, (d.delivered_at || '').slice(11, 16), d.farmer_code,
      d.full_name, d.ward_name, fromGrams(d.gross_g), fromGrams(d.tare_g),
      fromGrams(d.net_g),
      d.moisture_bp == null ? '' : fromBp(d.moisture_bp),
      d.oil_bp == null ? '' : fromBp(d.oil_bp),
      d.foreign_bp == null ? '' : fromBp(d.foreign_bp),
      d.damage_bp == null ? '' : fromBp(d.damage_bp),
      d.grade || '', d.status, d.settlement_code || '', d.vehicle_reg, d.notes,
    ]);
    const total = ['TOTAL', '', '', '', '', '',
      fromGrams(rows.reduce((s, d) => s + d.gross_g, 0)),
      fromGrams(rows.reduce((s, d) => s + d.tare_g, 0)),
      fromGrams(rows.reduce((s, d) => s + d.net_g, 0)),
      '', '', '', '', '', '', '', '', ''];
    return { headers, body, total };
  },

  settlements: (seasonId) => {
    const rows = repo.listSettlements({ seasonId });
    const headers = ['Code', 'Date', 'Time', 'Farmer code', 'Farmer', 'Ward', 'Delivery',
      'Grade', 'Payable kg', 'Price per kg', 'Gross value', 'Cess', 'Recovery',
      'Cap that bound', 'Net payable', 'Amount paid', 'Balance', 'Status',
      'Payment method', 'Reference', 'Price schedule', 'Notes'];
    const body = rows.map((s) => [
      s.code, s.computed_on, (s.computed_at || '').slice(11, 16), s.farmer_code,
      s.full_name, s.ward_name, s.delivery_code, s.grade || '',
      fromGrams(s.payable_g), fromCents(s.unit_price_cents),
      fromCents(s.gross_value_cents), fromCents(s.cess_cents),
      fromCents(s.recovery_cents), s.recovery_cap,
      fromCents(s.net_payable_cents), fromCents(s.amount_paid_cents),
      fromCents(s.balance_cents), s.status,
      s.method || '', s.provider_ref || '', `v${s.price_schedule_id}`, s.notes,
    ]);
    const sum = (k) => rows.reduce((a, s) => a + s[k], 0);
    const total = ['TOTAL', '', '', '', '', '', '', '',
      fromGrams(sum('payable_g')), '', fromCents(sum('gross_value_cents')),
      fromCents(sum('cess_cents')), fromCents(sum('recovery_cents')), '',
      fromCents(sum('net_payable_cents')), fromCents(sum('amount_paid_cents')),
      fromCents(sum('balance_cents')), '', '', '', '', ''];
    return { headers, body, total };
  },

  issues: (seasonId) => {
    const rows = repo.listIssues(seasonId);
    const headers = ['Code', 'Date', 'Time', 'Farmer code', 'Farmer', 'Contract',
      'Lot', 'KEPHIS tag', 'Quantity kg', 'Cost per kg', 'Cost total', 'Notes'];
    const body = rows.map((i) => [
      i.code, i.issued_on, (i.issued_at || '').slice(11, 16), i.farmer_code,
      i.full_name, i.contract_code, i.lot_code, i.kephis_tag,
      fromGrams(i.qty_g), fromCents(i.unit_cost_cents), fromCents(i.value_cents), i.notes,
    ]);
    const total = ['TOTAL', '', '', '', '', '', '', '',
      fromGrams(rows.reduce((s, i) => s + i.qty_g, 0)), '',
      fromCents(rows.reduce((s, i) => s + i.value_cents, 0)), ''];
    return { headers, body, total };
  },

  contracts: (seasonId) => {
    const rows = repo.listContracts({ seasonId });
    const headers = ['Code', 'Farmer code', 'Farmer', 'Ward', 'Parcel', 'Expected kg',
      'Seed entitlement kg', 'Seed issued kg', 'Recovery share %', 'Status',
      'Offered', 'Signed', 'Notes'];
    const body = rows.map((c) => [
      c.code, c.farmer_code, c.full_name, c.ward_name, c.parcel_code,
      fromGrams(c.expected_g), fromGrams(c.seed_entitlement_g), fromGrams(c.issued_g),
      fromBp(c.recovery_share_bp), c.status, c.offered_on, c.signed_on || '', c.notes,
    ]);
    const total = ['TOTAL', '', '', '', '',
      fromGrams(rows.reduce((s, c) => s + c.expected_g, 0)),
      fromGrams(rows.reduce((s, c) => s + c.seed_entitlement_g, 0)),
      fromGrams(rows.reduce((s, c) => s + c.issued_g, 0)),
      '', '', '', '', ''];
    return { headers, body, total };
  },
};

export default function mountExports(app) {
  const r = express.Router();
  r.use(requireLogin);

  r.get('/:entity.csv', requirePermission('farmer.view'), (req, res) => {
    const build = DEFS[req.params.entity];
    if (!build) return res.status(404).render('error',
      { title: 'Not found', status: 404, message: `Cannot export "${req.params.entity}".` });

    const season = req.season;
    const { headers, body, total } = build(season.id);
    const filename = exportFilename(config.brand, req.params.entity, now().on);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(headers, body, total));
  });

  app.use('/export', r);
}

export { toCsv };
