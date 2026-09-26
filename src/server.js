'use strict';

const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const auth = require('./auth');
const { createMailer } = require('./mailer');
const tabs = require('./tabs');
const fmt = require('./format');
const { createStatementWriter } = require('./ai');
const { runMonthlyJob } = require('./statements');
const { scheduleBackups } = require('./backup');
const activity = require('./activity');

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT) || 3000,
    dbFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'nexus.db'),
    uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    backupDir: env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'),
    backupCopyDir: env.BACKUP_COPY_DIR || '',
    // Encrypts every backup when set. Keep it safe: it's needed to restore.
    backupPassword: env.BACKUP_PASSWORD || '',
    backupKeep: Math.max(1, Number(env.BACKUP_KEEP) || 14),
    backupIntervalHours: Math.max(1, Number(env.BACKUP_INTERVAL_HOURS) || 24),
    autoBackups: env.AUTO_BACKUPS !== 'false',
    appName: env.APP_NAME || 'Nexus',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    adminPasswordReset: env.ADMIN_PASSWORD_RESET === 'true',
    admin2faReset: env.ADMIN_2FA_RESET === 'true',
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
    // The admin's "Your name" at sign-in (capitals count).
    adminLoginName: (env.ADMIN_LOGIN_NAME || 'Theo').trim(),
    // Off by default: only the admin adds accounts. Set to true to let anyone sign up.
    allowRegistration: env.ALLOW_REGISTRATION === 'true',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : production,
    trustProxy: env.TRUST_PROXY === 'true',
    autoMonthlyStatements: env.AUTO_MONTHLY_STATEMENTS !== 'false',
    // Record what users view and change for the admin panel's activity log.
    activityLog: env.ACTIVITY_LOG !== 'false',
    // Sign people out after this many minutes without using the site (0 turns it off).
    // Email for statements and reports: Resend (RESEND_API_KEY) or SMTP. EMAIL_FROM is the sender.
    emailFrom: env.EMAIL_FROM || '',
    resendApiKey: env.RESEND_API_KEY || '',
    smtpUrl: env.SMTP_URL || '',
    smtpHost: env.SMTP_HOST || '',
    smtpPort: Number(env.SMTP_PORT) || 587,
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    idleTimeoutMinutes: env.IDLE_TIMEOUT_MINUTES === undefined ? 60 : Math.max(0, Number(env.IDLE_TIMEOUT_MINUTES) || 0),
  };
}

// The admin panel belongs to exactly one account: the one with username ADMIN_USERNAME
// (or, for older setups, email ADMIN_EMAIL). It is created on first start from
// ADMIN_PASSWORD, and every other account is stripped of admin rights so the panel stays
// owner-only. Setting ADMIN_PASSWORD_RESET=true resets the admin password to ADMIN_PASSWORD
// on the next start (for when you've forgotten it).
function ensureAdmin(db, config, log = console.log) {
  // Usernames are unique ignoring case; the stored case is updated to match ADMIN_USERNAME.
  const byUsername = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND company_id IS NULL').get(config.adminUsername);
  const byEmail = config.adminEmail ? db.prepare('SELECT id, username FROM users WHERE email = ?').get(config.adminEmail) : null;
  let admin = byUsername || byEmail;
  if (config.adminPassword && config.adminPassword.length < 6) throw new Error('ADMIN_PASSWORD must be at least 6 characters.');
  if (config.adminPassword && config.adminPassword.length < 10) {
    log('Warning: ADMIN_PASSWORD is short. A longer password (10+ characters) is much harder to guess.');
  }
  if (!admin && config.adminPassword) {
    const info = db.prepare("INSERT INTO users (username, login_name, email, name, agency_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(config.adminUsername, config.adminLoginName, config.adminEmail || null, config.adminLoginName, config.appName, auth.hashPassword(config.adminPassword));
    admin = { id: Number(info.lastInsertRowid), username: config.adminUsername };
    log(`Created admin account: username ${config.adminUsername}, name ${config.adminLoginName}.`);
  } else if (admin) {
    // Keep the stored username (with its capitals) and sign-in name in line with the settings.
    db.prepare("UPDATE users SET username = ?, login_name = ?, name = CASE WHEN name = 'Administrator' THEN ? ELSE name END WHERE id = ?")
      .run(config.adminUsername, config.adminLoginName, config.adminLoginName, admin.id);
  }
  if (admin && config.adminPasswordReset && config.adminPassword) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(config.adminPassword), admin.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
    log('Admin password reset from ADMIN_PASSWORD. Remove ADMIN_PASSWORD_RESET now.');
  }
  if (admin && config.admin2faReset) {
    db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = -1 WHERE id = ?").run(admin.id);
    log('Two-step login switched off for the admin account. Remove ADMIN_2FA_RESET now.');
  }
  db.prepare('UPDATE users SET is_admin = CASE WHEN id = ? THEN 1 ELSE 0 END').run(admin ? admin.id : -1);
  if (admin) db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.id);
  else log(`No admin account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD, then restart.`);
}

function createApp(config, db, { writer = null, mailer = null } = {}) {
  mailer = mailer || createMailer(config);
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
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon-32.png'));
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

  app.use(auth.loadSession(db, { idleMinutes: config.idleTimeoutMinutes ?? 60, secure: config.secureCookies }));
  app.use(auth.verifyCsrf);
  if (config.activityLog !== false) app.use(activity.middleware(db));
  // Tabs the admin has hidden from a person are blocked for them, not just left out of the menu.
  app.use('/app', tabs.guard);

  app.get('/', (req, res) => {
    if (req.user) return res.redirect(req.user.is_admin ? '/admin' : '/app');
    res.redirect('/login');
  });
  app.use('/', require('./routes/auth')(db, config));
  app.use('/app/invoices', auth.requireLogin, require('./routes/invoices')(db, config));
  app.use('/app/councils', auth.requireLogin, require('./routes/councilPhotos')(db));
  app.use('/app/tenancies', auth.requireLogin, require('./routes/agreements')(db));
  app.use('/app/rent-run', auth.requireLogin, require('./routes/payments')(db));
  app.use(auth.rejectUncheckedMultipart);
  const monthly = require('./routes/monthly')(db, writer, mailer);
  app.use('/app/monthly', auth.requireLogin, monthly);
  app.get('/app/rent-run', auth.requireLogin, monthly.runPage);
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
  const writer = createStatementWriter();
  console.log(writer ? 'AI statement summaries enabled.' : 'ANTHROPIC_API_KEY not set: statements use standard summaries.');
  createApp(config, db, { writer }).listen(config.port, () => {
    console.log(`${config.appName} running on http://localhost:${config.port}`);
  });
  if (config.autoBackups) scheduleBackups(db, config);
  // Keep the activity log to the last six months.
  activity.prune(db);
  setInterval(() => activity.prune(db), 24 * 60 * 60 * 1000).unref();
  // Last month's statements are produced automatically once the month ends.
  if (config.autoMonthlyStatements) {
    const run = () => runMonthlyJob(db, writer).catch((err) => console.error('Monthly statement job failed:', err));
    setTimeout(run, 30 * 1000);
    setInterval(run, 6 * 60 * 60 * 1000).unref();
  }
}

module.exports = { createApp, loadConfig, ensureAdmin };
