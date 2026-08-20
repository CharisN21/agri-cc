// Per-request context: which season am I looking at, and in what units.
//
// Everything in this app is season-scoped, so the season is not a filter on one
// screen — it is the frame every screen sits in. It is resolved once here and
// remembered in a cookie, so switching season on one page keeps you in that
// season everywhere.
import { parseCookies } from './auth.js';
import { resolveSeason, listSeasons, progressStrip } from './repo-admin.js';
import { openRuns } from './repo-outsourcing.js';

export const UNITS = { kg: 'Kilograms', t: 'Tonnes' };

export function attachContext(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');

  // ?season= wins (a link someone shared), then the cookie, then the open season.
  const season = resolveSeason(req.query.season || cookies.season);
  req.season = season;
  res.locals.season = season;
  res.locals.seasons = listSeasons();

  // The sidebar highlights the section you are in.
  res.locals.currentPath = req.path;

  const unit = req.query.unit || cookies.unit;
  req.unit = UNITS[unit] ? unit : 'kg';
  res.locals.unit = req.unit;

  // The target strip: a field officer sees their own ward, everyone else the
  // company total. Cheap enough to compute on every page.
  res.locals.progress = season ? progressStrip(season, req.user) : null;

  // An open supply run is unfinished work. It belongs in the sidebar on every
  // screen, not buried in a table you have to remember to go back to.
  res.locals.openRuns = season && req.user ? openRuns(season.id) : [];

  const cookieBits = [];
  if (req.query.season && season) cookieBits.push(`season=${season.id}`);
  if (req.query.unit && UNITS[req.query.unit]) cookieBits.push(`unit=${req.query.unit}`);
  if (cookieBits.length) {
    res.setHeader('Set-Cookie', cookieBits.map(
      (c) => `${c}; SameSite=Lax; Path=/; Max-Age=31536000`));
  }
  next();
}

/**
 * Format a weight in whichever unit the user asked for.
 * The stored value is always grams; this only changes how it reads.
 */
export function weight(grams, unit) {
  if (unit === 't') {
    const s = (grams / 1_000_000).toFixed(3);
    const [w, f] = s.split('.');
    return { value: `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`, suffix: 't' };
  }
  const s = (grams / 1000).toFixed(3);
  const [w, f] = s.split('.');
  return { value: `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`, suffix: 'kg' };
}
