'use strict';

// Emailing a property's listing (photos, price, address and key facts) to someone.
// Only the listing is sent: never the landlord, tenants, certificates or anything else.

const express = require('express');
const fmt = require('../format');
const { isEmail } = require('../mailer');
const { senderFor } = require('../sender');
const { buildPropertyPdf } = require('../propertyPdf');

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PER_HOUR = 30;
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const domainOf = (address) => String(address || '').trim().toLowerCase().split('@')[1] || '';

// What the listing shows: only the details that have been filled in.
function listingOf(p) {
  const prices = [];
  if (p.rent_pence) prices.push(`${fmt.money(p.rent_pence)} pcm`);
  if (p.price_per_night_pence) prices.push(`${fmt.money(p.price_per_night_pence)} per night`);
  const facts = [
    ['Property type', p.property_type],
    ['Bedrooms', p.bedrooms || p.bedrooms === 0 ? String(p.bedrooms) : ''],
    ['Bathrooms', p.bathrooms || p.bathrooms === 0 ? String(p.bathrooms) : ''],
    ['Parking', p.parking],
  ].filter(([, v]) => v);
  return { prices, facts, place: [p.town, p.postcode].filter(Boolean).join(', ') };
}

module.exports = function propertyEmailRoutes(db, mailer) {
  const router = express.Router();
  const sent = new Map(); // account id -> times of recent sends

  const back = (res, id, key, msg) => res.redirect(`/app/properties/${id}?${key}=${encodeURIComponent(msg)}#email-listing`);

  // A PDF overview of the listing to download.
  router.get('/:id(\\d+)/overview.pdf', async (req, res, next) => {
    try {
      const a = req.user.id;
      const p = db.prepare('SELECT * FROM properties WHERE id = ? AND account_id = ?').get(Number(req.params.id), a);
      if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That property was not found.' });
      const { prices, facts, place } = listingOf(p);
      const co = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(a);
      const photos = db.prepare("SELECT mime, data FROM property_photos WHERE property_id = ? AND account_id = ? AND mime IN ('image/jpeg', 'image/png') ORDER BY id LIMIT 6").all(p.id, a)
        .map((ph) => ({ mime: ph.mime, data: Buffer.from(ph.data) }));
      const pdf = await buildPropertyPdf({
        agency: co.agency_name, address: p.address_line1, place, prices, facts, status: p.status, date: fmt.ukDate(fmt.today()), photos,
      });
      const name = `${String(p.address_line1).replace(/[^\w ,.-]/g, '').trim().slice(0, 80) || 'Property'} overview.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(Buffer.from(pdf));
    } catch (err) { next(err); }
  });

  router.post('/:id(\\d+)/email', async (req, res, next) => {
    try {
      const a = req.user.id;
      const p = db.prepare('SELECT * FROM properties WHERE id = ? AND account_id = ?').get(Number(req.params.id), a);
      if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That property was not found.' });
      if (!mailer.enabled) return back(res, p.id, 'error', 'Email isn’t set up yet, so the property wasn’t sent.');
      const from = String(req.body.from || '').trim().slice(0, 254);
      const to = String(req.body.to || '').trim().slice(0, 254);
      const note = String(req.body.message || '').trim().slice(0, 2000);
      if (!isEmail(from)) return back(res, p.id, 'error', 'Enter the email address it’s from.');
      if (!isEmail(to)) return back(res, p.id, 'error', 'Enter the email address to send it to.');
      const recent = (sent.get(a) || []).filter((t) => t > Date.now() - 3600e3);
      if (recent.length >= PER_HOUR) return back(res, p.id, 'error', `You can send up to ${PER_HOUR} property emails an hour. Please try again later.`);

      const sender = senderFor(db, mailer, a);
      // The email service only sends from addresses on its own domain. An address on that domain
      // is used as the sender; any other goes in Reply-To, so answers still reach it.
      const usual = sender.from || mailer.defaultFrom;
      const sameDomain = domainOf(from) && domainOf(from) === domainOf(usual);
      const { prices, facts, place } = listingOf(p);

      const photos = [];
      let bytes = 0;
      for (const ph of db.prepare('SELECT id, mime, data FROM property_photos WHERE property_id = ? AND account_id = ? ORDER BY id').all(p.id, a)) {
        if (!INLINE.has(ph.mime) || photos.length >= MAX_PHOTOS || bytes + ph.data.length > MAX_PHOTO_BYTES) continue;
        bytes += ph.data.length;
        photos.push({ cid: `photo${photos.length + 1}@rift`, filename: `photo-${photos.length + 1}.${EXT[ph.mime]}`, content: Buffer.from(ph.data), contentType: ph.mime });
      }

      const title = [p.address_line1, place].filter(Boolean).join(', ');
      const text = [
        note, note ? '' : null,
        title,
        prices.join(' · ') || null,
        ...facts.map(([k, v]) => `${k}: ${v}`),
        '', photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} attached.` : null,
        '', sender.fromName,
      ].filter((l) => l !== null).join('\n');
      const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;">
  <div style="padding:16px 20px;background:#0b1220;color:#ffffff;font-weight:bold;font-size:16px;">${esc(sender.fromName)}</div>
  ${note ? `<p style="padding:16px 20px 0;margin:0;font-size:15px;line-height:1.5;">${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
  ${photos[0] ? `<img src="cid:${photos[0].cid}" alt="" width="640" style="display:block;width:100%;height:auto;margin-top:16px;">` : ''}
  ${photos.length > 1 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="4"><tr>${photos.slice(1, 4).map((ph) => `<td width="33%"><img src="cid:${ph.cid}" alt="" style="display:block;width:100%;height:auto;"></td>`).join('')}</tr></table>` : ''}
  <div style="padding:16px 20px;">
    ${prices.length ? `<div style="font-size:26px;font-weight:bold;">${esc(prices[0])}</div>${prices[1] ? `<div style="font-size:16px;color:#374151;margin-top:2px;">${esc(prices[1])}</div>` : ''}` : ''}
    <div style="font-size:18px;margin-top:8px;">${esc(p.address_line1)}</div>
    ${place ? `<div style="color:#6b7280;margin-top:2px;">${esc(place)}</div>` : ''}
    ${facts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:1px solid #e5e7eb;width:100%;"><tr>${facts.map(([k, v]) => `<td style="padding:12px 8px 0 0;vertical-align:top;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${esc(k)}</div><div style="font-size:16px;font-weight:bold;margin-top:4px;">${esc(v)}</div></td>`).join('')}</tr></table>` : ''}
  </div>
  ${photos.length > 4 ? `<div style="padding:0 20px 16px;">${photos.slice(4).map((ph) => `<img src="cid:${ph.cid}" alt="" style="display:block;width:100%;height:auto;margin-top:6px;">`).join('')}</div>` : ''}
</div></body></html>`;

      try {
        await mailer.send({
          to, subject: `${title}${prices[0] ? ` - ${prices[0]}` : ''}`, text, html, attachments: photos,
          from: sameDomain ? from : sender.from, fromName: sender.fromName, replyTo: from,
        });
      } catch (err) {
        console.error(`Property email for property ${p.id} failed:`, err.message);
        return back(res, p.id, 'error', `The email couldn’t be sent: ${String(err.message).slice(0, 120)}`);
      }
      recent.push(Date.now());
      sent.set(a, recent);
      back(res, p.id, 'flash', `Emailed this property to ${to}.${sameDomain ? '' : ` Replies will go to ${from}.`}`);
    } catch (err) { next(err); }
  });

  return router;
};

module.exports.listingOf = listingOf;
