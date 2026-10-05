'use strict';

// Scans and PDFs of certificates: chosen while adding a property (one box per certificate), or
// added later on the certificate's own page. Viewed from the property's certificate panel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const fmt = require('../format');
const { typeOf, REFUSED, SHOWABLE, MAX_BYTES } = require('./jobFiles');

const MAX_FILES = 10;
const CERT_SLOTS = 4; // the certificate rows on the new-property form
const CERT_TYPES = ['Gas Safety (CP12)', 'EICR', 'EPC', 'Insurance']; // in the same order

module.exports = function certFileRoutes(db) {
  const router = express.Router();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-cert-files-'));
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 5 } }).array('files', MAX_FILES);
  const uploadWithProperty = multer({ dest: tmpDir, limits: { fileSize: MAX_BYTES, files: CERT_SLOTS, fields: 80 } })
    .fields(Array.from({ length: CERT_SLOTS }, (_, i) => ({ name: `cert_${i}_file`, maxCount: 1 })));
  const cleanUp = (files) => { for (const f of files || []) fs.rm(f.path, { force: true }, () => {}); };
  const uploadError = (err) => (err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 25 MB.' : 'The upload failed. Please try again.');

  // Saves one file to a certificate; returns false (and saves nothing) if it isn't an allowed type.
  function saveFile(accountId, itemId, f, personId) {
    const buffer = fs.readFileSync(f.path);
    const name = path.basename(String(f.originalname || 'file')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'file';
    const type = typeOf(buffer, name);
    if (!type) return { ok: false, name };
    db.prepare('INSERT INTO compliance_files (account_id, item_id, filename, mime, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, itemId, name, type.mime, f.size, buffer, personId);
    return { ok: true, name };
  }

  // Adding a property: certificate files are kept aside until the property and its certificates
  // are saved (see the create route in app.js), then each is attached to its certificate.
  const newProperty = express.Router();
  newProperty.post('/', (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    uploadWithProperty(req, res, (err) => {
      if (err) req.uploadError = uploadError(err);
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, () => {
        const all = Object.values(req.files || {}).flat();
        res.on('finish', () => cleanUp(all));
        req.certFile = (i) => ((req.files || {})[`cert_${i}_file`] || []).find((f) => f.size) || null;
        req.saveCertFile = (itemId, f) => saveFile(req.user.id, itemId, f, req.user.person_id);
        next();
      });
    });
  });

  // Editing a property: one certificate row saved at a time (its dates, and a file if chosen).
  // It changes the current certificate of that kind, or adds one if there isn't one yet.
  const uploadOne = multer({ dest: tmpDir, limits: { fileSize: MAX_BYTES, files: 1, fields: 10 } }).single('file');
  newProperty.post('/:id(\\d+)/certs/:slot(\\d)', (req, res, next) => {
    uploadOne(req, res, (err) => {
      if (err) req.uploadError = uploadError(err);
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    if (req.file) res.on('finish', () => cleanUp([req.file]));
    const a = req.user.id;
    const property = db.prepare('SELECT id FROM properties WHERE id = ? AND account_id = ?').get(Number(req.params.id), a);
    const type = CERT_TYPES[Number(req.params.slot)];
    if (!property || !type) return res.status(404).render('error', { title: 'Not found', message: 'That property was not found.' });
    const back = (key, msg) => res.redirect(`/app/properties/${property.id}/edit?cert_${key}=${encodeURIComponent(msg)}#edit-certs`);
    if (req.uploadError) return back('error', req.uploadError);
    const issued = String(req.body.issued || '').trim();
    const expiry = String(req.body.expiry || '').trim();
    if (!fmt.isIsoDate(expiry)) return back('error', `Enter when the ${type} expires.`);
    if (issued && !fmt.isIsoDate(issued)) return back('error', `Enter a valid issued date for the ${type}.`);
    const current = db.prepare('SELECT id FROM compliance_items WHERE account_id = ? AND property_id = ? AND item_type = ? ORDER BY expiry_date DESC, id DESC').get(a, property.id, type);
    let itemId;
    if (current) {
      db.prepare('UPDATE compliance_items SET issued_date = ?, expiry_date = ? WHERE id = ? AND account_id = ?').run(issued || null, expiry, current.id, a);
      itemId = current.id;
    } else {
      itemId = Number(db.prepare('INSERT INTO compliance_items (account_id, property_id, item_type, issued_date, expiry_date) VALUES (?, ?, ?, ?, ?)')
        .run(a, property.id, type, issued || null, expiry).lastInsertRowid);
    }
    if (req.file && req.file.size) {
      const saved = saveFile(a, itemId, req.file, req.user.person_id);
      if (!saved.ok) return back('error', `${type} dates saved, but ${saved.name} wasn’t uploaded (use a PDF or photo).`);
    }
    back('flash', `${type} saved.`);
  });

  function ownedItem(req, res) {
    const id = Number(req.params.id);
    const item = Number.isInteger(id) && db.prepare('SELECT id, property_id FROM compliance_items WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!item) res.status(404).render('error', { title: 'Not found', message: 'That certificate was not found.' });
    return item;
  }
  const back = (res, id, key, msg) => res.redirect(`/app/compliance/${id}?${key}=${encodeURIComponent(msg)}#cert-files`);

  router.post('/:id(\\d+)/files', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_COUNT' ? `Upload up to ${MAX_FILES} files at a time.` : uploadError(err);
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const all = req.files || [];
    res.on('finish', () => cleanUp(all));
    const item = ownedItem(req, res);
    if (!item) return;
    if (req.uploadError) return back(res, item.id, 'error', req.uploadError);
    const files = all.filter((f) => f.size);
    if (!files.length) return back(res, item.id, 'error', 'Choose the certificate file to upload.');
    const results = files.map((f) => saveFile(req.user.id, item.id, f, req.user.person_id));
    const saved = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).map((r) => r.name);
    const msg = `Uploaded ${saved} file${saved === 1 ? '' : 's'}.`;
    if (refused.length) return back(res, item.id, 'error', `${saved ? msg + ' ' : ''}${REFUSED} ${refused.join(', ')}.`);
    back(res, item.id, 'flash', msg);
  });

  router.get('/:id(\\d+)/files/:fid(\\d+)', (req, res) => {
    const f = db.prepare('SELECT filename, mime, data FROM compliance_files WHERE id = ? AND item_id = ? AND account_id = ?').get(Number(req.params.fid), Number(req.params.id), req.user.id);
    if (!f) return res.status(404).render('error', { title: 'Not found', message: 'That file was not found.' });
    const inline = req.query.download !== '1' && (SHOWABLE.has(f.mime) || f.mime === 'application/pdf');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; object-src 'self'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(Buffer.from(f.data));
  });

  router.post('/:id(\\d+)/files/:fid(\\d+)/delete', (req, res) => {
    const item = ownedItem(req, res);
    if (!item) return;
    db.prepare('DELETE FROM compliance_files WHERE id = ? AND item_id = ? AND account_id = ?').run(Number(req.params.fid), item.id, req.user.id);
    back(res, item.id, 'flash', 'File removed.');
  });

  router.newProperty = newProperty;
  return router;
};
