// Data access for the things the owner controls: seasons, tonnage targets,
// referral leads, and the seeding-rate presets behind the cost calculator.
import { getDb, tx } from './db.js';
import { audit } from './repo.js';

// --- seasons ---------------------------------------------------------------
export const listSeasons = () =>
  getDb().prepare(
    `SELECT s.*,
            (SELECT COALESCE(SUM(d.gross_g - d.tare_g), 0) FROM delivery d
              WHERE d.season_id = s.id AND d.status <> 'Rejected') AS delivered_g,
            (SELECT COUNT(*) FROM contract c WHERE c.season_id = s.id) AS contracts
       FROM season s ORDER BY s.starts_on DESC`,
  ).all();

export const getSeason = (id) => getDb().prepare('SELECT * FROM season WHERE id = ?').get(id);

/**
 * Resolve which season a request is working in.
 *
 * Everything in this app is season-scoped, so "which season am I looking at"
 * is a real question rather than a filter. An explicit choice wins; otherwise
 * the open season; otherwise the most recent.
 */
export function resolveSeason(requestedId) {
  const db = getDb();
  if (requestedId) {
    const s = db.prepare('SELECT * FROM season WHERE id = ?').get(Number(requestedId));
    if (s) return s;
  }
  return db.prepare("SELECT * FROM season WHERE status = 'open' ORDER BY starts_on DESC").get()
      ?? db.prepare('SELECT * FROM season ORDER BY starts_on DESC LIMIT 1').get();
}

export function createSeason(data, actorId) {
  return tx((db) => {
    const info = db.prepare(
      `INSERT INTO season (code, name, starts_on, ends_on, target_g)
       VALUES (@code, @name, @starts_on, @ends_on, @target_g)`,
    ).run(data);
    audit(actorId, 'season.create', 'season', info.lastInsertRowid, { code: data.code });
    return info.lastInsertRowid;
  });
}

export function closeSeason(seasonId, actorId) {
  return tx((db) => {
    db.prepare("UPDATE season SET status = 'closed' WHERE id = ?").run(seasonId);
    audit(actorId, 'season.close', 'season', seasonId, {});
  });
}

// --- targets ---------------------------------------------------------------

/** The owner's company-wide number. */
export function setSeasonTarget(seasonId, targetG, actorId) {
  return tx((db) => {
    db.prepare('UPDATE season SET target_g = ? WHERE id = ?').run(targetG, seasonId);
    audit(actorId, 'season.target', 'season', seasonId, { targetG });
  });
}

/** Per-ward targets. Setting one replaces the previous value for that ward. */
export function setWardTarget(seasonId, wardId, targetG, actorId) {
  return tx((db) => {
    db.prepare(
      `INSERT INTO ward_target (season_id, ward_id, target_g, set_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(season_id, ward_id)
       DO UPDATE SET target_g = excluded.target_g, set_by = excluded.set_by,
                     set_at = datetime('now')`,
    ).run(seasonId, wardId, targetG, actorId ?? null);
    audit(actorId, 'ward.target', 'location', wardId, { seasonId, targetG });
  });
}

/**
 * Targets and progress, per ward.
 *
 * Pass a wardId to get just that ward — this is what a field officer sees, so
 * they get their own number rather than the company total.
 */
export function targetProgress(seasonId, { wardId = null } = {}) {
  const rows = getDb().prepare(
    `SELECT l.id AS ward_id, l.name AS ward_name,
            COALESCE(wt.target_g, 0) AS target_g,
            (SELECT COALESCE(SUM(d.gross_g - d.tare_g), 0) FROM delivery d
               JOIN farmer f ON f.id = d.farmer_id
              WHERE f.ward_id = l.id AND d.season_id = @season_id
                AND d.status <> 'Rejected') AS delivered_g,
            (SELECT COALESCE(SUM(sp.payable_g), 0) FROM spot_purchase sp
               JOIN supplier su ON su.id = sp.supplier_id
              WHERE su.ward_id = l.id AND sp.season_id = @season_id
                AND sp.status <> 'Rejected') AS outsourced_g
       FROM location l
       LEFT JOIN ward_target wt ON wt.ward_id = l.id AND wt.season_id = @season_id
      WHERE l.kind = 'ward' AND (@ward_id IS NULL OR l.id = @ward_id)
      ORDER BY l.name`,
  ).all({ season_id: seasonId, ward_id: wardId });

  return rows.map((r) => {
    const totalG = r.delivered_g + r.outsourced_g;
    return {
      ...r,
      totalG,
      achievedBp: r.target_g ? Math.round((totalG * 10000) / r.target_g) : 0,
      shortfallG: Math.max(0, r.target_g - totalG),
    };
  });
}

/**
 * The slim progress strip every role sees. A field officer gets their ward;
 * everyone else gets the company total. Nobody has to open the full dashboard
 * to know whether the season is on track.
 */
export function progressStrip(season, user) {
  const db = getDb();
  const wardScoped = user && user.role === 'field_officer' && user.ward_id;

  if (wardScoped) {
    const [w] = targetProgress(season.id, { wardId: user.ward_id });
    if (w) {
      return {
        scope: 'ward', label: `${w.ward_name} ward`,
        deliveredG: w.totalG, targetG: w.target_g,
        achievedBp: w.achievedBp, shortfallG: w.shortfallG,
      };
    }
  }
  const d = db.prepare(
    `SELECT COALESCE(SUM(gross_g - tare_g), 0) AS g FROM delivery
      WHERE season_id = ? AND status <> 'Rejected'`,
  ).get(season.id).g;
  const s = db.prepare(
    `SELECT COALESCE(SUM(payable_g), 0) AS g FROM spot_purchase
      WHERE season_id = ? AND status <> 'Rejected'`,
  ).get(season.id).g;
  const totalG = d + s;
  return {
    scope: 'company', label: season.name,
    deliveredG: totalG, targetG: season.target_g,
    achievedBp: season.target_g ? Math.round((totalG * 10000) / season.target_g) : 0,
    shortfallG: Math.max(0, season.target_g - totalG),
  };
}

// --- leads -----------------------------------------------------------------
const nextLeadCode = () => {
  const row = getDb().prepare(
    "SELECT COALESCE(MAX(CAST(SUBSTR(code, 6) AS INTEGER)), 0) AS n FROM lead",
  ).get();
  return `LEAD-${String(row.n + 1).padStart(4, '0')}`;
};

export function createLead(data, actorId) {
  return tx((db) => {
    const code = nextLeadCode();
    const info = db.prepare(
      `INSERT INTO lead (code, name, phone, area, ward_id, can_supply_g, source,
                         status, follow_up_on, notes, created_by)
       VALUES (@code, @name, @phone, @area, @ward_id, @can_supply_g, @source,
               @status, @follow_up_on, @notes, @created_by)`,
    ).run({
      code, phone: '', area: '', ward_id: null, can_supply_g: 0, source: '',
      status: 'To call', follow_up_on: null, notes: '', ...data,
      created_by: actorId ?? null,
    });
    audit(actorId, 'lead.create', 'lead', info.lastInsertRowid, { code });
    return { id: info.lastInsertRowid, code };
  });
}

/** Log a call. This is the whole point of the screen: who did we ring, when,
 *  what did they say, and when should we ring them again. */
export function logLeadContact(leadId, { status, notes, followUpOn, contactedOn }, actorId) {
  return tx((db) => {
    const lead = db.prepare('SELECT * FROM lead WHERE id = ?').get(leadId);
    if (!lead) throw new Error('lead not found');
    const appended = notes
      ? `${lead.notes ? `${lead.notes}\n` : ''}[${contactedOn}] ${notes}`
      : lead.notes;
    db.prepare(
      `UPDATE lead SET status = ?, notes = ?, follow_up_on = ?,
              last_contacted_on = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(status || lead.status, appended, followUpOn || null, contactedOn, leadId);
    audit(actorId, 'lead.contact', 'lead', leadId, { status });
    return true;
  });
}

export function convertLeadToSupplier(leadId, supplierId, actorId) {
  return tx((db) => {
    db.prepare(
      `UPDATE lead SET status = 'Converted', converted_supplier_id = ?,
              updated_at = datetime('now') WHERE id = ?`,
    ).run(supplierId, leadId);
    audit(actorId, 'lead.convert', 'lead', leadId, { supplierId });
  });
}

export const listLeads = ({ status = null, q = '', dueOnly = false, today = null } = {}) =>
  getDb().prepare(
    `SELECT le.*, l.name AS ward_name, u.full_name AS created_by_name,
            s.code AS supplier_code
       FROM lead le
       LEFT JOIN location l ON l.id = le.ward_id
       LEFT JOIN app_user u ON u.id = le.created_by
       LEFT JOIN supplier s ON s.id = le.converted_supplier_id
      WHERE (@status IS NULL OR le.status = @status)
        AND (@q = '' OR le.name LIKE @like OR le.phone LIKE @like OR le.area LIKE @like)
        AND (@due = 0 OR (le.follow_up_on IS NOT NULL AND le.follow_up_on <= @today))
      ORDER BY
        CASE le.status WHEN 'Interested' THEN 0 WHEN 'To call' THEN 1
                       WHEN 'Called' THEN 2 WHEN 'Converted' THEN 3 ELSE 4 END,
        le.follow_up_on IS NULL, le.follow_up_on, le.id DESC`,
  ).all({ status, q, like: `%${q}%`, due: dueOnly ? 1 : 0, today: today ?? '9999-12-31' });

export const getLead = (id) => getDb().prepare('SELECT * FROM lead WHERE id = ?').get(id);

export function leadStats(today) {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM lead GROUP BY status').all();
  const due = db.prepare(
    "SELECT COUNT(*) AS n FROM lead WHERE follow_up_on IS NOT NULL AND follow_up_on <= ? AND status NOT IN ('Converted','Not interested')",
  ).get(today).n;
  const potential = db.prepare(
    "SELECT COALESCE(SUM(can_supply_g), 0) AS g FROM lead WHERE status IN ('To call','Called','Interested')",
  ).get().g;
  return { byStatus, due, potentialG: potential };
}

// --- seeding rates (presets for the cost calculator) -----------------------
export const seedingRates = () =>
  getDb().prepare('SELECT * FROM seeding_rate ORDER BY g_per_acre').all();

export const defaultSeedingRate = () =>
  getDb().prepare('SELECT * FROM seeding_rate WHERE is_default = 1 LIMIT 1').get()
  ?? getDb().prepare('SELECT * FROM seeding_rate ORDER BY g_per_acre LIMIT 1').get();

export const issuableLots = (today) =>
  getDb().prepare(
    `SELECT lo.*, (SELECT COALESCE(SUM(qty_g), 0) FROM stock_movement sm
                    WHERE sm.lot_id = lo.id) AS on_hand_g
       FROM lot lo WHERE lo.retest_due_on >= ? ORDER BY lo.code`,
  ).all(today);
