'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const { transaction } = require('../db');
const ledger = require('../ledger');
const fmt = require('../format');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAYMENT_METHODS = ['Bank transfer', 'Card', 'Cheque', 'Cash', 'Direct debit', 'Other'];

// Allowed uploads, identified by their content rather than the name the browser sent.
const FILE_TYPES = [
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: '.webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

module.exports = function invoiceRoutes(db, config) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 30 } }).single('file');

  // multer, then the deferred CSRF check; upload errors are shown on the form instead of a 500.
  function receiveUpload(req, res, next) {
    upload(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Please try again.';
        req.body = req.body || {};
      }
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }

  function accountDir(accountId) {
    return path.join(config.uploadDir, String(accountId));
  }

  function saveFile(accountId, file) {
    const type = FILE_TYPES.find((t) => t.test(file.buffer));
    if (!type) return { error: 'Upload a PDF, PNG, JPG or WebP file.' };
    const dir = accountDir(accountId);
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.randomBytes(16).toString('hex') + type.ext;
    fs.writeFileSync(path.join(dir, name), file.buffer, { flag: 'wx' });
    const original = path.basename(String(file.originalname || 'invoice')).replace(/[^\w.\- ()]/g, '_').slice(0, 150);
    return { file_name: name, file_original: original, file_mime: type.mime, file_size: file.size };
  }

  function removeFile(accountId, fileName) {
    if (!fileName) return;
    fs.rm(path.join(accountDir(accountId), path.basename(fileName)), { force: true }, () => {});
  }

  const PROPERTY_OPTS = "SELECT id, address_line1 || COALESCE(', ' || postcode, '') AS label FROM properties WHERE account_id = ? ORDER BY label COLLATE NOCASE";
  const JOB_OPTS = `SELECT m.id, m.title || ' — ' || p.address_line1 AS label, m.property_id
                      FROM maintenance_jobs m JOIN properties p ON p.id = m.property_id
                     WHERE m.account_id = ? ORDER BY m.status = 'completed', m.reported_date DESC`;

  function owned(table, id, accountId) {
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND account_id = ?`).get(n, accountId) : null;
  }

  function parseInvoice(body, accountId) {
    const v = {};
    const errors = {};
    const text = (k, max = 200) => { const s = String(body[k] ?? '').trim(); return s ? s.slice(0, max) : null; };
    v.supplier = text('supplier');
    if (!v.supplier) errors.supplier = 'Enter the supplier or contractor.';
    v.invoice_number = text('invoice_number', 100);
    v.description = text('description', 5000);
    for (const k of ['invoice_date', 'due_date']) {
      v[k] = text(k, 10);
      if (v[k] && !fmt.isIsoDate(v[k])) errors[k] = 'Enter a valid date.';
    }
    v.amount_pence = fmt.parseMoney(String(body.amount || '').trim());
    if (Number.isNaN(v.amount_pence) || v.amount_pence <= 0) errors.amount = 'Enter the invoice total, e.g. 180.00.';
    v.maintenance_job_id = null;
    v.property_id = null;
    if (body.maintenance_job_id) {
      const job = owned('maintenance_jobs', body.maintenance_job_id, accountId);
      if (!job) errors.maintenance_job_id = 'Choose a valid job.';
      else { v.maintenance_job_id = job.id; v.property_id = job.property_id; }
    }
    if (body.property_id && !v.property_id) {
      const p = owned('properties', body.property_id, accountId);
      if (!p) errors.property_id = 'Choose a valid property.';
      else v.property_id = p.id;
    }
    return { v, errors };
  }

  function renderForm(req, res, { invoice, values, errors, status = 200 }) {
    const a = req.user.id;
    res.status(status).render('invoices/form', {
      title: invoice ? 'Edit invoice' : 'Upload invoice', section: 'invoices', invoice, values, errors,
      jobs: db.prepare(JOB_OPTS).all(a), properties: db.prepare(PROPERTY_OPTS).all(a), fmt,
    });
  }

  function loadInvoice(req, res) {
    const inv = owned('invoices', req.params.id, req.user.id);
    if (!inv) res.status(404).render('error', { title: 'Not found', message: "That invoice doesn't exist." });
    return inv;
  }

  // ---------- list ----------

  router.get('/', (req, res) => {
    const a = req.user.id;
    const status = ['unpaid', 'paid', 'overdue'].includes(req.query.status) ? req.query.status : 'all';
    const today = fmt.today();
    // One month at a time (by invoice date, else due date), or every month.
    const thisMonth = today.slice(0, 7);
    // Links to unpaid/overdue without a month (e.g. from the dashboard) show every month, so nothing owed is hidden.
    const month = req.query.month === 'all' ? 'all' : /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month)
      : ['unpaid', 'overdue'].includes(status) ? 'all' : thisMonth;
    let where = 'i.account_id = ?';
    const params = [a];
    if (month !== 'all') { where += " AND substr(COALESCE(i.invoice_date, i.due_date, i.created_at), 1, 7) = ?"; params.push(month); }
    if (status === 'unpaid') where += " AND i.status = 'unpaid'";
    if (status === 'paid') where += " AND i.status = 'paid'";
    if (status === 'overdue') { where += " AND i.status = 'unpaid' AND i.due_date < ?"; params.push(today); }
    const invoices = db.prepare(
      `SELECT i.*, p.address_line1, m.title AS job_title
         FROM invoices i LEFT JOIN properties p ON p.id = i.property_id LEFT JOIN maintenance_jobs m ON m.id = i.maintenance_job_id
        WHERE ${where}
        ORDER BY i.status = 'paid', COALESCE(i.due_date, i.invoice_date, i.created_at) LIMIT 500`
    ).all(...params);
    const totals = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_pence END), 0) AS unpaid,
              COUNT(CASE WHEN status = 'unpaid' THEN 1 END) AS unpaid_n,
              COALESCE(SUM(CASE WHEN status = 'unpaid' AND due_date < ? THEN amount_pence END), 0) AS overdue,
              COUNT(CASE WHEN status = 'unpaid' AND due_date < ? THEN 1 END) AS overdue_n
         FROM invoices WHERE account_id = ?`
    ).get(today, today, a);
    const shift = (by) => { const [y, m] = (month === 'all' ? thisMonth : month).split('-').map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };
    res.render('invoices/list', {
      title: 'Invoices', section: 'invoices', invoices, totals, status, today, fmt, flash: String(req.query.flash || '').slice(0, 200),
      month, prev: shift(-1), next: shift(1), thisMonth, monthLabel: month === 'all' ? 'All months' : require('../statements').monthLabel(month),
    });
  });

  // ---------- upload / edit ----------

  router.get('/new', (req, res) => {
    const values = { invoice_date: fmt.today() };
    const job = req.query.maintenance_job_id && owned('maintenance_jobs', req.query.maintenance_job_id, req.user.id);
    if (job) { values.maintenance_job_id = job.id; values.property_id = job.property_id; values.supplier = job.contractor || ''; }
    const prop = !job && req.query.property_id && owned('properties', req.query.property_id, req.user.id);
    if (prop) values.property_id = prop.id;
    renderForm(req, res, { invoice: null, values, errors: {} });
  });

  router.post('/', receiveUpload, (req, res) => {
    const a = req.user.id;
    const { v, errors } = parseInvoice(req.body, a);
    if (req.uploadError) errors.file = req.uploadError;
    else if (!req.file) errors.file = 'Attach the invoice (PDF or photo).';
    let stored = null;
    if (!Object.keys(errors).length) {
      stored = saveFile(a, req.file);
      if (stored.error) { errors.file = stored.error; stored = null; }
    }
    if (Object.keys(errors).length) return renderForm(req, res, { invoice: null, values: req.body, errors, status: 422 });
    const row = { ...v, ...stored };
    const cols = Object.keys(row);
    const info = db.prepare(`INSERT INTO invoices (account_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(a, ...cols.map((c) => row[c]));
    res.redirect(`/app/invoices/${info.lastInsertRowid}`);
  });

  router.get('/:id', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    const a = req.user.id;
    const property = inv.property_id ? owned('properties', inv.property_id, a) : null;
    const landlord = property && property.landlord_id ? owned('landlords', property.landlord_id, a) : null;
    const job = inv.maintenance_job_id ? owned('maintenance_jobs', inv.maintenance_job_id, a) : null;
    res.render('invoices/show', {
      title: `Invoice ${inv.invoice_number || '#' + inv.id}`, section: 'invoices', inv, property, landlord, job,
      methods: PAYMENT_METHODS, today: fmt.today(), fmt, error: req.query.error || '', flash: req.query.flash || '',
    });
  });

  router.get('/:id/edit', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    renderForm(req, res, { invoice: inv, values: { ...inv, amount: fmt.penceToInput(inv.amount_pence) }, errors: {} });
  });

  router.post('/:id', receiveUpload, (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    const a = req.user.id;
    const { v, errors } = parseInvoice(req.body, a);
    if (inv.status === 'paid' && v.amount_pence !== inv.amount_pence) errors.amount = 'Undo the payment before changing the amount of a paid invoice.';
    if (req.uploadError) errors.file = req.uploadError;
    let stored = null;
    if (!Object.keys(errors).length && req.file) {
      stored = saveFile(a, req.file);
      if (stored.error) { errors.file = stored.error; stored = null; }
    }
    if (Object.keys(errors).length) return renderForm(req, res, { invoice: inv, values: req.body, errors, status: 422 });
    const row = { ...v, ...(stored || {}) };
    const cols = Object.keys(row);
    db.prepare(`UPDATE invoices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND account_id = ?`)
      .run(...cols.map((c) => row[c]), inv.id, a);
    if (stored) removeFile(a, inv.file_name);
    res.redirect(`/app/invoices/${inv.id}`);
  });

  router.post('/:id/delete', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    const a = req.user.id;
    transaction(db, () => {
      // A paid invoice's landlord charge goes with it, so the landlord's balance stays right.
      if (inv.payment_txn_id) db.prepare('DELETE FROM transactions WHERE id = ? AND account_id = ?').run(inv.payment_txn_id, a);
      db.prepare('DELETE FROM invoices WHERE id = ? AND account_id = ?').run(inv.id, a);
    });
    removeFile(a, inv.file_name);
    // Back to the page the delete came from (e.g. a property), otherwise the invoices list.
    const back = String(req.body.back || '');
    const safeBack = /^\/app\/[a-z]+(\/\d+)?$/.test(back) && back !== `/app/invoices/${inv.id}` ? back : '/app/invoices';
    res.redirect(safeBack + '?flash=' + encodeURIComponent(`Deleted invoice from ${inv.supplier}.`));
  });

  // ---------- the document ----------

  router.get('/:id/file', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    if (!inv.file_name) return res.status(404).render('error', { title: 'Not found', message: 'No file was uploaded for this invoice.' });
    const file = path.join(accountDir(req.user.id), path.basename(inv.file_name));
    if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'Not found', message: 'The file is missing.' });
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', inv.file_mime);
    res.setHeader('Content-Disposition', `${disposition}; filename="${inv.file_original.replace(/"/g, '')}"`);
    res.setHeader('Content-Security-Policy', 'sandbox; default-src \'none\'; img-src \'self\'; object-src \'self\'');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(file);
  });

  // ---------- paying ----------

  router.post('/:id/pay', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    const a = req.user.id;
    const back = (msg) => res.redirect(`/app/invoices/${inv.id}?error=${encodeURIComponent(msg)}`);
    if (inv.status === 'paid') return back('This invoice is already paid.');
    const paidDate = String(req.body.paid_date || '').trim();
    const method = String(req.body.payment_method || '');
    const reference = String(req.body.payment_reference || '').trim().slice(0, 100) || null;
    if (!fmt.isIsoDate(paidDate)) return back('Enter the payment date.');
    if (!PAYMENT_METHODS.includes(method)) return back('Choose how it was paid.');
    const chargeLandlord = req.body.charge_landlord === '1';

    transaction(db, () => {
      let txnId = null;
      if (chargeLandlord) {
        const t = ledger.resolveLinks(db, a, { property_id: inv.property_id, landlord_id: null });
        const desc = `Invoice ${inv.invoice_number || '#' + inv.id} — ${inv.supplier}`;
        const info = db.prepare(
          `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, description, amount_pence)
           VALUES (?, ?, 'expense', ?, ?, ?, ?)`
        ).run(a, paidDate, t.landlord_id || null, t.property_id || null, desc, inv.amount_pence);
        txnId = Number(info.lastInsertRowid);
      }
      db.prepare(
        `UPDATE invoices SET status = 'paid', paid_date = ?, payment_method = ?, payment_reference = ?, payment_txn_id = ?
          WHERE id = ? AND account_id = ?`
      ).run(paidDate, method, reference, txnId, inv.id, a);
      if (inv.maintenance_job_id) {
        db.prepare('UPDATE maintenance_jobs SET cost_pence = COALESCE(cost_pence, ?) WHERE id = ? AND account_id = ?')
          .run(inv.amount_pence, inv.maintenance_job_id, a);
      }
    });
    res.redirect(`/app/invoices/${inv.id}?flash=` + encodeURIComponent(`Paid ${fmt.money(inv.amount_pence)} to ${inv.supplier}.`));
  });

  router.post('/:id/unpay', (req, res) => {
    const inv = loadInvoice(req, res);
    if (!inv) return;
    const a = req.user.id;
    transaction(db, () => {
      if (inv.payment_txn_id) db.prepare('DELETE FROM transactions WHERE id = ? AND account_id = ?').run(inv.payment_txn_id, a);
      db.prepare(
        `UPDATE invoices SET status = 'unpaid', paid_date = NULL, payment_method = NULL, payment_reference = NULL, payment_txn_id = NULL
          WHERE id = ? AND account_id = ?`
      ).run(inv.id, a);
    });
    res.redirect(`/app/invoices/${inv.id}?flash=` + encodeURIComponent('Payment undone. The invoice is unpaid again.'));
  });

  return router;
};

module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
