'use strict';

// A picture for each council (e.g. its logo): upload, show and remove.

const express = require('express');
const multer = require('multer');
const auth = require('../auth');

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

// Identified by content, not by the name or type the browser sent.
const IMAGE_TYPES = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
];

module.exports = function councilPhotoRoutes(db) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 5 } }).single('photo');

  function ownedCouncil(req, res) {
    const id = Number(req.params.id);
    const council = Number.isInteger(id) && db.prepare('SELECT id FROM councils WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!council) res.status(404).render('error', { title: 'Not found', message: 'That council was not found.' });
    return council;
  }

  const back = (res, id, error) => res.redirect(`/app/councils/${id}${error ? `?error=${encodeURIComponent(error)}` : ''}`);

  router.post('/:id(\\d+)/photo', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The picture is larger than 2 MB.' : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const council = ownedCouncil(req, res);
    if (!council) return;
    if (req.uploadError) return back(res, council.id, req.uploadError);
    if (!req.file || !req.file.size) return back(res, council.id, 'Choose a picture to upload.');
    const type = IMAGE_TYPES.find((t) => t.test(req.file.buffer));
    if (!type) return back(res, council.id, 'Upload a PNG, JPG, WebP or GIF picture.');
    db.prepare(
      `INSERT INTO council_photos (council_id, account_id, mime, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(council_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = datetime('now')`
    ).run(council.id, req.user.id, type.mime, req.file.buffer);
    back(res, council.id);
  });

  router.post('/:id(\\d+)/photo/delete', (req, res) => {
    const council = ownedCouncil(req, res);
    if (!council) return;
    db.prepare('DELETE FROM council_photos WHERE council_id = ? AND account_id = ?').run(council.id, req.user.id);
    back(res, council.id);
  });

  router.get('/:id(\\d+)/photo', (req, res) => {
    const photo = db.prepare('SELECT mime, data FROM council_photos WHERE council_id = ? AND account_id = ?').get(Number(req.params.id), req.user.id);
    if (!photo) return res.status(404).end();
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(photo.data));
  });

  return router;
};
