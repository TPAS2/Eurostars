'use strict';

const express = require('express');
const crypto = require('node:crypto');
const auth = require('../auth');
const totp = require('../totp');
const activity = require('../activity');
const { USERNAME_RE, signInNameFrom } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function authRoutes(db, config) {
  const router = express.Router();
  const loginLimited = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: config.loginAttemptsPer15Min || 10 });
  const registerLimited = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: config.registrationsPerHour || 10 });

  const logEvent = db.prepare('INSERT INTO login_events (user_id, email, success, ip, user_agent) VALUES (?, ?, ?, ?, ?)');

  function landing(user) {
    return user.is_admin ? '/admin' : '/app';
  }

  const loginPage = (req, extra) => ({
    title: 'Sign in', error: '', login: '', member: '', allowRegistration: config.allowRegistration,
    next: String(req.body?.next ?? req.query.next ?? '').slice(0, 500), timedOut: false, idleMinutes: config.idleTimeoutMinutes ?? 60, ...extra,
  });

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(auth.safeNext(req.query.next, req.user.is_admin) || landing(req.user));
    res.render('login', loginPage(req, { login: String(req.query.u || '').slice(0, 254), timedOut: req.query.timeout === '1' }));
  });

  // Everyone signs in with a username, their own name and their password. All three are
  // required and must match exactly, including capitals.
  const findCompany = db.prepare('SELECT * FROM users WHERE username = ? COLLATE BINARY AND company_id IS NULL');
  const findPerson = db.prepare('SELECT * FROM users WHERE company_id = ? AND login_name = ? COLLATE BINARY');

  router.post('/login', (req, res) => {
    const login = String(req.body.login || '').trim().slice(0, 254);
    const member = String(req.body.member || '').trim().slice(0, 60);
    const password = String(req.body.password || '');
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const who = `${login} / ${member}`;
    const fail = (status, error) => res.status(status).render('login', loginPage(req, { error, login, member }));
    if (loginLimited(`${ip}|${who}`)) return fail(429, 'Too many attempts. Please wait 15 minutes and try again.');
    if (!login || !member || !password) return fail(422, 'Enter your agency, your name and your password.');
    const company = findCompany.get(login);
    // The company's own row is its main login (and the admin's login); everyone else is a
    // person inside a company.
    const user = !company ? null : company.login_name === member ? company : findPerson.get(company.id, member);
    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH) && !!user;
    if (!ok) {
      logEvent.run(user ? user.id : null, who, 0, ip, ua);
      return fail(401, 'Incorrect agency, name or password.');
    }
    if (user.status !== 'active' || company.status !== 'active') {
      logEvent.run(user.id, who, 0, ip, ua);
      return fail(403, 'This account has been suspended. Please contact your administrator.');
    }
    if (user.totp_enabled === 1) {
      // Password is right; now ask for the code from their authenticator app.
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare("DELETE FROM login_challenges WHERE user_id = ? OR expires_at <= datetime('now')").run(user.id);
      db.prepare("INSERT INTO login_challenges (token_hash, user_id, expires_at, next_url) VALUES (?, ?, datetime('now', '+10 minutes'), ?)")
        .run(sha256(token), user.id, auth.safeNext(req.body.next, user.is_admin === 1));
      res.append('Set-Cookie', challengeCookie(token, 600));
      return res.redirect('/login/code');
    }
    logEvent.run(user.id, who, 1, ip, ua);
    if (config.activityLog !== false) activity.logSignIn(db, user.id, ip);
    startSession(user, res);
    res.redirect(auth.safeNext(req.body.next, user.is_admin === 1) || landing({ is_admin: user.is_admin === 1 }));
  });

  // ---------- two-step login ----------

  const CHALLENGE_COOKIE = 'signin2';
  const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
  function challengeCookie(value, maxAge) {
    const attrs = [`${CHALLENGE_COOKIE}=${value}`, 'Path=/login', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (config.secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }
  function pendingChallenge(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${CHALLENGE_COOKIE}=([^;]+)`));
    if (!m) return null;
    const row = db.prepare("SELECT * FROM login_challenges WHERE token_hash = ? AND expires_at > datetime('now')").get(sha256(m[1]));
    return row ? { ...row, token: m[1] } : null;
  }

  router.get('/login/code', (req, res) => {
    if (!pendingChallenge(req)) return res.redirect('/login');
    res.render('login-code', { title: 'Enter your code', error: '' });
  });

  router.post('/login/code', (req, res) => {
    const ch = pendingChallenge(req);
    if (!ch) return res.redirect('/login');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
    const input = String(req.body.code || '').trim();
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const who = `${user.username} (two-step code)`;
    let ok = false;
    const step = totp.verify(user.totp_secret, input, user.totp_last_step);
    if (step !== null) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      ok = true;
    } else {
      // A recovery code works once.
      const hashes = JSON.parse(user.totp_recovery || '[]');
      const i = hashes.indexOf(totp.hashRecoveryCode(input));
      if (i >= 0 && input.length >= 8) {
        hashes.splice(i, 1);
        db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
        ok = true;
      }
    }
    if (!ok) {
      logEvent.run(user.id, who, 0, ip, ua);
      const attempts = ch.attempts + 1;
      if (attempts >= 5) {
        db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(ch.token_hash);
        res.append('Set-Cookie', challengeCookie('', 0));
        return res.status(401).render('login', loginPage(req, { error: 'Too many wrong codes. Please sign in again.', next: ch.next_url || '' }));
      }
      db.prepare('UPDATE login_challenges SET attempts = ? WHERE token_hash = ?').run(attempts, ch.token_hash);
      return res.status(401).render('login-code', { title: 'Enter your code', error: 'That code isn\'t right. Check your authenticator app and try again.' });
    }
    db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(ch.token_hash);
    res.append('Set-Cookie', challengeCookie('', 0));
    logEvent.run(user.id, who, 1, ip, ua);
    if (config.activityLog !== false) activity.logSignIn(db, user.id, ip);
    startSession(user, res);
    res.redirect(auth.safeNext(ch.next_url, user.is_admin === 1) || landing({ is_admin: user.is_admin === 1 }));
  });

  function startSession(user, res) {
    db.prepare("UPDATE users SET last_login_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    auth.createSession(db, res, user.id, config.secureCookies);
  }

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect(landing(req.user));
    if (!config.allowRegistration) return res.status(403).render('error', { title: 'Registration closed', message: 'New sign-ups are currently closed.' });
    res.render('register', { title: 'Create account', errors: {}, values: {} });
  });

  const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'support', 'letwise', 'nexus', 'system']);

  router.post('/register', (req, res) => {
    if (!config.allowRegistration) return res.status(403).render('error', { title: 'Registration closed', message: 'New sign-ups are currently closed.' });
    const values = {
      username: String(req.body.username || '').trim().slice(0, 60),
      name: String(req.body.name || '').trim().slice(0, 200),
      agency_name: String(req.body.agency_name || '').trim().slice(0, 200),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 254),
    };
    const password = String(req.body.password || '');
    const errors = {};
    if (!USERNAME_RE.test(values.username)) {
      errors.username = 'Use 3–30 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    } else if (RESERVED_USERNAMES.has(values.username.toLowerCase()) || values.username.toLowerCase() === config.adminUsername.toLowerCase()
      || db.prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) {
      errors.username = 'That username is taken. Try another.';
    }
    if (!values.name) errors.name = 'Enter your name.';
    if (!values.agency_name) errors.agency_name = 'Enter your agency or business name.';
    if (values.email && !EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address, or leave it blank.';
    else if (values.email && ((config.adminEmail && values.email === config.adminEmail)
      || db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email))) {
      errors.email = 'An account with this email already exists.';
    }
    if (password.length < 10) errors.password = 'Use at least 10 characters.';
    if (password.length > 200) errors.password = 'Password is too long.';
    if (password !== String(req.body.password_confirm || '')) errors.password_confirm = "Passwords don't match.";
    if (registerLimited(req.ip)) errors.form = 'Too many sign-ups from your network. Please try again later.';
    if (Object.keys(errors).length) return res.status(422).render('register', { title: 'Create account', errors, values });
    // is_admin is never set here: the admin account comes only from ADMIN_EMAIL / create-admin.
    const info = db.prepare('INSERT INTO users (username, login_name, email, name, agency_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(values.username, signInNameFrom(values.name), values.email || null, values.name, values.agency_name, auth.hashPassword(password));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    logEvent.run(user.id, user.username, 1, req.ip, String(req.headers['user-agent'] || '').slice(0, 300));
    startSession(user, res);
    res.redirect('/app?flash=' + encodeURIComponent(`Welcome to ${config.appName}! Your account is ready. You sign in with the username ${user.username}.`));
  });

  router.post('/logout', (req, res) => {
    const isAdmin = !!(req.user && req.user.is_admin);
    auth.destroySession(db, req, res, config.secureCookies);
    // Signed out for inactivity: say so, and return to the same page after signing back in.
    if (req.body.reason === 'idle') {
      const params = new URLSearchParams({ timeout: '1' });
      const next = auth.safeNext(req.body.next, isAdmin);
      if (next) params.set('next', next);
      return res.redirect(`/login?${params}`);
    }
    res.redirect('/login');
  });

  // The page pings this while someone is using it, so typing without saving still counts as activity.
  router.get('/session/ping', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ ok: false, signedOut: true });
    res.json({ ok: true });
  });

  return router;
};
