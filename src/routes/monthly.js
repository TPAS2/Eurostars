'use strict';

const express = require('express');
const fmt = require('../format');
const st = require('../statements');
const ledger = require('../ledger');
const { transaction } = require('../db');
const monthend = require('../monthend');
const { isEmail } = require('../mailer');

// Monthly landlord statements with AI-written summaries, and the month-end run:
// calculate rents, email every landlord their statement, and the CSV report.
module.exports = function monthlyRoutes(db, writer, mailer = { enabled: false }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get('/', (req, res) => {
    const a = req.user.id;
    const month = st.isMonth(req.query.month) ? req.query.month : st.previousMonth();
    const rows = db.prepare(
      `SELECT l.id AS landlord_id, l.name, l.email, s.id, s.rent_pence, s.fees_pence, s.expenses_pence, s.net_pence,
              s.closing_pence, s.summary_source, s.generated_at, s.emailed_at, s.emailed_to
         FROM landlords l
         LEFT JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
        WHERE l.account_id = ? ORDER BY l.name COLLATE NOCASE`
    ).all(month, a);
    const months = db.prepare('SELECT DISTINCT month FROM monthly_statements WHERE account_id = ? ORDER BY month DESC LIMIT 24').all(a).map((r) => r.month);
    res.render('monthly/index', {
      title: 'Monthly statements', section: 'monthly', month, monthLabel: st.monthLabel(month), rows, months,
      aiEnabled: !!writer, fmt,
      flash: String(req.query.flash || '').slice(0, 1000), error: String(req.query.error || '').slice(0, 1000),
    });
  });

  router.post('/generate', wrap(async (req, res) => {
    const a = req.user.id;
    const month = String(req.body.month || '');
    if (!st.isMonth(month)) return res.redirect('/app/monthly?flash=' + encodeURIComponent('Choose a valid month.'));
    const back = (msg) => res.redirect(`/app/monthly?month=${month}&flash=${encodeURIComponent(msg)}`);
    if (req.body.landlord_id) {
      const landlord = db.prepare('SELECT id FROM landlords WHERE id = ? AND account_id = ?').get(Number(req.body.landlord_id), a);
      if (!landlord) return back('Landlord not found.');
      const id = await st.generateStatement(db, { accountId: a, agencyName: req.user.agency_name, landlordId: landlord.id, month, writer });
      return res.redirect(`/app/monthly/${id}`);
    }
    const n = await st.generateForAccount(db, { accountId: a, agencyName: req.user.agency_name, month, writer });
    back(`Generated ${n} statement${n === 1 ? '' : 's'} for ${st.monthLabel(month)}.`);
  }));

  // ---------- month end ----------

  // The Rent run page (mounted at /app/rent-run): the month-end buttons and each landlord's status.
  router.runPage = (req, res) => {
    const a = req.user.id;
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const rows = db.prepare(
      `SELECT l.id AS landlord_id, l.name, l.email, s.id, s.rent_pence, s.fees_pence, s.expenses_pence, s.net_pence,
              s.closing_pence, s.emailed_at, s.emailed_to
         FROM landlords l
         LEFT JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
        WHERE l.account_id = ? ORDER BY l.name COLLATE NOCASE`
    ).all(month, a);
    const me = db.prepare('SELECT COALESCE(m.email, c.email) AS email FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?').get(req.user.person_id);
    res.render('rentrun', {
      title: 'Rent run', section: 'rentrun', month, monthLabel: st.monthLabel(month), rows,
      emailEnabled: mailer.enabled, reportTo: (me && me.email) || '', fmt,
      flash: String(req.query.flash || '').slice(0, 1000), error: String(req.query.error || '').slice(0, 1000),
    });
  };

  const monthFrom = (req) => (st.isMonth(req.body.month) ? String(req.body.month) : null);
  const backTo = (res, month, { flash, error } = {}) => {
    const q = new URLSearchParams({ month });
    if (flash) q.set('flash', flash);
    if (error) q.set('error', error);
    res.redirect(`/app/rent-run?${q}`);
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const listNames = (names) => (names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', '));

  // Step 1: raise any rent charges not yet raised for the month, then (re)calculate every statement.
  router.post('/calculate', wrap(async (req, res) => {
    const a = req.user.id;
    const month = monthFrom(req);
    if (!month) return backTo(res, st.previousMonth(), { error: 'Choose a valid month.' });
    const raised = transaction(db, () => ledger.raiseMonthlyRent(db, a, month));
    const n = await st.generateForAccount(db, { accountId: a, agencyName: req.user.agency_name, month, writer });
    backTo(res, month, { flash: `Raised ${plural(raised, 'new rent charge')} and calculated ${plural(n, 'statement')} for ${st.monthLabel(month)}.` });
  }));

  // Step 2: email each landlord their statement (or one landlord, from their row).
  router.post('/email', wrap(async (req, res) => {
    const a = req.user.id;
    const month = monthFrom(req);
    if (!month) return backTo(res, st.previousMonth(), { error: 'Choose a valid month.' });
    if (!mailer.enabled) return backTo(res, month, { error: 'Email isn’t set up yet, so nothing was sent. Ask your administrator to add the email settings.' });
    const one = req.body.landlord_id ? Number(req.body.landlord_id) : null;
    const skipSent = !one && req.body.skip_sent === '1';
    const landlords = db.prepare(`SELECT id, name, email FROM landlords WHERE account_id = ?${one ? ' AND id = ?' : ''} ORDER BY name COLLATE NOCASE`)
      .all(...(one ? [a, one] : [a]));
    if (one && !landlords.length) return backTo(res, month, { error: 'Landlord not found.' });
    const agency = db.prepare('SELECT agency_name, email FROM users WHERE id = ?').get(a);

    const sent = [];
    const noEmail = [];
    const already = [];
    const failed = [];
    for (const l of landlords) {
      if (!isEmail(l.email)) { noEmail.push(l.name); continue; }
      let s = db.prepare('SELECT * FROM monthly_statements WHERE account_id = ? AND landlord_id = ? AND month = ?').get(a, l.id, month);
      if (s && skipSent && s.emailed_at) { already.push(l.name); continue; }
      if (!s) {
        await st.generateStatement(db, { accountId: a, agencyName: req.user.agency_name, landlordId: l.id, month, writer });
        s = db.prepare('SELECT * FROM monthly_statements WHERE account_id = ? AND landlord_id = ? AND month = ?').get(a, l.id, month);
      }
      const email = monthend.statementEmail({ agencyName: agency.agency_name, statement: s, landlordName: l.name });
      try {
        await mailer.send({ to: l.email, ...email, fromName: agency.agency_name, replyTo: agency.email });
        db.prepare("UPDATE monthly_statements SET emailed_at = datetime('now'), emailed_to = ? WHERE id = ?").run(l.email, s.id);
        sent.push(l.name);
      } catch (err) {
        console.error(`Statement email to landlord ${l.id} failed:`, err.message);
        failed.push(`${l.name} (${String(err.message).slice(0, 80)})`);
      }
    }
    const parts = [`Emailed ${plural(sent.length, 'landlord')} their ${st.monthLabel(month)} statement.`];
    if (already.length) parts.push(`Skipped ${plural(already.length, 'landlord')} already emailed.`);
    if (noEmail.length) parts.push(`No email address for: ${listNames(noEmail)}.`);
    const error = failed.length ? `Couldn’t email: ${listNames(failed)}.` : null;
    backTo(res, month, { flash: parts.join(' '), error });
  }));

  // Step 3: the report, as a page to check and as a CSV download.
  router.get('/report', (req, res) => {
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const report = monthend.statementsReport(db, req.user.id, month);
    const me = db.prepare('SELECT COALESCE(m.email, c.email) AS email FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?').get(req.user.person_id);
    res.render('monthly/report', {
      title: `Statements report · ${report.monthLabel}`, section: 'rentrun', report, fmt, emailEnabled: mailer.enabled, reportTo: (me && me.email) || '',
      flash: String(req.query.flash || '').slice(0, 500), error: String(req.query.error || '').slice(0, 500),
    });
  });

  router.get('/report.csv', (req, res) => {
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const report = monthend.statementsReport(db, req.user.id, month);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="statements-${month}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(monthend.reportCsv(report));
  });

  // Step 4: email the CSV report.
  router.post('/report/email', wrap(async (req, res) => {
    const month = monthFrom(req);
    const back = (opts) => {
      if (req.body.back === 'report') {
        const q = new URLSearchParams({ month: month || st.previousMonth(), ...opts });
        return res.redirect(`/app/monthly/report?${q}`);
      }
      return backTo(res, month || st.previousMonth(), opts);
    };
    if (!month) return back({ error: 'Choose a valid month.' });
    if (!mailer.enabled) return back({ error: 'Email isn’t set up yet, so the report wasn’t sent. Download the CSV instead.' });
    const to = String(req.body.to || '').trim();
    if (!isEmail(to)) return back({ error: 'Enter the email address to send the report to.' });
    const report = monthend.statementsReport(db, req.user.id, month);
    if (!report.landlords.length) return back({ error: `There are no statements for ${report.monthLabel} yet. Calculate them first.` });
    const agency = db.prepare('SELECT agency_name, email FROM users WHERE id = ?').get(req.user.id);
    const email = monthend.reportEmail({ agencyName: agency.agency_name, report });
    try {
      await mailer.send({
        to, subject: email.subject, text: email.text, html: email.html, fromName: agency.agency_name, replyTo: agency.email,
        attachments: [{ filename: email.filename, content: monthend.reportCsv(report), contentType: 'text/csv' }],
      });
    } catch (err) {
      console.error('Report email failed:', err.message);
      return back({ error: `The report couldn’t be sent: ${String(err.message).slice(0, 120)}` });
    }
    back({ flash: `Emailed the ${report.monthLabel} statements report to ${to}.` });
  }));

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const s = Number.isInteger(id) && db.prepare(
      `SELECT s.*, l.name AS landlord_name, l.address AS landlord_address, l.email AS landlord_email
         FROM monthly_statements s JOIN landlords l ON l.id = s.landlord_id
        WHERE s.id = ? AND s.account_id = ?`
    ).get(id, req.user.id);
    if (!s) return res.status(404).render('error', { title: 'Not found', message: "That statement doesn't exist." });
    const detail = JSON.parse(s.detail_json);
    res.render('monthly/show', {
      title: `${s.landlord_name} · ${st.monthLabel(s.month)}`, section: 'monthly', s, detail,
      monthLabel: st.monthLabel(s.month), fmt,
    });
  });

  return router;
};
