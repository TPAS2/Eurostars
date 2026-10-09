'use strict';

// Rent run step 5.2: send an email with files attached (e.g. the Metro bulk payment files to the
// bank), laid out like an email: From, To, Cc, Bcc, Subject, the message and the attachments.
// What's sent is noted (who to, the subject and the files' names), not the files themselves.

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const auth = require('../auth');
const fmt = require('../format');
const st = require('../statements');
const { isEmail } = require('../mailer');
const { senderFor } = require('../sender');

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const PER_HOUR = 30;

const domainOf = (address) => String(address || '').trim().toLowerCase().split('@')[1] || '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// "a@x.com, b@y.com; c@z.com" into a list.
const addresses = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

// page: where it's used ('rent-run' or 'council-invoices'); emails are noted against that page.
module.exports = function rentRunEmailRoutes(db, mailer, { page = 'rent-run' } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 20 } }).array('files', MAX_FILES);
  const sent = new Map(); // account → times of recent sends

  router.post('/send-email', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Attach up to ${MAX_FILES} files.` : 'The upload failed. Please try again.';
      }
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, async (req, res, next) => {
    try {
      const a = req.user.id;
      const month = st.isMonth(req.body.month) ? String(req.body.month) : fmt.today().slice(0, 7);
      const back = (key, msg) => res.redirect(`/app/${page}?month=${month}&${key}=${encodeURIComponent(msg)}#send-email`);
      if (req.uploadError) return back('error', req.uploadError);
      if (!mailer.enabled) return back('error', 'Email isn’t set up yet, so nothing was sent. Ask your administrator to add the email settings.');
      const from = String(req.body.from || '').trim().slice(0, 254);
      const to = addresses(req.body.to);
      const cc = addresses(req.body.cc);
      const bcc = addresses(req.body.bcc);
      const subject = String(req.body.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
      const message = String(req.body.message || '').slice(0, 20000);
      if (!isEmail(from)) return back('error', 'Enter the email address it’s sent from.');
      if (!to.length) return back('error', 'Enter who to send it to.');
      const bad = [...to, ...cc, ...bcc].find((x) => !isEmail(x));
      if (bad) return back('error', `“${bad.slice(0, 80)}” isn’t a valid email address.`);
      if (to.length + cc.length + bcc.length > 20) return back('error', 'Send it to 20 people or fewer at a time.');
      if (!subject) return back('error', 'Enter a subject.');
      const files = (req.files || []).filter((f) => f.size);
      if (files.reduce((t, f) => t + f.size, 0) > MAX_TOTAL_BYTES) return back('error', 'The attachments come to more than 25 MB. Send fewer or smaller files.');
      const recent = (sent.get(a) || []).filter((t) => t > Date.now() - 3600e3);
      if (recent.length >= PER_HOUR) return back('error', `You can send up to ${PER_HOUR} of these emails an hour. Please try again later.`);

      const sender = senderFor(db, mailer, a);
      // The email service only sends from addresses on its own domain. An address on that domain
      // is used as the sender; any other goes in Reply-To, so answers still reach it.
      const usual = sender.from || mailer.defaultFrom;
      const sameDomain = domainOf(from) && domainOf(from) === domainOf(usual);
      const attachments = files.map((f) => ({
        filename: path.basename(String(f.originalname || 'file')).replace(/[\r\n"\\]/g, '_').slice(0, 150) || 'file',
        content: f.buffer, contentType: f.mimetype || 'application/octet-stream',
      }));
      const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827;">${esc(message).replace(/\r?\n/g, '<br>')}</body></html>`;
      try {
        await mailer.send({
          to, cc, bcc, subject, text: message, html, attachments,
          from: sameDomain ? from : sender.from, fromName: sender.fromName, replyTo: from,
        });
      } catch (err) {
        console.error(`Rent run email for account ${a} failed:`, err.message);
        return back('error', `The email couldn’t be sent: ${String(err.message).slice(0, 160)}`);
      }
      recent.push(Date.now());
      sent.set(a, recent);
      db.prepare(`INSERT INTO rentrun_emails (account_id, page, month, from_addr, to_addr, cc, bcc, subject, files, sent_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a, page, month, from, to.join(', '), cc.join(', ') || null, bcc.join(', ') || null, subject,
        attachments.map((x) => x.filename).join(', ') || null, req.user.person_id || a);
      back('flash', `Email sent to ${to.join(', ')}${cc.length ? ` (cc ${cc.join(', ')})` : ''}${attachments.length ? ` with ${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : ''}.${sameDomain ? '' : ` Replies will go to ${from}.`}`);
    } catch (err) { next(err); }
  });

  return router;
};

// What the email box on a page needs: who it's from, a subject, and what was sent that month.
module.exports.emailOutFor = (db, mailer, { accountId, personId, page, month, subject }) => {
  const me = db.prepare('SELECT COALESCE(m.email, c.email) AS email FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?').get(personId || accountId);
  return {
    from: senderFor(db, mailer, accountId).from || (me && me.email) || mailer.defaultFrom || '',
    subject,
    sent: db.prepare(`SELECT e.*, u.name AS sent_by_name FROM rentrun_emails e LEFT JOIN users u ON u.id = e.sent_by
      WHERE e.account_id = ? AND COALESCE(e.page, 'rent-run') = ? AND e.month = ? ORDER BY e.sent_at DESC, e.id DESC`).all(accountId, page, month),
  };
};
