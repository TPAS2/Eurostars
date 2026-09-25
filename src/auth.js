'use strict';

const crypto = require('node:crypto');

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
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`
  ).run(sha256(token), userId, csrf, `+${SESSION_DAYS} days`);
  res.append('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400, secure));
}

function destroySession(db, req, res, secure) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', sessionCookie('', 0, secure));
}

// Attaches req.user and req.csrfToken when a valid session cookie is present.
function loadSession(db) {
  // req.user.id is the company (every record is scoped to it); req.user.person_id is the
  // person signed in, who may be the company's main login or one of its people.
  const lookup = db.prepare(
    `SELECT c.id AS id, u.id AS person_id, c.username, u.login_name, u.email, u.name, c.agency_name, u.is_admin,
            CASE WHEN u.status = 'active' AND c.status = 'active' THEN 'active' ELSE 'suspended' END AS status, s.csrf_token
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN users c ON c.id = COALESCE(u.company_id, u.id)
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  );
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = lookup.get(sha256(token));
      if (row && row.status === 'active') {
        req.csrfToken = row.csrf_token;
        req.sessionTokenHash = sha256(token);
        req.user = { ...row, is_admin: row.is_admin === 1 };
        delete req.user.csrf_token;
      }
    }
    res.locals.user = req.user || null;
    res.locals.csrfToken = req.csrfToken || '';
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
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
  verifyCsrf,
  checkCsrfAfterUpload,
  rejectUncheckedMultipart,
  rateLimiter,
};
