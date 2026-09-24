'use strict';

const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const auth = require('./auth');
const fmt = require('./format');

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT) || 3000,
    dbFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'letwise.db'),
    uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    appName: env.APP_NAME || 'LetWise',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    allowRegistration: env.ALLOW_REGISTRATION !== 'false',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : production,
    trustProxy: env.TRUST_PROXY === 'true',
  };
}

// The admin panel belongs to exactly one account: the one whose email is ADMIN_EMAIL.
// It is created on first start if ADMIN_PASSWORD is set, and every other account is
// stripped of admin rights so the panel stays owner-only.
function ensureAdmin(db, config, log = console.log) {
  if (!config.adminEmail) {
    log('ADMIN_EMAIL is not set: the admin panel is disabled until you set it.');
    db.prepare('UPDATE users SET is_admin = 0').run();
    return;
  }
  let admin = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail);
  if (!admin && config.adminPassword) {
    if (config.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
    const info = db.prepare("INSERT INTO users (email, name, agency_name, password_hash) VALUES (?, 'Administrator', ?, ?)")
      .run(config.adminEmail, config.appName, auth.hashPassword(config.adminPassword));
    admin = { id: Number(info.lastInsertRowid) };
    log(`Created admin account ${config.adminEmail}.`);
  }
  db.prepare('UPDATE users SET is_admin = CASE WHEN id = ? THEN 1 ELSE 0 END').run(admin ? admin.id : -1);
  if (admin) db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.id);
  else log(`No account exists for ADMIN_EMAIL=${config.adminEmail}. Set ADMIN_PASSWORD or run "npm run create-admin".`);
}

function createApp(config, db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.locals.appName = config.appName;
  app.locals.fmt = fmt;

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Reject cross-site form posts (covers login/register, which happen before a session exists).
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host;
      try { host = new URL(origin).host; } catch { host = ''; }
      if (host !== req.headers.host) return res.status(403).send('Cross-site request blocked.');
    }
    next();
  });

  app.use(auth.loadSession(db));
  app.use(auth.verifyCsrf);

  app.get('/', (req, res) => {
    if (req.user) return res.redirect(req.user.is_admin ? '/admin' : '/app');
    res.render('home', { title: config.appName, allowRegistration: config.allowRegistration });
  });
  app.use('/', require('./routes/auth')(db, config));
  app.use('/app/invoices', auth.requireLogin, require('./routes/invoices')(db, config));
  app.use(auth.rejectUncheckedMultipart);
  app.use('/app', auth.requireLogin, require('./routes/app')(db));
  app.use('/admin', auth.requireAdmin, require('./routes/admin')(db, config));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  const db = openDatabase(config.dbFile);
  ensureAdmin(db, config);
  createApp(config, db).listen(config.port, () => {
    console.log(`${config.appName} running on http://localhost:${config.port}`);
  });
}

module.exports = { createApp, loadConfig, ensureAdmin };
