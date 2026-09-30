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
const { fillMetroForm } = require('../metroForm');

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

  const { suggestedPayees, load, total, metroData, saveForm } = require('../paymentInstruction')(db);

  // The Rent run's step 5 box: the details that go on Metro's form.
  router.post('/instruction/form', (req, res) => {
    const month = monthOf(req.body.month);
    saveForm(req.user.id, month, req.body, req.user.name);
    if (req.body.then === 'metro') return res.redirect(`/app/rent-run/instruction/metro.pdf?month=${month}`);
    backToRun(res, month, { flash: 'Saved the payment instruction details.' });
  });

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
      store: clip(b.store, 60), contact_name: clip(b.contact_name, 60),
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
    if (b.then === 'metro') return res.redirect(`/app/rent-run/instruction/metro.pdf?month=${month}`);
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

  // Metro's blank form, as it came.
  router.get('/metro-blank.pdf', (req, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Metro bulk payment instruction (blank).pdf"');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; object-src 'self'");
    res.sendFile(require('../metroForm').TEMPLATE);
  });

  // Metro Bank's own Bulk Payment Instruction form, filled in, plus the list of payments.
  router.get('/instruction/metro.pdf', async (req, res, next) => {
    try {
      const month = monthOf(req.query.month);
      const pdf = await fillMetroForm(metroData(req.user, month));
      const name = `Metro bulk payment instruction ${month}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; object-src 'self'");
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(Buffer.from(pdf));
    } catch (err) { next(err); }
  });

  return router;
};
