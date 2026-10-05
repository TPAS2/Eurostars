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
      title: 'Landlord statements', section: 'monthly', month, thisMonth: fmt.today().slice(0, 7), monthLabel: st.monthLabel(month), rows, months,
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
  const senderFor = (accountId) => require('../sender').senderFor(db, mailer, accountId);

  router.post('/email/settings', (req, res) => {
    const month = st.isMonth(req.body.month) ? String(req.body.month) : st.previousMonth();
    const from = String(req.body.from_email || '').trim().slice(0, 254);
    const name = String(req.body.from_name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const replyTo = String(req.body.reply_to || '').trim().slice(0, 254);
    if (from && !isEmail(from)) return backTo(res, month, { error: 'The “Send from” address isn’t a valid email address.' });
    if (replyTo && !isEmail(replyTo)) return backTo(res, month, { error: 'The “Replies go to” address isn’t a valid email address.' });
    db.prepare('UPDATE users SET statement_from_email = ?, statement_from_name = ?, statement_reply_to = ? WHERE id = ?')
      .run(from || null, name || null, replyTo || null, req.user.id);
    backTo(res, month, { flash: 'Saved who statement emails come from.' });
  });

  router.runPage = (req, res) => {
    const a = req.user.id;
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const rows = db.prepare(
      `SELECT l.id AS landlord_id, l.name, l.email, l.statement_type, s.id, s.rent_pence, s.fees_pence, s.expenses_pence, s.net_pence,
              s.closing_pence, s.emailed_at, s.emailed_to
         FROM landlords l
         LEFT JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
        WHERE l.account_id = ? ORDER BY l.name COLLATE NOCASE`
    ).all(month, a);
    const me = db.prepare('SELECT COALESCE(m.email, c.email) AS email FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?').get(req.user.person_id);
    const template = db.prepare('SELECT filename, uploaded_at FROM payment_templates WHERE account_id = ?').get(a) || null;
    res.render('rentrun', {
      title: 'Rent run', section: 'rentrun', month, thisMonth: fmt.today().slice(0, 7), monthLabel: st.monthLabel(month), rows, template,
      emailEnabled: mailer.enabled, reportTo: (me && me.email) || '', sender: senderFor(a), fmt,
      step5: require('../paymentInstruction')(db).formFor(req.user, month),
      bulkFile: require('../bulkPayment').bulkRows(db, a, month),
      transferFile: require('../bulkPayment').transferRows(db, a, month),
      metroPresets: db.prepare('SELECT id, name, data_json FROM metro_presets WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(a)
        .map((p) => ({ id: p.id, name: p.name, data: JSON.parse(p.data_json) })),
      metroDocs: db.prepare(
        `SELECT d.id, d.month, d.filename, d.total_pence, d.payments, d.created_at, u.name AS created_by_name
           FROM metro_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.account_id = ? ORDER BY d.created_at DESC, d.id DESC`
      ).all(a).map((d) => ({ ...d, monthLabel: st.monthLabel(d.month) })),
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
    const { raised, credited } = transaction(db, () => ({ raised: ledger.raiseMonthlyRent(db, a, month), credited: ledger.creditLandlordRent(db, a, month) }));
    const n = await st.generateForAccount(db, { accountId: a, agencyName: req.user.agency_name, month, writer });
    backTo(res, month, { flash: `Raised ${plural(raised, 'new rent charge')}${credited ? `, credited ${plural(credited, 'landlord rent payment')}` : ''} and calculated ${plural(n, 'statement')} for ${st.monthLabel(month)}. The Rift report is ready below.` });
  }));

  // Step 2: email each landlord their statement (or one landlord, from their row).
  router.post('/email', wrap(async (req, res) => {
    const a = req.user.id;
    const month = monthFrom(req);
    if (!month) return backTo(res, st.previousMonth(), { error: 'Choose a valid month.' });
    if (!mailer.enabled) return backTo(res, month, { error: 'Email isn’t set up yet, so nothing was sent. Ask your administrator to add the email settings.' });
    const one = req.body.landlord_id ? Number(req.body.landlord_id) : null;
    const skipSent = !one && req.body.skip_sent === '1';
    const landlords = db.prepare(`SELECT id, name, email, statement_type FROM landlords WHERE account_id = ?${one ? ' AND id = ?' : ''} ORDER BY name COLLATE NOCASE`)
      .all(...(one ? [a, one] : [a]));
    if (one && !landlords.length) return backTo(res, month, { error: 'Landlord not found.' });
    const agency = db.prepare('SELECT agency_name, email FROM users WHERE id = ?').get(a);
    const sender = senderFor(a);

    const sent = [];
    const noEmail = [];
    const already = [];
    const failed = [];
    const byCheque = [];
    for (const l of landlords) {
      // Cheque landlords get a printed statement, so they're left out of the email run.
      if (!one && l.statement_type === 'Cheque') { byCheque.push(l.name); continue; }
      if (!isEmail(l.email)) { noEmail.push(l.name); continue; }
      let s = db.prepare('SELECT * FROM monthly_statements WHERE account_id = ? AND landlord_id = ? AND month = ?').get(a, l.id, month);
      if (s && skipSent && s.emailed_at) { already.push(l.name); continue; }
      if (!s) {
        await st.generateStatement(db, { accountId: a, agencyName: req.user.agency_name, landlordId: l.id, month, writer });
        s = db.prepare('SELECT * FROM monthly_statements WHERE account_id = ? AND landlord_id = ? AND month = ?').get(a, l.id, month);
      }
      const email = monthend.statementEmail({ agencyName: agency.agency_name, statement: s, landlordName: l.name });
      try {
        await mailer.send({ to: l.email, ...email, from: sender.from, fromName: sender.fromName, replyTo: sender.replyTo });
        db.prepare("UPDATE monthly_statements SET emailed_at = datetime('now'), emailed_to = ? WHERE id = ?").run(l.email, s.id);
        sent.push(l.name);
      } catch (err) {
        console.error(`Statement email to landlord ${l.id} failed:`, err.message);
        failed.push(`${l.name} (${String(err.message).slice(0, 80)})`);
      }
    }
    const parts = [`Emailed ${plural(sent.length, 'landlord')} their ${st.monthLabel(month)} statement.`];
    if (already.length) parts.push(`Skipped ${plural(already.length, 'landlord')} already emailed.`);
    if (byCheque.length) parts.push(`Left out ${plural(byCheque.length, 'landlord')} paid by cheque (print their statements): ${listNames(byCheque)}.`);
    if (noEmail.length) parts.push(`No email address for: ${listNames(noEmail)}.`);
    const error = failed.length ? `Couldn’t email: ${listNames(failed)}.` : null;
    backTo(res, month, { flash: parts.join(' '), error });
  }));

  // Steps 3 and 4: the Rift report (an Excel workbook), as a page to check, a download and an email.
  router.get('/report', (req, res) => {
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const report = monthend.cfpReport(db, req.user.id, month);
    const missing = db.prepare(
      `SELECT COUNT(*) AS n FROM landlords l WHERE l.account_id = ?
         AND NOT EXISTS (SELECT 1 FROM monthly_statements s WHERE s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?)`
    ).get(req.user.id, month).n;
    const me = db.prepare('SELECT COALESCE(m.email, c.email) AS email FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?').get(req.user.person_id);
    res.render('monthly/report', {
      title: report.label, section: 'rentrun', report, missing, fmt, emailEnabled: mailer.enabled, reportTo: (me && me.email) || '',
      step: req.query.step === '4' ? 4 : 3,
      flash: String(req.query.flash || '').slice(0, 500), error: String(req.query.error || '').slice(0, 500),
    });
  });

  router.get('/report.xlsx', wrap(async (req, res) => {
    const month = st.isMonth(req.query.month) ? String(req.query.month) : st.previousMonth();
    const report = monthend.cfpReport(db, req.user.id, month);
    const xlsx = await monthend.cfpWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(xlsx);
  }));

  // Step 4: email the report, with the workbook attached.
  router.post('/report/email', wrap(async (req, res) => {
    const month = monthFrom(req);
    const back = (opts) => {
      if (req.body.back === 'report') {
        const q = new URLSearchParams({ month: month || st.previousMonth(), step: '4', ...opts });
        return res.redirect(`/app/monthly/report?${q}`);
      }
      return backTo(res, month || st.previousMonth(), opts);
    };
    if (!month) return back({ error: 'Choose a valid month.' });
    if (!mailer.enabled) return back({ error: 'Email isn’t set up yet, so the report wasn’t sent. Download it instead.' });
    const to = String(req.body.to || '').trim();
    if (!isEmail(to)) return back({ error: 'Enter the email address to send the report to.' });
    const report = monthend.cfpReport(db, req.user.id, month);
    if (!report.rows.length) return back({ error: `There's nothing to report for ${report.monthLabel} yet. Calculate the rents first.` });
    const agency = db.prepare('SELECT agency_name, email FROM users WHERE id = ?').get(req.user.id);
    const email = monthend.cfpEmail({ agencyName: agency.agency_name, report });
    const sender = senderFor(req.user.id);
    try {
      await mailer.send({
        to, subject: email.subject, text: email.text, html: email.html, from: sender.from, fromName: sender.fromName, replyTo: sender.replyTo,
        attachments: [{ filename: email.filename, content: await monthend.cfpWorkbook(report), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      });
    } catch (err) {
      console.error('Report email failed:', err.message);
      return back({ error: `The report couldn’t be sent: ${String(err.message).slice(0, 120)}` });
    }
    back({ flash: `Emailed the ${report.label} to ${to}.` });
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
