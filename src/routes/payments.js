'use strict';

// Rent run step 5: the bank payment instruction (e.g. Metro Bank).
//  - Each company saves its blank template (PDF or image) to download or print as it is.
//  - "Fill in" builds the instruction for the month from the landlords' balances and bank
//    details, which can be edited, saved and printed.

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const fmt = require('../format');
const st = require('../statements');

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
const MAX_PAYEES = 200;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const shortMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(y).slice(2)}`;
};

module.exports = function paymentRoutes(db) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('template');
  const monthOf = (v) => (st.isMonth(v) ? String(v) : st.previousMonth());
  const backToRun = (res, month, { flash, error } = {}) => {
    const q = new URLSearchParams({ month });
    if (flash) q.set('flash', flash);
    if (error) q.set('error', error);
    res.redirect(`/app/rent-run?${q}#payment-instruction`);
  };

  // ---------- the saved template ----------

  router.post('/template', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const month = monthOf(req.body.month);
    if (req.uploadError) return backToRun(res, month, { error: req.uploadError });
    if (!req.file || !req.file.size) return backToRun(res, month, { error: 'Choose the template file to upload.' });
    const type = TYPES.find((t) => t.test(req.file.buffer));
    if (!type) return backToRun(res, month, { error: 'Upload the template as a PDF, JPG or PNG.' });
    const name = path.basename(String(req.file.originalname || 'payment-instruction')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'payment-instruction';
    db.prepare(
      `INSERT INTO payment_templates (account_id, filename, mime, size, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET filename = excluded.filename, mime = excluded.mime, size = excluded.size,
         data = excluded.data, uploaded_at = datetime('now')`
    ).run(req.user.id, name, type.mime, req.file.size, req.file.buffer);
    backToRun(res, month, { flash: `Saved ${name} as your payment instruction template.` });
  });

  router.post('/template/delete', (req, res) => {
    db.prepare('DELETE FROM payment_templates WHERE account_id = ?').run(req.user.id);
    backToRun(res, monthOf(req.body.month), { flash: 'Removed the payment instruction template.' });
  });

  // Inline for printing (framed by the rent run page) or as a download.
  router.get('/template', (req, res) => {
    const t = db.prepare('SELECT filename, mime, data FROM payment_templates WHERE account_id = ?').get(req.user.id);
    if (!t) return res.status(404).render('error', { title: 'Not found', message: 'No payment instruction template has been saved yet.' });
    res.setHeader('Content-Type', t.mime);
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${t.filename.replace(/"/g, '')}"`);
    // Only this site may frame it (so the Print button can print it); nothing inside may run.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(t.data));
  });

  // ---------- filling it in ----------

  // Landlords to pay this month: those paid by bank (statement type Email) holding money.
  function suggestedPayees(accountId, month) {
    return db.prepare(
      `SELECT l.id, l.name, l.code, l.bank_account_name, l.bank_sort_code, l.bank_account_number, s.closing_pence
         FROM landlords l JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
        WHERE l.account_id = ? AND l.statement_type != 'Cheque' AND s.closing_pence > 0
        ORDER BY l.name COLLATE NOCASE`
    ).all(month, accountId).map((l) => ({
      include: true, landlord_id: l.id, name: l.bank_account_name || l.name, sort_code: l.bank_sort_code || '',
      account_number: l.bank_account_number || '', amount: fmt.penceToInput(l.closing_pence),
      // Banks allow 18 characters: e.g. "RO1 Rent Aug 26".
      reference: clip(`${l.code ? `${l.code} ` : ''}Rent ${shortMonth(month)}`, 18),
    }));
  }

  function load(accountId, month) {
    const row = db.prepare('SELECT data_json, updated_at FROM payment_instructions WHERE account_id = ? AND month = ?').get(accountId, month);
    if (row) return { ...JSON.parse(row.data_json), saved_at: row.updated_at };
    // A new month starts from the last instruction's "paying from" details.
    const last = db.prepare('SELECT data_json FROM payment_instructions WHERE account_id = ? ORDER BY month DESC LIMIT 1').get(accountId);
    const prev = last ? JSON.parse(last.data_json) : {};
    return {
      from_name: prev.from_name || '', from_sort_code: prev.from_sort_code || '', from_account_number: prev.from_account_number || '',
      payment_date: '', signatory_1: prev.signatory_1 || '', signatory_2: prev.signatory_2 || '', notes: '',
      payees: suggestedPayees(accountId, month), saved_at: null,
    };
  }

  function total(data) {
    return data.payees.filter((p) => p.include).reduce((t, p) => t + (Number.isNaN(fmt.parseMoney(p.amount)) ? 0 : fmt.parseMoney(p.amount)), 0);
  }

  router.get('/instruction', (req, res) => {
    const month = monthOf(req.query.month);
    const data = load(req.user.id, month);
    res.render('payments/instruction', {
      title: `Payment instruction · ${st.monthLabel(month)}`, section: 'rentrun', month, monthLabel: st.monthLabel(month), data,
      total: total(data), fmt, flash: clip(req.query.flash, 300), errors: [],
    });
  });

  router.post('/instruction', (req, res) => {
    const month = monthOf(req.body.month);
    const b = req.body;
    const list = (k) => [].concat(b[k] ?? []);
    const names = list('p_name');
    const payees = names.slice(0, MAX_PAYEES).map((_, i) => ({
      include: list('p_include').includes(String(i)),
      landlord_id: Number(list('p_landlord')[i]) || null,
      name: clip(names[i], 60), sort_code: clip(list('p_sort')[i], 12), account_number: clip(list('p_account')[i], 12),
      amount: clip(list('p_amount')[i], 20), reference: clip(list('p_ref')[i], 18),
    })).filter((p) => p.name || p.amount || p.account_number);
    const data = {
      from_name: clip(b.from_name, 60), from_sort_code: clip(b.from_sort_code, 12), from_account_number: clip(b.from_account_number, 12),
      payment_date: fmt.isIsoDate(String(b.payment_date || '')) ? b.payment_date : '',
      signatory_1: clip(b.signatory_1, 60), signatory_2: clip(b.signatory_2, 60), notes: clip(b.notes, 1000), payees,
    };
    // Check the rows being paid have what the bank needs.
    const errors = [];
    payees.forEach((p) => {
      if (!p.include) return;
      const who = p.name || 'A payee';
      if (!/^\d{2}-?\d{2}-?\d{2}$/.test(p.sort_code.replace(/\s/g, ''))) errors.push(`${who}: sort code should be 6 digits.`);
      if (!/^\d{8}$/.test(p.account_number.replace(/\s/g, ''))) errors.push(`${who}: account number should be 8 digits.`);
      if (Number.isNaN(fmt.parseMoney(p.amount)) || fmt.parseMoney(p.amount) <= 0) errors.push(`${who}: enter the amount to pay.`);
    });
    db.prepare(
      `INSERT INTO payment_instructions (account_id, month, data_json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, month) DO UPDATE SET data_json = excluded.data_json, updated_at = datetime('now')`
    ).run(req.user.id, month, JSON.stringify(data));
    if (errors.length) {
      return res.status(422).render('payments/instruction', {
        title: `Payment instruction · ${st.monthLabel(month)}`, section: 'rentrun', month, monthLabel: st.monthLabel(month),
        data: { ...data, saved_at: 'now' }, total: total(data), fmt, flash: 'Saved, but check these before printing:', errors,
      });
    }
    if (b.then === 'print') return res.redirect(`/app/rent-run/instruction/print?month=${month}`);
    res.redirect(`/app/rent-run/instruction?month=${month}&flash=${encodeURIComponent('Saved.')}`);
  });

  // Start again from the month's statements (drops the saved payee list, keeps "paying from").
  router.post('/instruction/refresh', (req, res) => {
    const month = monthOf(req.body.month);
    const cur = load(req.user.id, month);
    const data = { ...cur, payees: suggestedPayees(req.user.id, month) };
    delete data.saved_at;
    db.prepare(
      `INSERT INTO payment_instructions (account_id, month, data_json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, month) DO UPDATE SET data_json = excluded.data_json, updated_at = datetime('now')`
    ).run(req.user.id, month, JSON.stringify(data));
    res.redirect(`/app/rent-run/instruction?month=${month}&flash=${encodeURIComponent('Payees refreshed from this month’s statements.')}`);
  });

  router.get('/instruction/print', (req, res) => {
    const month = monthOf(req.query.month);
    const data = load(req.user.id, month);
    const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(req.user.id);
    res.render('payments/print', {
      title: `Payment instruction · ${st.monthLabel(month)}`, month, monthLabel: st.monthLabel(month), data,
      payees: data.payees.filter((p) => p.include), total: total(data), agencyName: agency.agency_name, fmt, bodyClass: 'print-page',
    });
  });

  return router;
};
