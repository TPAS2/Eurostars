'use strict';

// Photos and files on a maintenance job: upload several at once, view, download, remove.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const auth = require('../auth');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;
// Identified by content, not by the name or type the browser sent.
const TYPES = [
  { mime: 'image/jpeg', image: true, test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', image: true, test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', image: true, test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/gif', image: true, test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  // iPhone photos: kept and downloadable (most browsers can't show them inline).
  { mime: 'image/heic', image: false, test: (b) => ['ftypheic', 'ftypheix', 'ftypmif1', 'ftyphevc'].includes(b.subarray(4, 12).toString('latin1')) },
  { mime: 'application/pdf', image: false, test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];
const SHOWABLE = new Set(TYPES.filter((t) => t.image).map((t) => t.mime));

module.exports = function jobFileRoutes(db) {
  const router = express.Router();
  // Files land in a temporary folder and are saved one at a time, so a batch of large phone
  // photos never has to sit in memory all at once.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-job-files-'));
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 5 } }).array('files', MAX_FILES);
  const cleanUp = (files) => { for (const f of files || []) fs.rm(f.path, { force: true }, () => {}); };

  function ownedJob(req, res) {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) && db.prepare('SELECT id FROM maintenance_jobs WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!job) res.status(404).render('error', { title: 'Not found', message: 'That maintenance job was not found.' });
    return job;
  }
  const back = (res, id, key, msg) => res.redirect(`/app/maintenance/${id}?${key}=${encodeURIComponent(msg)}#files`);

  router.post('/:id(\\d+)/files', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 25 MB.' : err.code === 'LIMIT_FILE_COUNT' ? `Upload up to ${MAX_FILES} files at a time.` : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, (req, res) => {
    const all = req.files || [];
    res.on('finish', () => cleanUp(all));
    const job = ownedJob(req, res);
    if (!job) return;
    if (req.uploadError) return back(res, job.id, 'error', req.uploadError);
    const files = all.filter((f) => f.size);
    if (!files.length) return back(res, job.id, 'error', 'Choose one or more photos or files to upload.');
    const insert = db.prepare('INSERT INTO maintenance_files (account_id, job_id, filename, mime, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const refused = [];
    let saved = 0;
    for (const f of files) {
      const buffer = fs.readFileSync(f.path);
      const type = TYPES.find((t) => t.test(buffer));
      const name = path.basename(String(f.originalname || 'file')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'file';
      if (!type) { refused.push(name); continue; }
      insert.run(req.user.id, job.id, name, type.mime, f.size, buffer, req.user.person_id);
      saved += 1;
    }
    const msg = `Uploaded ${saved} file${saved === 1 ? '' : 's'}.`;
    if (refused.length) return back(res, job.id, 'error', `${saved ? msg + ' ' : ''}Not uploaded (use photos, PDFs or iPhone HEIC files): ${refused.join(', ')}.`);
    back(res, job.id, 'flash', msg);
  });

  router.get('/:id(\\d+)/files/:fid(\\d+)', (req, res) => {
    const f = db.prepare('SELECT filename, mime, data FROM maintenance_files WHERE id = ? AND job_id = ? AND account_id = ?').get(Number(req.params.fid), Number(req.params.id), req.user.id);
    if (!f) return res.status(404).render('error', { title: 'Not found', message: 'That file was not found.' });
    const inline = req.query.download !== '1' && (SHOWABLE.has(f.mime) || f.mime === 'application/pdf');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; object-src 'self'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(Buffer.from(f.data));
  });

  router.post('/:id(\\d+)/files/:fid(\\d+)/delete', (req, res) => {
    const job = ownedJob(req, res);
    if (!job) return;
    db.prepare('DELETE FROM maintenance_files WHERE id = ? AND job_id = ? AND account_id = ?').run(Number(req.params.fid), job.id, req.user.id);
    back(res, job.id, 'flash', 'File removed.');
  });

  return router;
};

module.exports.SHOWABLE = SHOWABLE;
