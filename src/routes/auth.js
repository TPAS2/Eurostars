'use strict';

const express = require('express');
const auth = require('../auth');

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
    res.render('login', { title: 'Sign in', error: '', email: '', registered: req.query.registered === '1' });
  });

  router.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body.password || '');
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    if (loginLimited(`${ip}|${email}`)) {
      return res.status(429).render('login', { title: 'Sign in', error: 'Too many attempts. Please wait 15 minutes and try again.', email, registered: false });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH) && !!user;
    if (!ok) {
      logEvent.run(user ? user.id : null, email, 0, ip, ua);
      return res.status(401).render('login', { title: 'Sign in', error: 'Incorrect email or password.', email, registered: false });
    }
    if (user.status !== 'active') {
      logEvent.run(user.id, email, 0, ip, ua);
      return res.status(403).render('login', { title: 'Sign in', error: 'This account has been suspended. Please contact support.', email, registered: false });
    }
    logEvent.run(user.id, email, 1, ip, ua);
    db.prepare("UPDATE users SET last_login_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    auth.createSession(db, res, user.id, config.secureCookies);
    res.redirect(landing({ is_admin: user.is_admin === 1 }));
  });

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect(landing(req.user));
    if (!config.allowRegistration) return res.status(403).render('error', { title: 'Registration closed', message: 'New sign-ups are currently closed.' });
    res.render('register', { title: 'Create account', errors: {}, values: {} });
  });

  router.post('/register', (req, res) => {
    if (!config.allowRegistration) return res.status(403).render('error', { title: 'Registration closed', message: 'New sign-ups are currently closed.' });
    const values = {
      name: String(req.body.name || '').trim().slice(0, 200),
      agency_name: String(req.body.agency_name || '').trim().slice(0, 200),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 254),
    };
    const password = String(req.body.password || '');
    const errors = {};
    if (!values.name) errors.name = 'Enter your name.';
    if (!values.agency_name) errors.agency_name = 'Enter your agency or business name.';
    if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';
    if (password.length < 10) errors.password = 'Use at least 10 characters.';
    if (password.length > 200) errors.password = 'Password is too long.';
    if (password !== String(req.body.password_confirm || '')) errors.password_confirm = "Passwords don't match.";
    if (registerLimited(req.ip)) errors.form = 'Too many sign-ups from your network. Please try again later.';
    const reserved = config.adminEmail && values.email === config.adminEmail;
    if (!errors.email && (reserved || db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email))) {
      errors.email = 'An account with this email already exists.';
    }
    if (Object.keys(errors).length) return res.status(422).render('register', { title: 'Create account', errors, values });
    // is_admin is never set here: the admin account comes only from ADMIN_EMAIL / create-admin.
    db.prepare('INSERT INTO users (email, name, agency_name, password_hash) VALUES (?, ?, ?, ?)')
      .run(values.email, values.name, values.agency_name, auth.hashPassword(password));
    res.redirect('/login?registered=1');
  });

  router.post('/logout', (req, res) => {
    auth.destroySession(db, req, res, config.secureCookies);
    res.redirect('/login');
  });

  return router;
};
