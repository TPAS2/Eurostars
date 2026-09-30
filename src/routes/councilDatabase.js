'use strict';

// Councils → Database: each council's database (Live and Previous tenant sheets), to view and
// download as an Excel workbook.

const express = require('express');
const { HEADINGS, SHEETS, councilWorkbook, databaseFilename } = require('../councilDatabase');

module.exports = function councilDatabaseRoutes(db) {
  const router = express.Router();

  function council(req, res) {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) && db.prepare('SELECT id, name FROM councils WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!c) res.status(404).render('error', { title: 'Not found', message: 'That council was not found.' });
    return c;
  }

  router.get('/:id/database', (req, res) => {
    const c = council(req, res);
    if (!c) return;
    const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(req.user.id);
    res.render('councildb', {
      title: `${c.name} database`, section: 'councils', council: c, headings: HEADINGS, sheets: SHEETS,
      titleRow: `${c.name.toUpperCase()} - ${agency.agency_name.toUpperCase()}`, filename: databaseFilename(c.name),
    });
  });

  router.get('/:id/database.xlsx', async (req, res, next) => {
    try {
      const c = council(req, res);
      if (!c) return;
      const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(req.user.id);
      const xlsx = await councilWorkbook({ councilName: c.name, agencyName: agency.agency_name });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${databaseFilename(c.name)}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(xlsx);
    } catch (err) { next(err); }
  });

  return router;
};
