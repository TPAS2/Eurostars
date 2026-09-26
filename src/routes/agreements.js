'use strict';

// The signed tenancy agreement for each tenancy: upload, view and remove.

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');

const MAX_BYTES = 10 * 1024 * 1024;

// Identified by content, not by the name or type the browser sent.
const TYPES = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

module.exports = function agreementRoutes(db) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('agreement');

  function ownedTenancy(req, res) {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) && db.prepare('SELECT id, tenant_id FROM tenancies WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!t) res.status(404).render('error', { title: 'Not found', message: 'That tenancy was not found.' });
    return t;
  }

  // Back to the tenant or tenancy page the change came from.
  const back = (req, res, t, error) => {
    const to = /^\/app\/(tenants|tenancies)\/\d+$/.test(String(req.body.back || '')) ? req.body.back : `/app/tenancies/${t.id}`;
    res.redirect(`${to}${error ? `?error=${encodeURIComponent(error)}` : ''}#tenancy-${t.id}`);
  };

  router.post('/:id(\\d+)/agreement', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const t = ownedTenancy(req, res);
    if (!t) return;
    if (req.uploadError) return back(req, res, t, req.uploadError);
    if (!req.file || !req.file.size) return back(req, res, t, 'Choose the tenancy agreement file to upload.');
    const type = TYPES.find((x) => x.test(req.file.buffer));
    if (!type) return back(req, res, t, 'Upload the tenancy agreement as a PDF, JPG or PNG.');
    const name = path.basename(String(req.file.originalname || 'tenancy-agreement')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'tenancy-agreement';
    db.prepare(
      `INSERT INTO tenancy_agreements (tenancy_id, account_id, filename, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenancy_id) DO UPDATE SET filename = excluded.filename, mime = excluded.mime, size = excluded.size,
         data = excluded.data, uploaded_at = datetime('now')`
    ).run(t.id, req.user.id, name, type.mime, req.file.size, req.file.buffer);
    back(req, res, t);
  });

  router.post('/:id(\\d+)/agreement/delete', (req, res) => {
    const t = ownedTenancy(req, res);
    if (!t) return;
    db.prepare('DELETE FROM tenancy_agreements WHERE tenancy_id = ? AND account_id = ?').run(t.id, req.user.id);
    back(req, res, t);
  });

  router.get('/:id(\\d+)/agreement', (req, res) => {
    const doc = db.prepare('SELECT filename, mime, data FROM tenancy_agreements WHERE tenancy_id = ? AND account_id = ?').get(Number(req.params.id), req.user.id);
    if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'No tenancy agreement has been uploaded for this tenancy.' });
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `${disposition}; filename="${doc.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; object-src 'self'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(doc.data));
  });

  return router;
};
