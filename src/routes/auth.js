'use strict';

const express = require('express');
const auth = require('../auth');
const { USERNAME_RE } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function authRoutes(db, config) {
  const router = express.Router();
  const loginLimited = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  const registerLimited = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: config.registrationsPerHour || 10 });

  const logEvent = db.prepare('INSERT INTO login_events (user_id, email, success, ip, user_agent) VALUES (?, ?, ?, ?, ?)');

  function landing(user) {
    return user.is_admin ? '/admin' : '/app';
  }

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(landing(req.user));
    res.render('login', { title: 'Sign in', error: '', login: String(req.query.u || '').slice(0, 254), allowRegistration: config.allowRegistration });
  });

  // Sign in with either the username or the email address.
  router.post('/login', (req, res) => {
    const login = String(req.body.login || req.body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body.password || '');
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const fail = (status, error) => res.status(status).render('login', { title: 'Sign in', error, login, allowRegistration: config.allowRegistration });
    if (loginLimited(`${ip}|${login}`)) return fail(429, 'Too many attempts. Please wait 15 minutes and try again.');
    const user = login ? db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login) : null;
    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH) && !!user;
    if (!ok) {
      logEvent.run(user ? user.id : null, login, 0, ip, ua);
      return fail(401, 'Incorrect username or password.');
    }
    if (user.status !== 'active') {
      logEvent.run(user.id, login, 0, ip, ua);
      return fail(403, 'This account has been suspended. Please contact support.');
    }
    logEvent.run(user.id, login, 1, ip, ua);
    startSession(user, res);
    res.redirect(landing({ is_admin: user.is_admin === 1 }));
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
      username: String(req.body.username || '').trim().toLowerCase().slice(0, 60),
      name: String(req.body.name || '').trim().slice(0, 200),
      agency_name: String(req.body.agency_name || '').trim().slice(0, 200),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 254),
    };
    const password = String(req.body.password || '');
    const errors = {};
    if (!USERNAME_RE.test(values.username)) {
      errors.username = 'Use 3–30 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    } else if (RESERVED_USERNAMES.has(values.username) || values.username === config.adminUsername
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
    const info = db.prepare('INSERT INTO users (username, email, name, agency_name, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(values.username, values.email || null, values.name, values.agency_name, auth.hashPassword(password));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    logEvent.run(user.id, user.username, 1, req.ip, String(req.headers['user-agent'] || '').slice(0, 300));
    startSession(user, res);
    res.redirect('/app?flash=' + encodeURIComponent(`Welcome to ${config.appName}! Your account is ready. You sign in with the username ${user.username}.`));
  });

  router.post('/logout', (req, res) => {
    auth.destroySession(db, req, res, config.secureCookies);
    res.redirect('/login');
  });

  return router;
};
