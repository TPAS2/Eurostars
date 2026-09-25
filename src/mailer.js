'use strict';

// Sending email: landlord statements and the month-end report.
// Works with Resend (RESEND_API_KEY, over HTTPS) or any SMTP server (SMTP_URL or
// SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS). EMAIL_FROM is the sending address.

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function isEmail(s) {
  return EMAIL_RE.test(String(s || '').trim()) && String(s).length <= 254;
}

// "Agency Name" <address>, with the name made safe for a header.
function fromHeader(name, address) {
  const clean = String(name || '').replace(/["\\\r\n<>]/g, '').trim().slice(0, 80);
  return clean ? `"${clean}" <${address}>` : address;
}

function createMailer(config) {
  const from = String(config.emailFrom || '').trim();
  // EMAIL_FROM may be "Name <address>" or just an address.
  const fromAddress = (from.match(/<([^>]+)>/) || [null, from])[1].trim();

  let transport = null;
  let provider = null;
  if (config.resendApiKey && isEmail(fromAddress)) {
    provider = 'Resend';
    let last = 0;
    transport = async (msg) => {
      // Resend allows about two requests a second.
      const wait = last + 550 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
          reply_to: msg.replyTo || undefined,
          attachments: (msg.attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Resend returned ${res.status}`);
      }
    };
  } else if ((config.smtpUrl || config.smtpHost) && isEmail(fromAddress)) {
    provider = 'SMTP';
    const nodemailer = require('nodemailer');
    const smtp = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: (config.smtpPort || 587) === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    });
    transport = (msg) => smtp.sendMail({
      from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo || undefined,
      attachments: (msg.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
  }

  return {
    enabled: !!transport,
    provider,
    // Sends one email. fromName is shown as the sender (e.g. the agency's name).
    async send({ to, subject, text, html, attachments, replyTo, fromName }) {
      if (!transport) throw new Error('Email is not set up.');
      if (!isEmail(to)) throw new Error(`Not a valid email address: ${to}`);
      await transport({
        from: fromHeader(fromName, fromAddress), to: String(to).trim(), subject: String(subject).replace(/[\r\n]+/g, ' '),
        text, html, attachments, replyTo: isEmail(replyTo) ? replyTo : null,
      });
    },
  };
}

module.exports = { createMailer, isEmail };
