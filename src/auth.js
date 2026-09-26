'use strict';

const crypto = require('node:crypto');
const { parseHidden } = require('./tabs');

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 7;
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Used when the email is unknown so the response time doesn't reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(value, maxAgeSeconds, secure) {
  const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function createSession(db, res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now', ?), datetime('now'))`
  ).run(sha256(token), userId, csrf, `+${SESSION_DAYS} days`);
  res.append('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400, secure));
}

function destroySession(db, req, res, secure) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', sessionCookie('', 0, secure));
}

// The browser signs people out after this long without activity and pings while they're
// active; the server allows a couple of minutes' grace for pings in flight.
const IDLE_GRACE_MINUTES = 2;

// Attaches req.user and req.csrfToken when a valid session cookie is present.
// A session unused for longer than idleMinutes is ended (req.sessionExpired is then set).
function loadSession(db, { idleMinutes = 60, secure = false } = {}) {
  const idleLimit = `-${idleMinutes + IDLE_GRACE_MINUTES} minutes`;
  // req.user.id is the company (every record is scoped to it); req.user.person_id is the
  // person signed in, who may be the company's main login or one of its people.
  const lookup = db.prepare(
    `SELECT c.id AS id, u.id AS person_id, c.username, u.login_name, u.email, u.name, c.agency_name, u.is_admin, u.hidden_tabs,
            CASE WHEN u.status = 'active' AND c.status = 'active' THEN 'active' ELSE 'suspended' END AS status, s.csrf_token,
            (s.last_seen_at IS NOT NULL AND s.last_seen_at <= datetime('now', ?)) AS idle,
            (s.last_seen_at IS NULL OR s.last_seen_at <= datetime('now', '-30 seconds')) AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN users c ON c.id = COALESCE(u.company_id, u.id)
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  );
  const touch = db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?");
  const end = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const hash = sha256(token);
      const row = lookup.get(idleMinutes > 0 ? idleLimit : '+1 day', hash);
      if (row && row.idle) {
        end.run(hash);
        res.append('Set-Cookie', sessionCookie('', 0, secure));
        req.sessionExpired = true;
      } else if (row && row.status === 'active') {
        if (row.stale) touch.run(hash);
        req.csrfToken = row.csrf_token;
        req.sessionTokenHash = hash;
        req.user = { ...row, is_admin: row.is_admin === 1, hidden_tabs: row.is_admin === 1 ? [] : parseHidden(row.hidden_tabs) };
        delete req.user.csrf_token;
        delete req.user.idle;
        delete req.user.stale;
      }
    }
    res.locals.idleMinutes = idleMinutes;
    res.locals.user = req.user || null;
    res.locals.csrfToken = req.csrfToken || '';
    next();
  };
}

// Where to send someone who isn't signed in: back to this page once they have.
// Autosave and other background requests get a 401 instead, so the page can keep their input.
function toLogin(req, res) {
  if (req.get('X-Autosave') === '1' || req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ ok: false, signedOut: true });
  }
  const params = new URLSearchParams();
  if (req.sessionExpired) params.set('timeout', '1');
  // The dashboard is where signing in lands anyway, so only other pages are remembered.
  if (req.method === 'GET' && !['/app', '/admin'].includes(req.originalUrl)) params.set('next', req.originalUrl.slice(0, 500));
  const q = params.toString();
  return res.redirect(`/login${q ? `?${q}` : ''}`);
}

// Only pages inside the app are allowed as a place to return to after signing in.
function safeNext(next, isAdmin) {
  const n = String(next || '');
  const area = isAdmin ? '/admin' : '/app';
  if (n.length > 500 || !(n === area || n.startsWith(`${area}/`) || n.startsWith(`${area}?`))) return null;
  if (/[\\\s]|\/\/|\/\.\.?(\/|$|\?)/.test(n)) return null;
  return n;
}

function requireLogin(req, res, next) {
  if (!req.user) return toLogin(req, res);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return toLogin(req, res);
  // Hide the admin area's existence from everyone else.
  if (!req.user.is_admin) return res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
  next();
}

// Every state-changing request from a logged-in user must carry the session's CSRF token.
// Multipart (file upload) bodies aren't parsed yet at this point, so the check is deferred:
// upload routes call checkCsrfAfterUpload once multer has run, and any other multipart POST
// is rejected by rejectUncheckedMultipart.
function verifyCsrf(req, res, next) {
  if (req.method !== 'POST' || !req.user) return next();
  if (req.is('multipart/form-data')) {
    req.csrfPending = true;
    return next();
  }
  checkCsrfAfterUpload(req, res, next);
}

function rejectUncheckedMultipart(req, res, next) {
  if (req.csrfPending) return res.status(403).render('error', { title: 'Forbidden', message: 'Upload not allowed here.' });
  next();
}

function checkCsrfAfterUpload(req, res, next) {
  req.csrfPending = false;
  const sent = String((req.body && req.body._csrf) || '');
  const expected = req.csrfToken;
  const ok = sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return res.status(403).render('error', { title: 'Forbidden', message: 'Your session token was invalid. Please go back, refresh and try again.' });
  next();
}

// Simple in-memory fixed-window limiter for login/registration attempts.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function isLimited(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createSession,
  destroySession,
  loadSession,
  requireLogin,
  requireAdmin,
  safeNext,
  verifyCsrf,
  checkCsrfAfterUpload,
  rejectUncheckedMultipart,
  rateLimiter,
};
