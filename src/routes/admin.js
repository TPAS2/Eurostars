'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const fmt = require('../format');
const backup = require('../backup');
const auth = require('../auth');
const { USERNAME_RE, LOGIN_NAME_RE } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'support', 'letwise', 'nexus', 'system']);
const MIN_PASSWORD = 8;

// Owner-only area: every user of the software, their usage and login history.
// It deliberately shows usage counts, not the contents of agencies' records.
module.exports = function adminRoutes(db, config) {
  const router = express.Router();

  // A company is its main login row (company_id IS NULL) plus the people added to it.
  const PEOPLE = '(SELECT m.id FROM users m WHERE m.id = u.id OR m.company_id = u.id)';
  const USAGE_SQL = `
    SELECT u.id, u.username, u.email, u.phone, u.address, u.name, u.agency_name, u.is_admin, u.status, u.created_at,
           (SELECT MAX(last_login_at) FROM users m WHERE m.id = u.id OR m.company_id = u.id) AS last_login_at,
           (SELECT SUM(login_count) FROM users m WHERE m.id = u.id OR m.company_id = u.id) AS login_count,
           (SELECT COUNT(*) FROM users m WHERE m.company_id = u.id) AS people,
           (SELECT COUNT(*) FROM landlords  WHERE account_id = u.id) AS landlords,
           (SELECT COUNT(*) FROM properties WHERE account_id = u.id) AS properties,
           (SELECT COUNT(*) FROM tenants    WHERE account_id = u.id) AS tenants,
           (SELECT COUNT(*) FROM tenancies  WHERE account_id = u.id AND status = 'active') AS active_tenancies,
           (SELECT COUNT(*) FROM invoices   WHERE account_id = u.id) AS invoices,
           (SELECT COUNT(*) FROM sessions   WHERE user_id IN ${PEOPLE} AND expires_at > datetime('now')) AS live_sessions,
           (SELECT MAX(created_at) FROM activity_log WHERE user_id IN ${PEOPLE}) AS last_active,
           (SELECT COUNT(*) FROM activity_log WHERE user_id IN ${PEOPLE} AND action IN ('created', 'updated', 'deleted', 'downloaded') AND created_at >= datetime('now', '-7 days')) AS changes_7d,
           (SELECT COUNT(*) FROM activity_log WHERE user_id IN ${PEOPLE} AND created_at >= datetime('now', '-7 days')) AS actions_7d
      FROM users u`;

  router.get('/', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
    const where = ['u.company_id IS NULL'];
    const params = [];
    if (q) {
      where.push('(u.username LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR u.agency_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('u.status = ?'); params.push(status); }
    const users = db.prepare(`${USAGE_SQL} WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC`).all(...params);
    const n = (sql) => db.prepare(sql).get().n;
    const totals = {
      users: n('SELECT COUNT(*) n FROM users WHERE company_id IS NULL'),
      people: n('SELECT COUNT(*) n FROM users'),
      active30: n("SELECT COUNT(*) n FROM users WHERE last_login_at >= datetime('now', '-30 days')"),
      new30: n("SELECT COUNT(*) n FROM users WHERE created_at >= datetime('now', '-30 days')"),
      suspended: n("SELECT COUNT(*) n FROM users WHERE status = 'suspended'"),
      onlineNow: n("SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE expires_at > datetime('now')"),
      properties: n('SELECT COUNT(*) n FROM properties'),
      tenancies: n("SELECT COUNT(*) n FROM tenancies WHERE status = 'active'"),
      failedLogins24h: n("SELECT COUNT(*) n FROM login_events WHERE success = 0 AND created_at >= datetime('now', '-1 day')"),
    };
    const signups = db.prepare(
      "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS n FROM users GROUP BY month ORDER BY month DESC LIMIT 12"
    ).all().reverse();
    const recentLogins = db.prepare(
      `SELECT e.*, c.agency_name FROM login_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users c ON c.id = COALESCE(u.company_id, u.id)
        ORDER BY e.id DESC LIMIT 15`
    ).all();
    const recentActivity = db.prepare(
      `SELECT a.*, c.id AS company_id, c.username, c.agency_name, u.login_name, u.name AS person_name
         FROM activity_log a JOIN users u ON u.id = a.user_id JOIN users c ON c.id = COALESCE(u.company_id, u.id)
        WHERE a.user_id != ? ORDER BY a.id DESC LIMIT 25`
    ).all(req.user.id);
    res.render('admin/index', { title: 'Admin', section: 'admin', users, totals, signups, recentLogins, recentActivity, q, status, fmt, flash: req.query.flash || '' });
  });

  function target(req, res) {
    const id = Number(req.params.id);
    const u = Number.isInteger(id) && db.prepare(`${USAGE_SQL} WHERE u.id = ? AND u.company_id IS NULL`).get(id);
    if (!u) res.status(404).render('error', { title: 'Not found', message: 'No such user.' });
    return u || null;
  }

  // ---------- adding accounts (only the admin can) ----------

  router.get('/users/new', (req, res) => {
    res.render('admin/new-user', { title: 'Add account', section: 'admin', values: {}, errors: {}, minPassword: MIN_PASSWORD });
  });

  router.post('/users', (req, res) => {
    const values = {
      agency_name: String(req.body.agency_name || '').trim().slice(0, 200),
      name: String(req.body.name || '').trim().slice(0, 200),
      username: String(req.body.username || '').trim().toLowerCase().slice(0, 60),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 254),
    };
    const password = String(req.body.password || '');
    const errors = {};
    if (!values.agency_name) errors.agency_name = 'Enter the company name.';
    if (!values.name) errors.name = 'Enter the contact name.';
    if (!USERNAME_RE.test(values.username)) errors.username = 'Use 3–30 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    else if (RESERVED_USERNAMES.has(values.username) || values.username === config.adminUsername
      || db.prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) errors.username = 'That username is taken.';
    if (values.email && !EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address, or leave it blank.';
    else if (values.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.email = 'Another account uses this email.';
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (password.length > 200) errors.password = 'Password is too long.';
    if (Object.keys(errors).length) {
      return res.status(422).render('admin/new-user', { title: 'Add account', section: 'admin', values, errors, minPassword: MIN_PASSWORD });
    }
    const info = db.prepare('INSERT INTO users (username, email, name, agency_name, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(values.username, values.email || null, values.name, values.agency_name, auth.hashPassword(password));
    res.redirect(`/admin/users/${info.lastInsertRowid}?created=1`);
  });

  router.post('/users/:id/details', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const text = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
    const values = {
      name: text('name', 200), agency_name: text('agency_name', 200),
      email: text('email', 254).toLowerCase(), phone: text('phone', 50), address: text('address', 1000),
    };
    let error = '';
    if (!values.name) error = 'Enter the contact name.';
    else if (!values.agency_name) error = 'Enter the company name.';
    else if (values.email && !EMAIL_RE.test(values.email)) error = 'Enter a valid email address, or leave it blank.';
    else if (values.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(values.email, u.id)) error = 'Another account already uses this email.';
    if (error) return res.redirect(`/admin/users/${u.id}?error=${encodeURIComponent(error)}#details`);
    db.prepare('UPDATE users SET name = ?, agency_name = ?, email = ?, phone = ?, address = ? WHERE id = ?')
      .run(values.name, values.agency_name, values.email || null, values.phone || null, values.address || null, u.id);
    res.redirect(`/admin/users/${u.id}?flash=${encodeURIComponent('Account details saved.')}#details`);
  });

  router.post('/users/:id/password', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const password = String(req.body.password || '');
    if (password.length < MIN_PASSWORD || password.length > 200) {
      return res.redirect(`/admin/users/${u.id}?error=` + encodeURIComponent(`The new password must be at least ${MIN_PASSWORD} characters.`));
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), u.id);
    if (u.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.redirect(`/admin/users/${u.id}?flash=` + encodeURIComponent(`Password changed for @${u.username}.` + (u.id !== req.user.id ? ' They have been signed out and must use the new password.' : '')));
  });

  // ---------- people inside a company (only the admin adds them) ----------

  router.post('/users/:id/people', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const name = String(req.body.name || '').trim().slice(0, 200);
    const loginName = String(req.body.login_name || '').trim().toLowerCase().slice(0, 60);
    const password = String(req.body.password || '');
    const back = (msg, ok) => res.redirect(`/admin/users/${u.id}?${ok ? 'flash' : 'error'}=${encodeURIComponent(msg)}#people`);
    if (!name) return back('Enter the person\'s full name.');
    if (!LOGIN_NAME_RE.test(loginName)) return back('Their sign-in name must be 1–30 letters, numbers, dashes or underscores (no spaces or dots).');
    if (db.prepare('SELECT 1 FROM users WHERE company_id = ? AND login_name = ?').get(u.id, loginName)) return back(`${u.agency_name} already has someone called "${loginName}".`);
    if (password.length < MIN_PASSWORD || password.length > 200) return back(`Their password must be at least ${MIN_PASSWORD} characters.`);
    db.prepare('INSERT INTO users (username, company_id, login_name, name, agency_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${u.username}.${loginName}`, u.id, loginName, name, u.agency_name, auth.hashPassword(password));
    back(`Added ${name}. They sign in with username "${u.username}", name "${loginName}" and the password you chose.`, true);
  });

  function person(req, res) {
    const id = Number(req.params.pid);
    const m = Number.isInteger(id) && db.prepare('SELECT * FROM users WHERE id = ? AND company_id IS NOT NULL').get(id);
    if (!m) res.status(404).render('error', { title: 'Not found', message: 'No such person.' });
    return m || null;
  }

  router.post('/people/:pid/password', (req, res) => {
    const m = person(req, res);
    if (!m) return;
    const password = String(req.body.password || '');
    const back = (msg, ok) => res.redirect(`/admin/users/${m.company_id}?${ok ? 'flash' : 'error'}=${encodeURIComponent(msg)}#people`);
    if (password.length < MIN_PASSWORD || password.length > 200) return back(`The new password must be at least ${MIN_PASSWORD} characters.`);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), m.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(m.id);
    back(`Password changed for ${m.name}. They have been signed out and must use the new password.`, true);
  });

  router.post('/people/:pid/:change(suspend|activate|delete)', (req, res) => {
    const m = person(req, res);
    if (!m) return;
    const change = req.params.change;
    if (change === 'delete') db.prepare('DELETE FROM users WHERE id = ?').run(m.id);
    else db.prepare('UPDATE users SET status = ? WHERE id = ?').run(change === 'suspend' ? 'suspended' : 'active', m.id);
    if (change !== 'activate') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(m.id);
    const done = { suspend: 'Suspended', activate: 'Reactivated', delete: 'Removed' }[change];
    res.redirect(`/admin/users/${m.company_id}?flash=${encodeURIComponent(`${done} ${m.name}.`)}#people`);
  });

  router.get('/users/:id', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const people = db.prepare(
      `SELECT m.*, (SELECT MAX(created_at) FROM activity_log WHERE user_id = m.id) AS last_active
         FROM users m WHERE m.id = ? OR m.company_id = ? ORDER BY m.company_id IS NOT NULL, m.name COLLATE NOCASE`
    ).all(u.id, u.id);
    const logins = db.prepare(
      `SELECT e.*, m.name AS person_name, m.login_name FROM login_events e JOIN users m ON m.id = e.user_id
        WHERE m.id = ? OR m.company_id = ? ORDER BY e.id DESC LIMIT 50`
    ).all(u.id, u.id);
    const activityFilter = req.query.activity === 'changes' ? 'changes' : 'all';
    const who = Number(req.query.person);
    const activityRows = db.prepare(
      `SELECT a.*, m.name AS person_name, m.login_name FROM activity_log a JOIN users m ON m.id = a.user_id
        WHERE (m.id = ? OR m.company_id = ?)
          ${Number.isInteger(who) && who > 0 ? 'AND m.id = ' + who : ''}
          ${activityFilter === 'changes' ? "AND a.action IN ('created', 'updated', 'deleted', 'downloaded')" : ''}
        ORDER BY a.id DESC LIMIT 300`
    ).all(u.id, u.id);
    const extra = db.prepare(
      `SELECT (SELECT COUNT(*) FROM maintenance_jobs WHERE account_id = ?) AS jobs,
              (SELECT COUNT(*) FROM compliance_items WHERE account_id = ?) AS certificates,
              (SELECT COUNT(*) FROM transactions WHERE account_id = ?) AS transactions,
              (SELECT MAX(created_at) FROM transactions WHERE account_id = ?) AS last_txn`
    ).get(u.id, u.id, u.id, u.id);
    res.render('admin/user', {
      title: u.agency_name, section: 'admin', u, logins, extra, fmt, isSelf: u.id === req.user.id, activityRows, activityFilter,
      people, personFilter: Number.isInteger(who) && who > 0 ? who : null,
      created: req.query.created === '1', flash: req.query.flash || '', error: req.query.error || '', minPassword: MIN_PASSWORD,
    });
  });

  function guardSelf(req, res, u) {
    if (u.id === req.user.id || u.is_admin) {
      res.redirect('/admin?flash=' + encodeURIComponent("You can't suspend or delete the admin account."));
      return false;
    }
    return true;
  }

  router.post('/users/:id/suspend', (req, res) => {
    const u = target(req, res);
    if (!u || !guardSelf(req, res, u)) return;
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(u.id);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR company_id = ?)`).run(u.id, u.id);
    res.redirect(`/admin/users/${u.id}`);
  });

  router.post('/users/:id/activate', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(u.id);
    res.redirect(`/admin/users/${u.id}`);
  });

  router.post('/users/:id/logout', (req, res) => {
    const u = target(req, res);
    if (!u || !guardSelf(req, res, u)) return;
    db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR company_id = ?)`).run(u.id, u.id);
    res.redirect(`/admin/users/${u.id}`);
  });

  router.post('/users/:id/delete', (req, res) => {
    const u = target(req, res);
    if (!u || !guardSelf(req, res, u)) return;
    if (String(req.body.confirm_username || '').trim().toLowerCase() !== u.username.toLowerCase()) {
      return res.redirect(`/admin/users/${u.id}?error=confirm`);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    fs.rmSync(path.join(config.uploadDir, String(u.id)), { recursive: true, force: true });
    res.redirect('/admin?flash=' + encodeURIComponent(`Deleted ${u.username} (${u.agency_name}) and all of their data.`));
  });

  // ---------- backups ----------

  router.get('/backups', (req, res) => {
    res.render('admin/backups', {
      title: 'Backups', section: 'backups', backups: backup.listBackups(config), config, fmt,
      flash: req.query.flash || '', error: req.query.error || '',
    });
  });

  router.post('/backups', (req, res, next) => {
    backup.createBackup(db, config, { reason: `manual by ${req.user.username}` })
      .then((b) => res.redirect('/admin/backups?flash=' + encodeURIComponent(`Backup created: ${b.name}`)))
      .catch((err) => { console.error(err); res.redirect('/admin/backups?error=' + encodeURIComponent('Backup failed: ' + err.message)); })
      .catch(next);
  });

  router.get('/backups/:name', (req, res) => {
    const file = backup.backupPath(config, req.params.name);
    if (!file) return res.status(404).render('error', { title: 'Not found', message: 'No such backup.' });
    res.download(file, req.params.name);
  });

  router.get('/users.csv', (req, res) => {
    const users = db.prepare(`${USAGE_SQL} WHERE u.company_id IS NULL ORDER BY u.created_at`).all();
    const cols = ['id', 'username', 'people', 'email', 'name', 'agency_name', 'status', 'created_at', 'last_login_at', 'login_count', 'landlords', 'properties', 'tenants', 'active_tenancies'];
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...users.map((u) => cols.map((c) => cell(u[c])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="users-${fmt.today()}.csv"`);
    res.send(csv);
  });

  return router;
};
