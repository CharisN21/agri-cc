// Owner dashboard. Four panes, four questions.
//
// Every figure below is computed from rows at read time. Nothing is cached and
// nothing is hardcoded. If a number looks wrong, the query that produced it is
// the only place to look.
//
// A note on "margin". We buy grain; we do not record selling it, so a true
// gross margin is not derivable from this database and inventing one would be
// the classic mistake of reporting revenue as profit. What IS derivable, and
// what the owner actually decides on, is whether we bought below budget: the
// budget is the season's base price, the actual is what we paid after quality
// adjustments. That is what "margin vs budget" means everywhere below.
import { getDb } from './db.js';
import { applyBp, divRound } from './domain/units.js';

const MOISTURE_ALERT_BP = 1200; // 12.00% — wet enough to spoil in the store

export function dashboard(seasonId, { asOf }) {
  const db = getDb();
  const season = db.prepare('SELECT * FROM season WHERE id = ?').get(seasonId);
  const schedule = db.prepare(
    'SELECT * FROM price_schedule WHERE season_id = ? ORDER BY version DESC LIMIT 1',
  ).get(seasonId);

  return {
    season,
    schedule,
    asOf,
    tonnage: tonnagePane(db, seasonId, season),
    money: moneyPane(db, seasonId, schedule),
    credit: creditPane(db, seasonId),
    risk: riskPane(db, seasonId, asOf),
  };
}

// --- pane 1: will we hit tonnage? -----------------------------------------
function tonnagePane(db, seasonId, season) {
  const byWard = db.prepare(
    `SELECT l.id AS ward_id, l.name AS ward_name,
            COALESCE(SUM(d.gross_g - d.tare_g), 0) AS delivered_g,
            (SELECT COALESCE(SUM(c.expected_g), 0) FROM contract c
               JOIN farmer f2 ON f2.id = c.farmer_id
              WHERE f2.ward_id = l.id AND c.season_id = @season_id
                AND c.status = 'Signed') AS expected_g,
            COUNT(DISTINCT d.farmer_id) AS delivering_farmers
       FROM location l
       LEFT JOIN farmer f ON f.ward_id = l.id
       LEFT JOIN delivery d ON d.farmer_id = f.id AND d.season_id = @season_id
                           AND d.status <> 'Rejected'
      WHERE l.kind = 'ward'
      GROUP BY l.id, l.name
      ORDER BY delivered_g DESC`,
  ).all({ season_id: seasonId });

  const deliveredG = byWard.reduce((s, w) => s + w.delivered_g, 0);
  const targetG = season?.target_g ?? 0;
  return {
    deliveredG,
    targetG,
    shortfallG: Math.max(0, targetG - deliveredG),
    achievedBp: targetG ? divRound(deliveredG * 10000, targetG) : 0,
    byWard: byWard.map((w) => ({
      ...w,
      achievedBp: w.expected_g ? divRound(w.delivered_g * 10000, w.expected_g) : 0,
    })),
    drill: '/deliveries',
  };
}

// --- pane 2: are we making money? -----------------------------------------
function moneyPane(db, seasonId, schedule) {
  const totals = db.prepare(
    `SELECT COALESCE(SUM(s.gross_value_cents), 0) AS gross_cents,
            COALESCE(SUM(s.cess_cents), 0)        AS cess_cents,
            COALESCE(SUM(s.payable_g), 0)         AS payable_g,
            COUNT(*)                              AS settlements
       FROM settlement s WHERE s.season_id = ? AND s.status <> 'Rejected'`,
  ).get(seasonId);

  // Landed cost = what the grain cost us to get into the store.
  const landedCents = totals.gross_cents + totals.cess_cents;
  const landedPerTonneCents = totals.payable_g
    ? divRound(landedCents * 1_000_000, totals.payable_g)
    : 0;
  // Budget = the same tonnage bought at the season's base price.
  const budgetPerTonneCents = schedule ? schedule.base_price_cents * 1000 : 0;

  const byWard = db.prepare(
    `SELECT l.name AS ward_name,
            COALESCE(SUM(s.gross_value_cents + s.cess_cents), 0) AS landed_cents,
            COALESCE(SUM(s.payable_g), 0) AS payable_g
       FROM settlement s
       JOIN farmer f ON f.id = s.farmer_id
       JOIN location l ON l.id = f.ward_id
      WHERE s.season_id = ? AND s.status <> 'Rejected'
      GROUP BY l.id, l.name
      ORDER BY payable_g DESC`,
  ).all(seasonId).map((w) => {
    const perTonne = w.payable_g ? divRound(w.landed_cents * 1_000_000, w.payable_g) : 0;
    return { ...w, landed_per_tonne_cents: perTonne,
             margin_per_tonne_cents: budgetPerTonneCents - perTonne };
  });

  const gradeMix = db.prepare(
    `SELECT q.grade, COUNT(*) AS loads,
            COALESCE(SUM(d.gross_g - d.tare_g), 0) AS net_g
       FROM quality_test q
       JOIN delivery d ON d.id = q.delivery_id
      WHERE d.season_id = ?
      GROUP BY q.grade ORDER BY q.grade`,
  ).all(seasonId);
  const gradeTotalG = gradeMix.reduce((s, g) => s + g.net_g, 0);

  return {
    landedCents,
    landedPerTonneCents,
    budgetPerTonneCents,
    marginPerTonneCents: budgetPerTonneCents - landedPerTonneCents,
    payableG: totals.payable_g,
    settlements: totals.settlements,
    byWard,
    gradeMix: gradeMix.map((g) => ({
      ...g,
      shareBp: gradeTotalG ? divRound(g.net_g * 10000, gradeTotalG) : 0,
    })),
    drill: '/settlements',
  };
}

// --- pane 3: is our money coming back? ------------------------------------
function creditPane(db, seasonId) {
  const led = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS issued_cents,
            COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS recovered_cents
       FROM ledger_entry WHERE season_id = ?`,
  ).get(seasonId);

  // Side-selling watchlist: farmers who took seed but whose deliveries fall
  // short of what their contracted acreage should have produced.
  const watchlist = db.prepare(
    `SELECT f.id, f.code, f.full_name, l.name AS ward_name,
            (SELECT COALESCE(SUM(c2.expected_g), 0) FROM contract c2
              WHERE c2.farmer_id = f.id AND c2.season_id = @season_id
                AND c2.status = 'Signed') AS expected_g,
            (SELECT COALESCE(SUM(d.gross_g - d.tare_g), 0) FROM delivery d
              WHERE d.farmer_id = f.id AND d.season_id = @season_id
                AND d.status <> 'Rejected') AS delivered_g,
            (SELECT COALESCE(SUM(le.amount_cents), 0) FROM ledger_entry le
              WHERE le.farmer_id = f.id AND le.season_id = @season_id) AS balance_cents
       FROM farmer f
       JOIN location l ON l.id = f.ward_id
      WHERE EXISTS (SELECT 1 FROM contract c WHERE c.farmer_id = f.id
                      AND c.season_id = @season_id AND c.status = 'Signed')
      GROUP BY f.id, f.code, f.full_name, l.name
     HAVING expected_g > 0
      ORDER BY (delivered_g * 10000) / expected_g ASC
      LIMIT 12`,
  ).all({ season_id: seasonId }).map((r) => ({
    ...r,
    deliveredBp: r.expected_g ? divRound(r.delivered_g * 10000, r.expected_g) : 0,
  }));

  return {
    issuedCents: led.issued_cents,
    recoveredCents: led.recovered_cents,
    outstandingCents: led.issued_cents - led.recovered_cents,
    recoveredBp: led.issued_cents
      ? divRound(led.recovered_cents * 10000, led.issued_cents)
      : 0,
    watchlist,
    drill: '/farmers',
  };
}

// --- pane 4: is anything about to break? ----------------------------------
function riskPane(db, seasonId, asOf) {
  const alerts = [];

  const awaitingApproval = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(net_payable_cents), 0) AS cents FROM settlement WHERE season_id = ? AND status = 'Pending'",
  ).get(seasonId);
  if (awaitingApproval.n > 0) {
    alerts.push({
      severity: 'action', title: 'Settlements awaiting approval',
      detail: `${awaitingApproval.n} settlement(s) worth KES ${(awaitingApproval.cents / 100).toFixed(2)} need a decision.`,
      drill: '/settlements?status=Pending',
    });
  }

  const unpaid = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents), 0) AS cents FROM settlement WHERE season_id = ? AND status = 'Approved'",
  ).get(seasonId);
  if (unpaid.n > 0) {
    alerts.push({
      severity: 'warn', title: 'Approved but unpaid',
      detail: `${unpaid.n} farmer(s) are owed KES ${(unpaid.cents / 100).toFixed(2)}. Run the payment worker.`,
      drill: '/settlements?status=Approved',
    });
  }

  const wet = db.prepare(
    `SELECT COUNT(*) AS n FROM quality_test q
       JOIN delivery d ON d.id = q.delivery_id
      WHERE d.season_id = ? AND q.moisture_bp > ? AND d.status <> 'Rejected'`,
  ).get(seasonId, MOISTURE_ALERT_BP);
  if (wet.n > 0) {
    alerts.push({
      severity: 'warn', title: 'Wet grain in store',
      detail: `${wet.n} accepted load(s) above 12.00% moisture. These will spoil if not dried.`,
      drill: '/deliveries',
    });
  }

  const overdueLots = db.prepare(
    'SELECT COUNT(*) AS n FROM lot WHERE retest_due_on < ?',
  ).get(asOf);
  if (overdueLots.n > 0) {
    alerts.push({
      severity: 'warn', title: 'Seed lots overdue for retest',
      detail: `${overdueLots.n} lot(s) are past their germination retest date and are blocked from issue.`,
      drill: '/issues',
    });
  }

  const nameMismatch = db.prepare(
    `SELECT COUNT(*) AS n FROM farmer f
      WHERE LOWER(TRIM(f.mm_name)) <> LOWER(TRIM(f.full_name))`,
  ).get();
  if (nameMismatch.n > 0) {
    alerts.push({
      severity: 'info', title: 'Mobile money name does not match ID',
      detail: `${nameMismatch.n} farmer(s) will need the payout confirmed by hand.`,
      drill: '/farmers',
    });
  }

  const stuck = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND attempts > 0",
  ).get();
  if (stuck.n > 0) {
    alerts.push({
      severity: 'action', title: 'Payment instructions retrying',
      detail: `${stuck.n} payout(s) failed at the provider and are queued for retry.`,
      drill: '/settlements',
    });
  }

  return { alerts, count: alerts.length };
}

/** The compact tile a host dashboard embeds. Must be fast and never block. */
export function widgetSummary(seasonId, { asOf }) {
  const db = getDb();
  const season = db.prepare('SELECT * FROM season WHERE id = ?').get(seasonId);
  const t = db.prepare(
    `SELECT COALESCE(SUM(gross_g - tare_g), 0) AS delivered_g FROM delivery
      WHERE season_id = ? AND status <> 'Rejected'`,
  ).get(seasonId);
  const led = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS issued,
            COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS recovered
       FROM ledger_entry WHERE season_id = ?`,
  ).get(seasonId);
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM settlement WHERE season_id = ? AND status IN ('Pending','Approved')",
  ).get(seasonId);
  const overdue = db.prepare('SELECT COUNT(*) AS n FROM lot WHERE retest_due_on < ?').get(asOf);

  const targetG = season?.target_g ?? 0;
  const achievedBp = targetG ? divRound(t.delivered_g * 10000, targetG) : 0;
  const recoveredBp = led.issued ? divRound(led.recovered * 10000, led.issued) : 0;

  let status = 'ok';
  if (achievedBp < 5000) status = 'warn';
  if (achievedBp < 2500 || pending.n > 10 || overdue.n > 0) status = 'attention';

  return {
    headline: {
      label: 'Grain delivered this season',
      value: (t.delivered_g / 1_000_000).toFixed(3),
      unit: 'tonnes',
    },
    target: { value: (targetG / 1_000_000).toFixed(3), unit: 'tonnes', achieved_pct: achievedBp / 100 },
    status,
    secondary: [
      { label: 'Input credit recovered', value: `${(recoveredBp / 100).toFixed(2)}%` },
      { label: 'Settlements open', value: String(pending.n) },
      { label: 'Seed lots overdue', value: String(overdue.n) },
    ],
    drill_url: '/dashboard',
    required_permission: 'dashboard.view',
    generated_at: new Date().toISOString(),
  };
}

export { applyBp };
