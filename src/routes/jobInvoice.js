'use strict';

// The landlord's maintenance invoice for a completed job: download (PDF) and email.

const express = require('express');
const fmt = require('../format');
const { isEmail } = require('../mailer');
const { senderFor } = require('../sender');
const { buildJobInvoice, jobInvoiceData } = require('../jobInvoice');

module.exports = function jobInvoiceRoutes(db, mailer) {
  const router = express.Router();
  const back = (res, id, key, msg) => res.redirect(`/app/maintenance/${id}?${key}=${encodeURIComponent(msg)}#landlord-invoice`);

  // The job's invoice details, or an error page. The invoice is dated the first time it's made.
  function load(req, res) {
    const id = Number(req.params.id);
    const data = Number.isInteger(id) && jobInvoiceData(db, req.user.id, id);
    if (!data) { res.status(404).render('error', { title: 'Not found', message: 'That maintenance job was not found.' }); return null; }
    if (data.job.status !== 'completed') { back(res, id, 'error', 'The invoice is ready once the job is marked completed.'); return null; }
    if (!data.job.invoice_date) {
      db.prepare('UPDATE maintenance_jobs SET invoice_date = ? WHERE id = ?').run(fmt.today(), id);
      return jobInvoiceData(db, req.user.id, id);
    }
    return data;
  }

  router.get('/:id/invoice.pdf', async (req, res, next) => {
    try {
      const data = load(req, res);
      if (!data) return;
      const pdf = await buildJobInvoice(data.pdf);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${data.filename}"`);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; object-src 'self'");
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(Buffer.from(pdf));
    } catch (err) { next(err); }
  });

  // Change the date on the invoice.
  router.post('/:id/invoice/date', (req, res) => {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) && db.prepare('SELECT id FROM maintenance_jobs WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!job) return res.status(404).render('error', { title: 'Not found', message: 'That maintenance job was not found.' });
    const date = String(req.body.invoice_date || '').trim();
    if (!fmt.isIsoDate(date)) return back(res, id, 'error', 'Choose the invoice date.');
    db.prepare('UPDATE maintenance_jobs SET invoice_date = ? WHERE id = ?').run(date, id);
    back(res, id, 'flash', `Invoice dated ${fmt.ukDate(date)}.`);
  });

  router.post('/:id/invoice/email', async (req, res, next) => {
    try {
      const data = load(req, res);
      if (!data) return;
      const id = data.job.id;
      if (!mailer.enabled) return back(res, id, 'error', 'Email isn’t set up yet, so the invoice wasn’t sent. Download it instead.');
      const to = String(req.body.to || '').trim();
      if (!isEmail(to)) return back(res, id, 'error', 'Enter the email address to send the invoice to.');
      const sender = senderFor(db, mailer, req.user.id);
      const co = data.pdf.company;
      const where = data.pdf.property.join(', ');
      const text = [
        `Dear ${data.pdf.client || 'Sir/Madam'},`, '',
        `Please find attached our maintenance invoice for ${where}: ${data.job.title}.`,
        `Total: ${fmt.money(data.pdf.totalPence)}. This will be deducted from the rent payment.`, '',
        'If you have any questions, just reply to this email.', '',
        co.name,
      ].join('\n');
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      try {
        await mailer.send({
          to, subject: `Maintenance invoice - ${where}`, text,
          html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;"><p>${esc(text).replace(/\n/g, '<br>')}</p></body></html>`,
          from: sender.from, fromName: sender.fromName, replyTo: sender.replyTo,
          attachments: [{ filename: data.filename, content: Buffer.from(await buildJobInvoice(data.pdf)), contentType: 'application/pdf' }],
        });
      } catch (err) {
        console.error(`Maintenance invoice email for job ${id} failed:`, err.message);
        return back(res, id, 'error', `The invoice couldn’t be sent: ${String(err.message).slice(0, 120)}`);
      }
      db.prepare("UPDATE maintenance_jobs SET invoice_emailed_at = datetime('now'), invoice_emailed_to = ? WHERE id = ?").run(to, id);
      back(res, id, 'flash', `Emailed the invoice to ${to}.`);
    } catch (err) { next(err); }
  });

  return router;
};
