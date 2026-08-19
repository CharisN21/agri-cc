// Authentication and role checks. No auth library: scrypt for passwords and a
// signed cookie for the session. Small enough to read in one sitting, which is
// the point.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length &&
         crypto.timingSafeEqual(candidate, expected);
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

export function makeSessionCookie(userId) {
  const value = String(userId);
  return `${value}.${sign(value)}`;
}

export function readSessionCookie(raw) {
  if (!raw || !raw.includes('.')) return null;
  const idx = raw.lastIndexOf('.');
  const value = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  const expected = sign(value);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

// --- roles ----------------------------------------------------------------
//
// The separation that matters: the person who decides the grade must never be
// the person who releases the money. `clerk` can record a delivery and a
// quality test; only finance, ops_manager and owner can approve a settlement.
export const PERMISSIONS = {
  'farmer.view':      ['owner', 'ops_manager', 'field_officer', 'clerk', 'finance'],
  'farmer.edit':      ['owner', 'ops_manager', 'field_officer', 'clerk'],
  'contract.view':    ['owner', 'ops_manager', 'field_officer', 'clerk', 'finance'],
  'contract.edit':    ['owner', 'ops_manager', 'field_officer'],
  'issue.create':     ['owner', 'ops_manager', 'field_officer', 'clerk'],
  'delivery.view':    ['owner', 'ops_manager', 'field_officer', 'clerk', 'finance'],
  'delivery.create':  ['owner', 'ops_manager', 'field_officer', 'clerk'],
  'delivery.grade':   ['owner', 'ops_manager', 'field_officer', 'clerk'],
  'settlement.view':  ['owner', 'ops_manager', 'clerk', 'finance'],
  'settlement.compute': ['owner', 'ops_manager', 'clerk', 'finance'],
  'settlement.approve': ['owner', 'ops_manager', 'finance'],   // NOT clerk
  'payment.run':      ['owner', 'finance'],
  'dashboard.view':   ['owner', 'ops_manager', 'finance'],
};

export function can(user, permission) {
  if (!user) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new RangeError(`unknown permission: ${permission}`);
  return allowed.includes(user.role);
}

export function findUserByUsername(username) {
  return getDb().prepare('SELECT * FROM app_user WHERE username = ? AND active = 1').get(username);
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM app_user WHERE id = ? AND active = 1').get(id);
}

// --- express middleware ---------------------------------------------------
export function attachUser(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = readSessionCookie(cookies.sid);
  req.user = id ? findUserById(id) : null;
  res.locals.user = req.user;
  next();
}

export function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!can(req.user, permission)) {
      const [subject, verb] = permission.split('.');
      return res.status(403).render('error', {
        title: 'Not allowed',
        status: 403,
        message: `Your role (${req.user.role.replace('_', ' ')}) may not ${verb} a ${subject}.`,
      });
    }
    next();
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
