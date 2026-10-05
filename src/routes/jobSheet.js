'use strict';

// Maintenance job sheets: the blank template, each job's filled-in sheet, and the tenant's and
// contractor's signatures drawn on screen.

const express = require('express');
const fmt = require('../format');
const { buildJobSheet } = require('../jobSheet');
const { readSignature } = require('../signature');

const RATING = { low: 'Low', normal: 'Normal', high: 'High', emergency: 'Emergency' };

module.exports = function jobSheetRoutes(db) {
  const router = express.Router();

  const company = (a) => {
    const c = db.prepare('SELECT agency_name, address, phone, email FROM users WHERE id = ?').get(a);
    return { name: c.agency_name, address: c.address, phone: c.phone, email: c.email };
  };
  const sendPdf = (res, bytes, name) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(bytes));
  };
  function ownedJob(req, res) {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) && db.prepare('SELECT * FROM maintenance_jobs WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!job) res.status(404).render('error', { title: 'Not found', message: 'That maintenance job was not found.' });
    return job;
  }
  const signaturesOf = (a, jobId) => {
    const out = {};
    for (const s of db.prepare('SELECT role, signer_name, satisfied, png, signed_at FROM job_signatures WHERE account_id = ? AND job_id = ?').all(a, jobId)) {
      out[s.role] = { png: Buffer.from(s.png), name: s.signer_name, satisfied: s.satisfied, date: fmt.ukDate(s.signed_at.slice(0, 10)) };
    }
    return out;
  };

  // Everything printed on a job's sheet.
  function sheetFor(a, job) {
    const p = db.prepare('SELECT * FROM properties WHERE id = ? AND account_id = ?').get(job.property_id, a) || {};
    const landlord = p.landlord_id ? db.prepare('SELECT name FROM landlords WHERE id = ? AND account_id = ?').get(p.landlord_id, a) : null;
    const contractor = job.contractor
      ? db.prepare('SELECT name, code, address, phone, mobile, fax, email FROM contractors WHERE account_id = ? AND name = ? COLLATE NOCASE').get(a, job.contractor) || { name: job.contractor }
      : {};
    const tenants = db.prepare(
      `SELECT t.name, t.phone FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id
        WHERE ty.account_id = ? AND ty.property_id = ? AND ty.status IN ('active', 'pending')
        ORDER BY ty.status = 'active' DESC, t.name COLLATE NOCASE`
    ).all(a, job.property_id);
    return {
      number: job.id,
      date: fmt.ukDate(String(job.created_at || fmt.today()).slice(0, 10)),
      contractor,
      propertyCode: p.code || '',
      propertyAddress: [p.address_line1, p.town, p.postcode].filter(Boolean).join(' '),
      billingName: landlord ? landlord.name : '',
      dateReported: job.reported_date ? fmt.ukDate(job.reported_date) : '',
      estimateRequired: job.estimate_required || 'No',
      ourEstimate: fmt.money(job.cost_pence || 0),
      preferredStart: job.preferred_start_date ? fmt.ukDate(job.preferred_start_date) : 'N/A',
      goAhead: job.go_ahead || 'No',
      rating: RATING[job.priority] || job.priority || '',
      access: [p.address_line1, ...tenants.map((t) => `${t.name}${t.phone ? ` - Tel: ${t.phone}` : ''}`)].filter(Boolean),
      work: [job.title, ...String(job.description || '').split(/\r?\n/)].map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`),
    };
  }

  // The blank template, with the company's heading, to print and fill in by hand.
  router.get('/job-sheet.pdf', async (req, res, next) => {
    try {
      sendPdf(res, await buildJobSheet({ company: company(req.user.id), job: null }), 'Job sheet (blank).pdf');
    } catch (err) { next(err); }
  });

  // A job's own sheet, filled in, with any signatures.
  router.get('/:id(\\d+)/job-sheet.pdf', async (req, res, next) => {
    try {
      const job = ownedJob(req, res);
      if (!job) return;
      const a = req.user.id;
      sendPdf(res, await buildJobSheet({ company: company(a), job: sheetFor(a, job), signatures: signaturesOf(a, job.id) }), `Job sheet ${job.id}.pdf`);
    } catch (err) { next(err); }
  });

  const back = (res, id, key, msg) => res.redirect(`/app/maintenance/${id}?${key}=${encodeURIComponent(msg)}#job-sheet`);

  // Saving a signature drawn on screen (sent as a PNG picture).
  router.post('/:id(\\d+)/sign/:role(tenant|contractor)', (req, res) => {
    const job = ownedJob(req, res);
    if (!job) return;
    const role = req.params.role;
    const { png, error } = readSignature(req.body.signature);
    if (error) return back(res, job.id, 'error', error);
    const name = String(req.body.name || '').trim().slice(0, 100);
    const satisfied = role === 'tenant' ? (['Yes', 'No'].includes(req.body.satisfied) ? req.body.satisfied : null) : null;
    if (role === 'tenant' && !satisfied) return back(res, job.id, 'error', 'Choose whether the work was done to the tenant’s satisfaction.');
    db.prepare(
      `INSERT INTO job_signatures (account_id, job_id, role, signer_name, satisfied, png) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, role) DO UPDATE SET signer_name = excluded.signer_name, satisfied = excluded.satisfied, png = excluded.png, signed_at = datetime('now')`
    ).run(req.user.id, job.id, role, name || null, satisfied, png);
    back(res, job.id, 'flash', role === 'tenant' ? 'Tenant’s signature saved.' : 'Maintenance / contractor signature saved.');
  });

  router.get('/:id(\\d+)/sign/:role(tenant|contractor).png', (req, res) => {
    const s = db.prepare('SELECT png FROM job_signatures WHERE account_id = ? AND job_id = ? AND role = ?').get(req.user.id, Number(req.params.id), req.params.role);
    if (!s) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(s.png));
  });

  router.post('/:id(\\d+)/sign/:role(tenant|contractor)/delete', (req, res) => {
    const job = ownedJob(req, res);
    if (!job) return;
    db.prepare('DELETE FROM job_signatures WHERE account_id = ? AND job_id = ? AND role = ?').run(req.user.id, job.id, req.params.role);
    back(res, job.id, 'flash', 'Signature removed.');
  });

  return router;
};

