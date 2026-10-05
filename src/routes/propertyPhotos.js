'use strict';

// Photos of a property, or of an inspection: upload several at once, view, download, remove.
// Each kind keeps its photos in its own table, so inspection photos never mix with the listing's.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const { typeOf, MAX_BYTES } = require('./jobFiles');

const MAX_FILES = 20;
// Photos only (iPhone HEIC photos are kept and can be downloaded; most browsers can't show them).
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);
const SHOWABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const KINDS = {
  properties: { table: 'property_photos', fk: 'property_id', parent: 'properties', noun: 'property' },
  inspections: { table: 'inspection_photos', fk: 'inspection_id', parent: 'inspections', noun: 'inspection' },
};

module.exports = function photoRoutes(db, kind = 'properties') {
  const { table, fk, parent, noun } = KINDS[kind];
  const router = express.Router();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `rift-${noun}-photos-`));
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 5 } }).array('photos', MAX_FILES);
  const cleanUp = (files) => { for (const f of files || []) fs.rm(f.path, { force: true }, () => {}); };

  function ownedProperty(req, res) {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) && db.prepare(`SELECT id FROM ${parent} WHERE id = ? AND account_id = ?`).get(id, req.user.id);
    if (!p) res.status(404).render('error', { title: 'Not found', message: `That ${noun} was not found.` });
    return p;
  }

  const back = (res, id, key, msg) => res.redirect(`/app/${parent}/${id}?${key}=${encodeURIComponent(msg)}#photos`);

  router.post('/:id(\\d+)/photos', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 25 MB.' : err.code === 'LIMIT_FILE_COUNT' ? `Upload up to ${MAX_FILES} photos at a time.` : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const all = req.files || [];
    res.on('finish', () => cleanUp(all));
    const property = ownedProperty(req, res);
    if (!property) return;
    if (req.uploadError) return back(res, property.id, 'error', req.uploadError);
    const files = all.filter((f) => f.size);
    if (!files.length) return back(res, property.id, 'error', 'Choose one or more photos to upload.');
    const insert = db.prepare(`INSERT INTO ${table} (account_id, ${fk}, filename, mime, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const refused = [];
    let saved = 0;
    for (const f of files) {
      const buffer = fs.readFileSync(f.path);
      const name = path.basename(String(f.originalname || 'photo')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'photo';
      const type = typeOf(buffer, name);
      if (!type || !PHOTO_TYPES.has(type.mime)) { refused.push(name); continue; }
      insert.run(req.user.id, property.id, name, type.mime, f.size, buffer, req.user.person_id);
      saved += 1;
    }
    const msg = `Uploaded ${saved} photo${saved === 1 ? '' : 's'}.`;
    if (refused.length) return back(res, property.id, 'error', `${saved ? msg + ' ' : ''}Not uploaded (use JPG, PNG, WebP, GIF or iPhone HEIC photos): ${refused.join(', ')}.`);
    back(res, property.id, 'flash', msg);
  });

  router.get('/:id(\\d+)/photos/:fid(\\d+)', (req, res) => {
    const f = db.prepare(`SELECT filename, mime, data FROM ${table} WHERE id = ? AND ${fk} = ? AND account_id = ?`).get(Number(req.params.fid), Number(req.params.id), req.user.id);
    if (!f) return res.status(404).render('error', { title: 'Not found', message: 'That photo was not found.' });
    const inline = req.query.download !== '1' && SHOWABLE.has(f.mime);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(Buffer.from(f.data));
  });

  router.post('/:id(\\d+)/photos/:fid(\\d+)/delete', (req, res) => {
    const property = ownedProperty(req, res);
    if (!property) return;
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND ${fk} = ? AND account_id = ?`).run(Number(req.params.fid), property.id, req.user.id);
    back(res, property.id, 'flash', 'Photo removed.');
  });

  return router;
};
