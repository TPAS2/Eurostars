'use strict';

// Property safety inspection sheets: the blank template, each inspection's filled-in sheet (as a
// PDF), and the tenant's signature drawn on screen.

const express = require('express');
const fmt = require('../format');
const { buildInspectionSheet } = require('../inspectionSheet');
const { readSignature } = require('../signature');

module.exports = function inspectionSheetRoutes(db) {
  const router = express.Router();

  const companyName = (a) => db.prepare('SELECT agency_name FROM users WHERE id = ?').get(a).agency_name;
  const sendPdf = (res, bytes, name) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(bytes));
  };
  function owned(req, res) {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && db.prepare('SELECT * FROM inspections WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!row) res.status(404).render('error', { title: 'Not found', message: 'That inspection was not found.' });
    return row;
  }
  const back = (res, id, key, msg) => res.redirect(`/app/inspections/${id}?${key}=${encodeURIComponent(msg)}#inspection-sheet`);

  // The blank template, to print and fill in by hand.
  router.get('/sheet.pdf', async (req, res, next) => {
    try {
      sendPdf(res, await buildInspectionSheet({ company: { name: companyName(req.user.id) }, inspection: null }), 'Property safety inspection sheet (blank).pdf');
    } catch (err) { next(err); }
  });

  // An inspection's own sheet, filled in, with the tenant's signature if signed.
  router.get('/:id(\\d+)/sheet.pdf', async (req, res, next) => {
    try {
      const ins = owned(req, res);
      if (!ins) return;
      const a = req.user.id;
      const p = db.prepare('SELECT address_line1, town, postcode FROM properties WHERE id = ? AND account_id = ?').get(ins.property_id, a) || {};
      const by = ins.inspected_by ? db.prepare('SELECT name FROM users WHERE id = ? AND (id = ? OR company_id = ?)').get(ins.inspected_by, a, a) : null;
      const s = db.prepare('SELECT signer_name, png, signed_at FROM inspection_signatures WHERE account_id = ? AND inspection_id = ?').get(a, ins.id);
      const address = [p.address_line1, p.town, p.postcode].filter(Boolean).join(', ');
      const pdf = await buildInspectionSheet({
        company: { name: companyName(a) },
        inspection: { address, date: fmt.ukDate(ins.inspection_date), inspectedBy: by ? by.name : '', checklist: ins.checklist, notes: ins.notes },
        signature: s ? { png: Buffer.from(s.png), name: s.signer_name, date: fmt.ukDate(s.signed_at.slice(0, 10)) } : null,
      });
      const name = `Inspection ${ins.inspection_date} ${String(p.address_line1 || '').replace(/[^\w ,.-]/g, '').trim().slice(0, 60)}`.trim();
      sendPdf(res, pdf, `${name}.pdf`);
    } catch (err) { next(err); }
  });

  router.post('/:id(\\d+)/sign', (req, res) => {
    const ins = owned(req, res);
    if (!ins) return;
    const { png, error } = readSignature(req.body.signature);
    if (error) return back(res, ins.id, 'error', error);
    const name = String(req.body.name || '').trim().slice(0, 100);
    db.prepare(
      `INSERT INTO inspection_signatures (account_id, inspection_id, signer_name, png) VALUES (?, ?, ?, ?)
       ON CONFLICT(inspection_id) DO UPDATE SET signer_name = excluded.signer_name, png = excluded.png, signed_at = datetime('now')`
    ).run(req.user.id, ins.id, name || null, png);
    back(res, ins.id, 'flash', 'Tenant’s signature saved.');
  });

  router.get('/:id(\\d+)/sign.png', (req, res) => {
    const s = db.prepare('SELECT png FROM inspection_signatures WHERE account_id = ? AND inspection_id = ?').get(req.user.id, Number(req.params.id));
    if (!s) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(s.png));
  });

  router.post('/:id(\\d+)/sign/delete', (req, res) => {
    const ins = owned(req, res);
    if (!ins) return;
    db.prepare('DELETE FROM inspection_signatures WHERE account_id = ? AND inspection_id = ?').run(req.user.id, ins.id);
    back(res, ins.id, 'flash', 'Signature removed.');
  });

  return router;
};
