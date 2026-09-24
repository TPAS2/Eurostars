'use strict';

const express = require('express');
const fmt = require('../format');
const st = require('../statements');

// Monthly landlord statements with AI-written summaries.
module.exports = function monthlyRoutes(db, writer) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get('/', (req, res) => {
    const a = req.user.id;
    const month = st.isMonth(req.query.month) ? req.query.month : st.previousMonth();
    const rows = db.prepare(
      `SELECT l.id AS landlord_id, l.name, l.email, s.id, s.rent_pence, s.fees_pence, s.expenses_pence, s.net_pence,
              s.closing_pence, s.summary_source, s.generated_at
         FROM landlords l
         LEFT JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
        WHERE l.account_id = ? ORDER BY l.name COLLATE NOCASE`
    ).all(month, a);
    const months = db.prepare('SELECT DISTINCT month FROM monthly_statements WHERE account_id = ? ORDER BY month DESC LIMIT 24').all(a).map((r) => r.month);
    res.render('monthly/index', {
      title: 'Monthly statements', section: 'monthly', month, monthLabel: st.monthLabel(month), rows, months,
      aiEnabled: !!writer, fmt, flash: req.query.flash || '',
    });
  });

  router.post('/generate', wrap(async (req, res) => {
    const a = req.user.id;
    const month = String(req.body.month || '');
    if (!st.isMonth(month)) return res.redirect('/app/monthly?flash=' + encodeURIComponent('Choose a valid month.'));
    const back = (msg) => res.redirect(`/app/monthly?month=${month}&flash=${encodeURIComponent(msg)}`);
    if (req.body.landlord_id) {
      const landlord = db.prepare('SELECT id FROM landlords WHERE id = ? AND account_id = ?').get(Number(req.body.landlord_id), a);
      if (!landlord) return back('Landlord not found.');
      const id = await st.generateStatement(db, { accountId: a, agencyName: req.user.agency_name, landlordId: landlord.id, month, writer });
      return res.redirect(`/app/monthly/${id}`);
    }
    const n = await st.generateForAccount(db, { accountId: a, agencyName: req.user.agency_name, month, writer });
    back(`Generated ${n} statement${n === 1 ? '' : 's'} for ${st.monthLabel(month)}.`);
  }));

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const s = Number.isInteger(id) && db.prepare(
      `SELECT s.*, l.name AS landlord_name, l.address AS landlord_address, l.email AS landlord_email
         FROM monthly_statements s JOIN landlords l ON l.id = s.landlord_id
        WHERE s.id = ? AND s.account_id = ?`
    ).get(id, req.user.id);
    if (!s) return res.status(404).render('error', { title: 'Not found', message: "That statement doesn't exist." });
    const detail = JSON.parse(s.detail_json);
    res.render('monthly/show', {
      title: `${s.landlord_name} · ${st.monthLabel(s.month)}`, section: 'monthly', s, detail,
      monthLabel: st.monthLabel(s.month), fmt,
    });
  });

  return router;
};
