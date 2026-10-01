'use strict';

// Landlord invoices: bills the agency raises to its landlords. Each can be printed or emailed,
// marked paid by the landlord, or deducted from their rent (a fee on their monthly statement).

const express = require('express');
const fmt = require('../format');
const st = require('../statements');
const { transaction } = require('../db');
const { isEmail } = require('../mailer');

module.exports = function landlordInvoiceRoutes(db, mailer = { enabled: false }) {
  const router = express.Router();
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  const MAX_MONTHS = 24;
  // Splits pence into n parts; any odd pence go on the first.
  const instalments = (pence, n) => { const base = Math.floor(pence / n); return Array.from({ length: n }, (_, i) => base + (i === 0 ? pence - base * n : 0)); };
  // The same day n months later (the last day if that month is shorter).
  const addMonths = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    const t = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last)));
    return t.toISOString().slice(0, 10);
  };

  const LIST_SQL = `
    SELECT li.*, l.name AS landlord_name, l.code AS landlord_code, l.email AS landlord_email, l.address AS landlord_address,
           p.address_line1, ms.id AS statement_id, tx.txn_date AS deducted_on
      FROM landlord_invoices li
      JOIN landlords l ON l.id = li.landlord_id
      LEFT JOIN properties p ON p.id = li.property_id
      LEFT JOIN transactions tx ON tx.id = li.txn_id
      LEFT JOIN monthly_statements ms ON ms.account_id = li.account_id AND ms.landlord_id = li.landlord_id AND ms.month = substr(tx.txn_date, 1, 7)`;

  const statementLink = (inv) => (!inv.txn_id ? null : inv.statement_id ? `/app/monthly/${inv.statement_id}` : `/app/monthly?month=${inv.deducted_on.slice(0, 7)}`);

  function load(req, res) {
    const id = Number(req.params.id);
    const inv = Number.isInteger(id) && db.prepare(`${LIST_SQL} WHERE li.id = ? AND li.account_id = ?`).get(id, req.user.id);
    if (!inv) res.status(404).render('error', { title: 'Not found', message: 'That landlord invoice was not found.' });
    return inv || null;
  }

  function nextNumber(accountId) {
    const rows = db.prepare('SELECT invoice_number FROM landlord_invoices WHERE account_id = ?').all(accountId);
    const n = rows.reduce((max, r) => Math.max(max, Number((r.invoice_number.match(/(\d+)\s*$/) || [0, 0])[1])), 0);
    return `LI-${String(n + 1).padStart(4, '0')}`;
  }

  const options = (accountId) => ({
    landlords: db.prepare('SELECT id, name, code FROM landlords WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId),
    properties: db.prepare('SELECT id, address_line1, landlord_id FROM properties WHERE account_id = ? ORDER BY address_line1 COLLATE NOCASE').all(accountId),
  });

  function parse(body, accountId) {
    const v = {
      landlord_id: Number(body.landlord_id) || null,
      property_id: Number(body.property_id) || null,
      invoice_date: clip(body.invoice_date, 10),
      due_date: clip(body.due_date, 10) || null,
      description: clip(body.description, 500),
      notes: clip(body.notes, 2000) || null,
    };
    const errors = {};
    if (!v.landlord_id || !db.prepare('SELECT 1 FROM landlords WHERE id = ? AND account_id = ?').get(v.landlord_id, accountId)) errors.landlord_id = 'Choose the landlord to bill.';
    // Every section of the form must be filled in.
    if (!v.property_id) errors.property_id = 'Choose the property.';
    if (v.property_id && !db.prepare('SELECT 1 FROM properties WHERE id = ? AND account_id = ?').get(v.property_id, accountId)) errors.property_id = 'Choose a valid property.';
    if (!fmt.isIsoDate(v.invoice_date)) errors.invoice_date = 'Enter the invoice date.';
    if (v.due_date && !fmt.isIsoDate(v.due_date)) errors.due_date = 'Enter a valid due date.';
    if (!v.description) errors.description = 'Say what the invoice is for.';
    v.amount_pence = fmt.parseMoney(body.amount);
    if (Number.isNaN(v.amount_pence) || v.amount_pence <= 0) errors.amount = 'Enter the amount, like 120 or 120.00.';
    // Paid over how many months (the rent deduction is split across them).
    const months = Number(body.months || 1);
    if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) errors.months = `Choose 1 to ${MAX_MONTHS} months.`;
    else v.months = months;
    return { v, errors };
  }

  const renderForm = (req, res, { inv, values, errors, status = 200 }) => res.status(status).render('landlordinvoices/form', {
    title: inv ? `Edit ${inv.invoice_number}` : 'New landlord invoice', section: 'landlordinvoices', inv, values, errors, ...options(req.user.id), fmt,
  });

  // ---------- list ----------

  router.get('/', (req, res) => {
    const a = req.user.id;
    const today = fmt.today();
    const thisMonth = today.slice(0, 7);
    const status = ['unpaid', 'paid'].includes(req.query.status) ? req.query.status : 'all';
    const month = req.query.month === 'all' ? 'all' : st.isMonth(req.query.month) ? String(req.query.month) : status === 'unpaid' ? 'all' : thisMonth;
    let where = 'li.account_id = ?';
    const params = [a];
    if (month !== 'all') { where += ' AND substr(li.invoice_date, 1, 7) = ?'; params.push(month); }
    if (status !== 'all') { where += ' AND li.status = ?'; params.push(status); }
    const invoices = db.prepare(`${LIST_SQL} WHERE ${where} ORDER BY li.invoice_date DESC, li.id DESC LIMIT 500`).all(...params);
    const totals = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_pence END), 0) AS unpaid, COUNT(CASE WHEN status = 'unpaid' THEN 1 END) AS unpaid_n,
              COALESCE(SUM(CASE WHEN status = 'unpaid' AND due_date < ? THEN amount_pence END), 0) AS overdue
         FROM landlord_invoices WHERE account_id = ?`
    ).get(today, a);
    // The chosen month's unpaid and paid invoices (by invoice date), like the contractor invoices.
    const monthTotals = month === 'all' ? null : db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_pence END), 0) AS unpaid, COUNT(CASE WHEN status = 'unpaid' THEN 1 END) AS unpaid_n,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_pence END), 0) AS paid, COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_n
         FROM landlord_invoices WHERE account_id = ? AND substr(invoice_date, 1, 7) = ?`
    ).get(a, month);
    const shift = (by) => { const [y, m] = (month === 'all' ? thisMonth : month).split('-').map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };
    // Profit from contractor invoices: what the landlord was charged minus what the contractor
    // charged us, on paid invoices that were charged to a landlord (by the date they were paid).
    const profitMonth = month === 'all' ? thisMonth : month;
    const profitSql = `SELECT COALESCE(SUM(COALESCE(landlord_price_pence, amount_pence) - amount_pence), 0) AS profit, COUNT(*) AS n
                         FROM invoices WHERE account_id = ? AND status = 'paid' AND charge_landlord = 1`;
    const profit = {
      month: db.prepare(`${profitSql} AND substr(paid_date, 1, 7) = ?`).get(a, profitMonth),
      all: db.prepare(profitSql).get(a),
      monthLabel: st.monthLabel(profitMonth),
    };
    res.render('landlordinvoices/list', {
      profit,
      title: 'Landlord invoices', section: 'landlordinvoices', invoices, totals, monthTotals, status, month, prev: shift(-1), next: shift(1), thisMonth,
      monthLabel: month === 'all' ? 'All months' : st.monthLabel(month), statementLink, today, fmt, flash: clip(req.query.flash, 300),
    });
  });

  // ---------- create / edit ----------

  router.get('/new', (req, res) => {
    const values = { invoice_number: nextNumber(req.user.id), invoice_date: fmt.today() };
    const ll = Number(req.query.landlord_id);
    if (ll) values.landlord_id = ll;
    const prop = Number(req.query.property_id) && db.prepare('SELECT id, landlord_id FROM properties WHERE id = ? AND account_id = ?').get(Number(req.query.property_id), req.user.id);
    if (prop) { values.property_id = prop.id; values.landlord_id = values.landlord_id || prop.landlord_id; }
    renderForm(req, res, { inv: null, values, errors: {} });
  });

  router.post('/', (req, res) => {
    const a = req.user.id;
    const { v, errors } = parse(req.body, a);
    if (Object.keys(errors).length) return renderForm(req, res, { inv: null, values: { ...req.body, invoice_number: nextNumber(a) }, errors, status: 422 });
    const wanted = clip(req.body.invoice_number, 30);
    if (wanted && db.prepare('SELECT 1 FROM landlord_invoices WHERE account_id = ? AND invoice_number = ?').get(a, wanted)) {
      return renderForm(req, res, { inv: null, values: req.body, errors: { invoice_number: `${wanted} is already used.` }, status: 422 });
    }
    v.invoice_number = wanted || nextNumber(a); // LI- and the next number unless changed
    const cols = Object.keys(v);
    const info = db.prepare(`INSERT INTO landlord_invoices (account_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(a, ...cols.map((c) => v[c]));
    const id = Number(info.lastInsertRowid);
    // "Create & deduct from rent": taken off their rent for the month of the invoice date.
    if (req.body.then === 'deduct') {
      deduct(a, { id, ...v }, v.invoice_date);
      const ll = db.prepare('SELECT name FROM landlords WHERE id = ?').get(v.landlord_id);
      const when = v.months > 1 ? `over ${v.months} months from ${st.monthLabel(v.invoice_date.slice(0, 7))}` : `for ${st.monthLabel(v.invoice_date.slice(0, 7))}`;
      return res.redirect(`/app/landlord-invoices/${id}?flash=${encodeURIComponent(`Created and deducted ${fmt.money(v.amount_pence)} from ${ll.name}'s rent ${when}.`)}`);
    }
    res.redirect(`/app/landlord-invoices/${id}`);
  });

  router.get('/:id(\\d+)', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    const agency = db.prepare('SELECT agency_name, email, phone, address FROM users WHERE id = ?').get(req.user.id);
    res.render('landlordinvoices/show', {
      title: `Landlord invoice ${inv.invoice_number}`, section: 'landlordinvoices', inv, agency, statementLink, emailEnabled: mailer.enabled,
      doc: invoiceDoc(req.user.id, inv).data, longDate: require('../jobInvoice').longDate,
      schedule: schedule(inv),
      today: fmt.today(), fmt, flash: clip(req.query.flash, 300), error: clip(req.query.error, 300),
    });
  });

  router.get('/:id(\\d+)/edit', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    renderForm(req, res, { inv, values: { ...inv, amount: fmt.penceToInput(inv.amount_pence) }, errors: {} });
  });

  router.post('/:id(\\d+)', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    const a = req.user.id;
    const { v, errors } = parse(req.body, a);
    if (Object.keys(errors).length) return renderForm(req, res, { inv, values: { ...req.body, invoice_number: inv.invoice_number }, errors, status: 422 });
    const wanted = clip(req.body.invoice_number, 30);
    if (wanted && wanted !== inv.invoice_number && db.prepare('SELECT 1 FROM landlord_invoices WHERE account_id = ? AND invoice_number = ? AND id != ?').get(a, wanted, inv.id)) {
      return renderForm(req, res, { inv, values: req.body, errors: { invoice_number: `${wanted} is already used.` }, status: 422 });
    }
    v.invoice_number = wanted || inv.invoice_number;
    const cols = Object.keys(v);
    transaction(db, () => {
      db.prepare(`UPDATE landlord_invoices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND account_id = ?`).run(...cols.map((c) => v[c]), inv.id, a);
    });
    // Already deducted: redo the deductions so they match the invoice (amount, months).
    if (inv.txn_id) {
      removeDeductions(a, inv);
      deduct(a, { ...inv, ...v }, inv.paid_date);
    }
    res.redirect(`/app/landlord-invoices/${inv.id}`);
  });

  router.post('/:id(\\d+)/delete', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    transaction(db, () => {
      removeDeductions(req.user.id, inv);
      db.prepare('DELETE FROM landlord_invoices WHERE id = ? AND account_id = ?').run(inv.id, req.user.id);
    });
    res.redirect(`/app/landlord-invoices?flash=${encodeURIComponent(`Deleted invoice ${inv.invoice_number}.`)}`);
  });

  // ---------- settling ----------

  // Taken off the landlord's rent: a fee on their statement for the month of `date`.
  // Take the invoice off the landlord's rent: in one go, or split over several months
  // (one deduction a month from the given date; any odd pence go on the first).
  function deduct(a, inv, date) {
    const n = Math.max(1, Number(inv.months) || 1);
    const parts = instalments(inv.amount_pence, n);
    transaction(db, () => {
      const ids = parts.map((pence, i) => Number(db.prepare(
        `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, description, amount_pence)
         VALUES (?, ?, 'fee', ?, ?, ?, ?)`
      ).run(a, addMonths(date, i), inv.landlord_id, inv.property_id,
        `Invoice ${inv.invoice_number} — ${inv.description}${n > 1 ? ` (${i + 1} of ${n})` : ''}`.slice(0, 200), pence).lastInsertRowid));
      db.prepare("UPDATE landlord_invoices SET status = 'paid', paid_date = ?, paid_how = 'Deducted from rent', txn_id = ?, instalment_txn_ids = ? WHERE id = ? AND account_id = ?")
        .run(date, ids[0], ids.length > 1 ? JSON.stringify(ids.slice(1)) : null, inv.id, a);
    });
  }

  // The invoice's instalments: the actual deductions once made, else the planned split.
  function deductionIds(inv) { return [inv.txn_id, ...JSON.parse(inv.instalment_txn_ids || '[]')].filter(Boolean); }
  function schedule(inv) {
    if (inv.months <= 1 && !inv.instalment_txn_ids) return null;
    if (inv.txn_id) {
      return deductionIds(inv).map((id, i) => db.prepare('SELECT id, txn_date, amount_pence FROM transactions WHERE id = ? AND account_id = ?').get(id, inv.account_id))
        .filter(Boolean).map((t, i) => ({ n: i + 1, txnId: t.id, pence: t.amount_pence, date: t.txn_date, month: st.monthLabel(t.txn_date.slice(0, 7)), done: t.txn_date <= fmt.today() }));
    }
    return instalments(inv.amount_pence, inv.months).map((pence, i) => {
      const date = addMonths(inv.invoice_date, i);
      return { n: i + 1, pence, date, month: st.monthLabel(date.slice(0, 7)), done: false };
    });
  }

  // Change one instalment's amount or date.
  function instalment(req, res) {
    const inv = load(req, res);
    if (!inv) return {};
    const tid = Number(req.params.tid);
    if (!deductionIds(inv).includes(tid)) { res.status(404).render('error', { title: 'Not found', message: 'That payment was not found.' }); return {}; }
    return { inv, t: db.prepare('SELECT * FROM transactions WHERE id = ? AND account_id = ?').get(tid, req.user.id) };
  }
  router.get('/:id(\\d+)/instalments/:tid(\\d+)/edit', (req, res) => {
    const { inv, t } = instalment(req, res);
    if (!inv) return;
    const n = deductionIds(inv).indexOf(t.id) + 1;
    res.render('landlordinvoices/instalment', { title: `Edit payment ${n} of ${inv.months} · ${inv.invoice_number}`, section: 'landlordinvoices', inv, t, n, fmt, errors: {}, values: { date: t.txn_date, amount: fmt.penceToInput(t.amount_pence) } });
  });
  router.post('/:id(\\d+)/instalments/:tid(\\d+)', (req, res) => {
    const { inv, t } = instalment(req, res);
    if (!inv) return;
    const n = deductionIds(inv).indexOf(t.id) + 1;
    const date = String(req.body.date || '').trim();
    const pence = fmt.parseMoney(String(req.body.amount || '').trim());
    const errors = {};
    if (!fmt.isIsoDate(date)) errors.date = 'Enter a valid date.';
    if (Number.isNaN(pence) || pence <= 0) errors.amount = 'Enter the amount, like 40 or 40.00.';
    if (Object.keys(errors).length) {
      return res.status(422).render('landlordinvoices/instalment', { title: `Edit payment ${n} of ${inv.months} · ${inv.invoice_number}`, section: 'landlordinvoices', inv, t, n, fmt, errors, values: req.body });
    }
    db.prepare('UPDATE transactions SET txn_date = ?, amount_pence = ? WHERE id = ? AND account_id = ?').run(date, pence, t.id, req.user.id);
    res.redirect(`/app/landlord-invoices/${inv.id}?flash=${encodeURIComponent(`Payment ${n} changed to ${fmt.money(pence)} on ${fmt.ukDate(date)}.`)}#schedule`);
  });

  // Removes every deduction made for the invoice.
  function removeDeductions(a, inv) {
    const ids = [inv.txn_id, ...JSON.parse(inv.instalment_txn_ids || '[]')].filter(Boolean);
    for (const id of ids) db.prepare('DELETE FROM transactions WHERE id = ? AND account_id = ?').run(id, a);
  }

  router.post('/:id(\\d+)/settle', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    const a = req.user.id;
    const back = (msg, ok) => res.redirect(`/app/landlord-invoices/${inv.id}?${ok ? 'flash' : 'error'}=${encodeURIComponent(msg)}`);
    if (inv.status === 'paid') return back('This invoice is already settled.');
    const date = String(req.body.date || '');
    if (!fmt.isIsoDate(date)) return back('Enter the date.');
    if (req.body.how === 'deduct') {
      deduct(a, inv, date);
      if (inv.months > 1) return back(`Deducting ${fmt.money(inv.amount_pence)} from ${inv.landlord_name}'s rent over ${inv.months} months, from ${st.monthLabel(date.slice(0, 7))}.`, true);
      return back(`Deducted ${fmt.money(inv.amount_pence)} from ${inv.landlord_name}'s rent for ${st.monthLabel(date.slice(0, 7))}.`, true);
    }
    db.prepare("UPDATE landlord_invoices SET status = 'paid', paid_date = ?, paid_how = 'Paid by landlord' WHERE id = ? AND account_id = ?").run(date, inv.id, a);
    back(`Marked ${inv.invoice_number} as paid by ${inv.landlord_name}.`, true);
  });

  // The invoice's details for the PDF, laid out like the agency's own (maintenance) invoice.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function invoiceDoc(accountId, inv) {
    const co = db.prepare('SELECT agency_name, address, phone, email FROM users WHERE id = ?').get(accountId);
    const p = inv.property_id ? db.prepare('SELECT address_line1, town, postcode FROM properties WHERE id = ?').get(inv.property_id) : null;
    const over = inv.months > 1 ? ` over ${inv.months} months (${fmt.money(Math.floor(inv.amount_pence / inv.months))} a month)` : '';
    const note = inv.status !== 'paid' ? `Payment will be deducted from the rent payment${over}`
      : inv.paid_how === 'Deducted from rent' ? `Payment ${inv.months > 1 ? 'is being' : 'has been'} deducted from the rent payment${over}`
      : inv.paid_how === 'Paid by us' ? '' : 'Paid - thank you';
    const [y, m] = String(inv.invoice_date || '').split('-').map(Number);
    const name = `${[p && p.address_line1, p && p.postcode].filter(Boolean).join(' ') || inv.invoice_number}${y ? ` - ${MONTHS[m - 1]} ${y}` : ''}`;
    return {
      filename: `${name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'invoice'}.pdf`,
      data: {
        company: { name: co.agency_name, address: co.address, phone: co.phone, email: co.email },
        date: inv.invoice_date, client: inv.landlord_name,
        property: p ? [p.address_line1, p.town, p.postcode].map((s) => String(s || '').trim()).filter(Boolean) : [],
        items: [inv.description, ...String(inv.notes || '').split(/\r?\n/)].map((s) => String(s || '').trim()).filter(Boolean),
        totalPence: inv.amount_pence, note,
      },
    };
  }

  router.get('/:id(\\d+)/invoice.pdf', async (req, res, next) => {
    try {
      const inv = load(req, res);
      if (!inv) return;
      const doc = invoiceDoc(req.user.id, inv);
      const pdf = await require('../jobInvoice').buildJobInvoice(doc.data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${doc.filename}"`);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(Buffer.from(pdf));
    } catch (err) { next(err); }
  });

  router.post('/:id(\\d+)/unsettle', (req, res) => {
    const inv = load(req, res);
    if (!inv) return;
    transaction(db, () => {
      removeDeductions(req.user.id, inv);
      db.prepare("UPDATE landlord_invoices SET status = 'unpaid', paid_date = NULL, paid_how = NULL, txn_id = NULL, instalment_txn_ids = NULL WHERE id = ? AND account_id = ?").run(inv.id, req.user.id);
    });
    res.redirect(`/app/landlord-invoices/${inv.id}?flash=${encodeURIComponent('Undone. The invoice is unpaid again.')}`);
  });

  // ---------- email ----------

  router.post('/:id(\\d+)/email', async (req, res, next) => {
    try {
      const inv = load(req, res);
      if (!inv) return;
      const back = (msg, ok) => res.redirect(`/app/landlord-invoices/${inv.id}?${ok ? 'flash' : 'error'}=${encodeURIComponent(msg)}`);
      if (!mailer.enabled) return back('Email isn’t set up yet. Print the invoice instead.');
      if (!isEmail(inv.landlord_email)) return back(`${inv.landlord_name} has no email address. Add one on their landlord page.`);
      const agency = db.prepare('SELECT agency_name, email FROM users WHERE id = ?').get(req.user.id);
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const lines = [
        `Dear ${inv.landlord_name},`, '',
        `Please find our invoice ${inv.invoice_number} attached.`, '',
        `Date: ${fmt.ukDate(inv.invoice_date)}`, inv.due_date ? `Due: ${fmt.ukDate(inv.due_date)}` : null,
        inv.address_line1 ? `Property: ${inv.address_line1}` : null,
        `For: ${inv.description}`, `Amount: ${fmt.money(inv.amount_pence)}`, '',
        inv.status === 'paid' ? `Status: settled (${inv.paid_how.toLowerCase()} on ${fmt.ukDate(inv.paid_date)}).` : 'Unless you tell us otherwise, we will deduct this from your rent.', '',
        agency.agency_name,
      ].filter((l) => l !== null);
      const doc = invoiceDoc(req.user.id, inv);
      await mailer.send({
        to: inv.landlord_email, subject: `Invoice ${inv.invoice_number} from ${agency.agency_name}`, fromName: agency.agency_name, replyTo: agency.email,
        attachments: [{ filename: doc.filename, content: Buffer.from(await require('../jobInvoice').buildJobInvoice(doc.data)), contentType: 'application/pdf' }],
        text: lines.join('\n'), html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111">${lines.map((l) => (l ? `<p style="margin:0 0 6px">${esc(l)}</p>` : '<br>')).join('')}</body></html>`,
      });
      db.prepare("UPDATE landlord_invoices SET emailed_at = datetime('now') WHERE id = ?").run(inv.id);
      back(`Emailed ${inv.invoice_number} to ${inv.landlord_email}.`, true);
    } catch (err) { next(err); }
  });

  return router;
};
