'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const fmt = require('../format');
const backup = require('../backup');

// Owner-only area: every user of the software, their usage and login history.
// It deliberately shows usage counts, not the contents of agencies' records.
module.exports = function adminRoutes(db, config) {
  const router = express.Router();

  const USAGE_SQL = `
    SELECT u.id, u.username, u.email, u.name, u.agency_name, u.is_admin, u.status, u.created_at, u.last_login_at, u.login_count,
           (SELECT COUNT(*) FROM landlords  WHERE account_id = u.id) AS landlords,
           (SELECT COUNT(*) FROM properties WHERE account_id = u.id) AS properties,
           (SELECT COUNT(*) FROM tenants    WHERE account_id = u.id) AS tenants,
           (SELECT COUNT(*) FROM tenancies  WHERE account_id = u.id AND status = 'active') AS active_tenancies,
           (SELECT COUNT(*) FROM invoices   WHERE account_id = u.id) AS invoices,
           (SELECT COUNT(*) FROM sessions   WHERE user_id = u.id AND expires_at > datetime('now')) AS live_sessions
      FROM users u`;

  router.get('/', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
    const where = [];
    const params = [];
    if (q) {
      where.push('(u.username LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR u.agency_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('u.status = ?'); params.push(status); }
    const users = db.prepare(`${USAGE_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC`).all(...params);
    const n = (sql) => db.prepare(sql).get().n;
    const totals = {
      users: n('SELECT COUNT(*) n FROM users'),
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
      `SELECT e.*, u.agency_name FROM login_events e LEFT JOIN users u ON u.id = e.user_id
        ORDER BY e.id DESC LIMIT 15`
    ).all();
    res.render('admin/index', { title: 'Admin', section: 'admin', users, totals, signups, recentLogins, q, status, fmt, flash: req.query.flash || '' });
  });

  function target(req, res) {
    const id = Number(req.params.id);
    const u = Number.isInteger(id) && db.prepare(`${USAGE_SQL} WHERE u.id = ?`).get(id);
    if (!u) res.status(404).render('error', { title: 'Not found', message: 'No such user.' });
    return u || null;
  }

  router.get('/users/:id', (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const logins = db.prepare('SELECT * FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id);
    const extra = db.prepare(
      `SELECT (SELECT COUNT(*) FROM maintenance_jobs WHERE account_id = ?) AS jobs,
              (SELECT COUNT(*) FROM compliance_items WHERE account_id = ?) AS certificates,
              (SELECT COUNT(*) FROM transactions WHERE account_id = ?) AS transactions,
              (SELECT MAX(created_at) FROM transactions WHERE account_id = ?) AS last_txn`
    ).get(u.id, u.id, u.id, u.id);
    res.render('admin/user', { title: u.agency_name, section: 'admin', u, logins, extra, fmt, isSelf: u.id === req.user.id });
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
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
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
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
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
    const users = db.prepare(`${USAGE_SQL} ORDER BY u.created_at`).all();
    const cols = ['id', 'username', 'email', 'name', 'agency_name', 'status', 'created_at', 'last_login_at', 'login_count', 'landlords', 'properties', 'tenants', 'active_tenancies'];
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
