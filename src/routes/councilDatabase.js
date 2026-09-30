'use strict';

// Councils → Database: each council's database. Entries are added and edited here; Live ones
// can be ended (given a cancellation date), which moves them to Previous tenant. The whole
// database downloads as an Excel workbook laid out like the agency's own.

const express = require('express');
const fmt = require('../format');
const { HEADINGS, SHEETS, councilWorkbook, databaseFilename } = require('../councilDatabase');

const TEXT_MAX = 300;

module.exports = function councilDatabaseRoutes(db) {
  const router = express.Router();

  function council(req, res) {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) && db.prepare('SELECT id, name FROM councils WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!c) res.status(404).render('error', { title: 'Not found', message: 'That council was not found.' });
    return c;
  }
  function entry(req, res, c) {
    const id = Number(req.params.eid);
    const e = Number.isInteger(id) && db.prepare('SELECT * FROM council_db_entries WHERE id = ? AND council_id = ? AND account_id = ?').get(id, c.id, req.user.id);
    if (!e) res.status(404).render('error', { title: 'Not found', message: 'That entry was not found.' });
    return e;
  }
  const entries = (accountId, councilId) => {
    const all = db.prepare('SELECT * FROM council_db_entries WHERE account_id = ? AND council_id = ? ORDER BY our_ref COLLATE NOCASE, id').all(accountId, councilId);
    return { live: all.filter((e) => !e.ended), previous: all.filter((e) => e.ended) };
  };
  const back = (res, c, key, msg, hash = '') => res.redirect(`/app/councils/${c.id}/database?${key}=${encodeURIComponent(msg)}${hash}`);

  // Reads the entry form: dates must be dates, the price a sum of money; everything else is text.
  function parse(body) {
    const values = {};
    const errors = {};
    for (const h of HEADINGS) {
      const raw = String(body[h.key] ?? '').trim();
      if (h.date) {
        if (raw && !fmt.isIsoDate(raw)) errors[h.key] = 'Enter a valid date.';
        values[h.key] = raw || null;
      } else if (h.money) {
        const p = raw ? fmt.parseMoney(raw) : null;
        if (raw && (Number.isNaN(p) || p < 0)) errors[h.key] = 'Enter an amount like 56 or 56.00.';
        values[h.key] = raw ? p : null;
      } else {
        values[h.key] = raw.slice(0, TEXT_MAX) || null;
      }
    }
    if (!values.property_address && !values.client_name && !values.our_ref) errors.form = 'Enter at least the reference, property address or client’s name.';
    return { values, errors };
  }
  const formValues = (e) => Object.fromEntries(HEADINGS.map((h) => [h.key, h.money ? (e[h.key] == null ? '' : fmt.penceToInput(e[h.key])) : (e[h.key] || '')]));

  function renderPage(req, res, c, extra = {}) {
    const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(req.user.id);
    res.status(extra.status || 200).render('councildb', {
      title: `${c.name} database`, section: 'councils', council: c, headings: HEADINGS, sheets: SHEETS,
      titleRow: `${c.name.toUpperCase()} - ${agency.agency_name.toUpperCase()}`, filename: databaseFilename(c.name),
      entries: entries(req.user.id, c.id), fmt, today: fmt.today(),
      values: extra.values || {}, errors: extra.errors || {},
      flash: String(req.query.flash || '').slice(0, 300), error: String(req.query.error || '').slice(0, 300),
    });
  }

  router.get('/:id/database', (req, res) => {
    const c = council(req, res);
    if (c) renderPage(req, res, c);
  });

  // Add an entry to the Live sheet.
  router.post('/:id/database/entries', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const { values, errors } = parse(req.body);
    if (Object.keys(errors).length) return back(res, c, 'error', errors.form || Object.values(errors)[0], '#live');
    const cols = Object.keys(values);
    db.prepare(`INSERT INTO council_db_entries (account_id, council_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
      .run(req.user.id, c.id, ...cols.map((k) => values[k]));
    back(res, c, 'flash', 'Entry added to Live.', '#live');
  });

  router.get('/:id/database/entries/:eid/edit', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const e = entry(req, res, c);
    if (!e) return;
    res.render('councildb-entry', { title: `Edit entry · ${c.name}`, section: 'councils', council: c, e, headings: HEADINGS, values: formValues(e), errors: {} });
  });

  router.post('/:id/database/entries/:eid', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const e = entry(req, res, c);
    if (!e) return;
    const { values, errors } = parse(req.body);
    const autosave = req.get('X-Autosave') === '1';
    // Typed straight into the table: the cancellation date only belongs to ended entries.
    if (autosave && !e.ended) values.cancellation_date = e.cancellation_date;
    if (autosave && Object.keys(errors).length) return res.status(422).json({ ok: false, errors });
    if (Object.keys(errors).length) {
      return res.status(422).render('councildb-entry', { title: `Edit entry · ${c.name}`, section: 'councils', council: c, e, headings: HEADINGS, values: req.body, errors });
    }
    const cols = Object.keys(values);
    db.prepare(`UPDATE council_db_entries SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND account_id = ?`)
      .run(...cols.map((k) => values[k]), e.id, req.user.id);
    if (autosave) return res.json({ ok: true, savedAt: new Date().toISOString() });
    back(res, c, 'flash', 'Entry saved.', e.ended ? '#previous' : '#live');
  });

  // End a Live entry: set its cancellation date and move it to Previous tenant.
  router.post('/:id/database/entries/:eid/end', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const e = entry(req, res, c);
    if (!e) return;
    const date = String(req.body.cancellation_date || '').trim() || fmt.today();
    if (!fmt.isIsoDate(date)) return back(res, c, 'error', 'Enter a valid cancellation date.', '#live');
    if (e.booking_date && date < e.booking_date) return back(res, c, 'error', `The cancellation date can’t be before the booking date (${fmt.ukDate(e.booking_date)}).`, '#live');
    db.prepare('UPDATE council_db_entries SET cancellation_date = ?, ended = 1 WHERE id = ? AND account_id = ?').run(date, e.id, req.user.id);
    back(res, c, 'flash', `Ended ${e.client_name || e.property_address || 'the entry'} on ${fmt.ukDate(date)}. It's now under Previous tenant.`, '#previous');
  });

  // Put an ended entry back on Live (clears the cancellation date).
  router.post('/:id/database/entries/:eid/reopen', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const e = entry(req, res, c);
    if (!e) return;
    db.prepare('UPDATE council_db_entries SET cancellation_date = NULL, ended = 0 WHERE id = ? AND account_id = ?').run(e.id, req.user.id);
    back(res, c, 'flash', 'Moved back to Live.', '#live');
  });

  router.post('/:id/database/entries/:eid/delete', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const e = entry(req, res, c);
    if (!e) return;
    db.prepare('DELETE FROM council_db_entries WHERE id = ? AND account_id = ?').run(e.id, req.user.id);
    back(res, c, 'flash', 'Entry removed.', e.ended ? '#previous' : '#live');
  });

  router.get('/:id/database.xlsx', async (req, res, next) => {
    try {
      const c = council(req, res);
      if (!c) return;
      const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(req.user.id);
      const xlsx = await councilWorkbook({ councilName: c.name, agencyName: agency.agency_name, entries: entries(req.user.id, c.id) });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${databaseFilename(c.name)}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(xlsx);
    } catch (err) { next(err); }
  });

  return router;
};
