'use strict';

// Contractors export and import: a CSV file of an agency's contractors, so the same contractors can
// be brought into another agency. Import also reads a table in a Word document (.docx) or an Excel
// workbook's first sheet (.xlsx). Importing adds the ones that aren't there yet (matched by name)
// and fills in any blank details on the ones that are; it never overwrites what's already saved.

const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const { csvCell } = require('../monthend');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const COLUMNS = [
  ['code', 'Contractor code'], ['name', 'Company'], ['trade', 'Trade'], ['phone', 'Phone'], ['mobile', 'Mobile'],
  ['fax', 'Fax'], ['email', 'Email'], ['address', 'Address'], ['notes', 'Notes'],
];
const LIMITS = { code: 30, name: 200, trade: 100, phone: 50, mobile: 50, fax: 50, email: 254, address: 500, notes: 2000 };

// A CSV file into rows of cells (quotes, doubled quotes and line breaks inside quotes allowed).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Rows of cells from a Word document's tables (.docx): each cell's paragraphs on their own lines.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()]));
function docxRows(xml) {
  const rows = [];
  for (const tr of xml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []) {
    rows.push((tr.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || []).map((tc) => (tc.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) || [])
      .map((p) => xmlText(p.replace(/<w:(br|cr)\b[^>]*\/>/g, '\n').replace(/<w:tab\b[^>]*\/>/g, ' ')
        .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '\u0000$1\u0000').split('\u0000').filter((_, i) => i % 2).join('')))
      .join('\n').trim()));
  }
  return rows;
}

// The rows of an uploaded file: CSV, a Word document's table, or an Excel workbook's first sheet.
async function fileRows(buffer) {
  if (buffer.subarray(0, 2).toString() !== 'PK') return { rows: parseCsv(buffer.toString('utf8').replace(/^\ufeff/, '')) };
  let zip;
  try { zip = await require('jszip').loadAsync(buffer); } catch { return { error: 'That file couldn\u2019t be opened. Use a .csv, .docx or .xlsx file.' }; }
  const big = (f) => f && f._data && f._data.uncompressedSize > 20 * 1024 * 1024;
  const doc = zip.file('word/document.xml');
  if (doc) {
    if (big(doc)) return { error: 'That Word document is too big to import.' };
    return { rows: docxRows(await doc.async('string')) };
  }
  if (zip.file('xl/workbook.xml')) {
    if (Object.values(zip.files).some(big)) return { error: 'That Excel file is too big to import.' };
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.worksheets[0];
    const rows = [];
    if (sheet) sheet.eachRow({ includeEmpty: false }, (row) => { const cells = []; row.eachCell({ includeEmpty: true }, (cell, n) => { cells[n - 1] = cell.text || ''; }); rows.push(Array.from(cells, (c) => c || '')); });
    return { rows };
  }
  return { error: 'That file couldn\u2019t be read. Use a .csv, .docx or .xlsx file.' };
}

// Other headings people use for the same columns.
const ALIASES = {
  code: ['code', 'contractor code', 'ref', 'reference'], name: ['company', 'name', 'company name', 'contractor', 'contractor name', 'business', 'supplier'],
  trade: ['trade', 'service', 'type'], phone: ['phone', 'telephone', 'tel', 'tel.', 'phone number', 'landline'], mobile: ['mobile', 'mobile number', 'mob', 'cell'],
  fax: ['fax'], email: ['email', 'e-mail', 'email address'], address: ['address'], notes: ['notes', 'note', 'comments'],
};

// Undo the apostrophe the export puts in front of anything a spreadsheet would read as a formula.
const clean = (v, max) => String(v || '').replace(/^'(?=[=+\-@])/, '').trim().slice(0, max);

module.exports = function contractorsTransferRoutes(db) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file');

  router.get('/export.csv', (req, res) => {
    const rows = db.prepare(`SELECT ${COLUMNS.map(([c]) => c).join(', ')} FROM contractors WHERE account_id = ?
      ORDER BY CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, name COLLATE NOCASE`).all(req.user.id);
    const lines = [COLUMNS.map(([, h]) => csvCell(h)).join(','), ...rows.map((r) => COLUMNS.map(([c]) => csvCell(r[c] ?? '')).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contractors.csv"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(`﻿${lines.join('\r\n')}\r\n`);
  });

  function nextCode(a) {
    let best = null;
    for (const { code } of db.prepare("SELECT code FROM contractors WHERE account_id = ? AND code IS NOT NULL AND code != ''").all(a)) {
      const m = /^(.*?)(\d+)$/.exec(String(code).trim());
      if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1], n: Number(m[2]), width: m[2].length };
    }
    if (!best) best = { prefix: 'C', n: 0, width: 4 };
    let code;
    do { best.n += 1; code = `${best.prefix}${String(best.n).padStart(best.width, '0')}`; } while (db.prepare('SELECT 1 FROM contractors WHERE account_id = ? AND code = ?').get(a, code));
    return code;
  }

  router.post('/import', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, async (req, res, next) => {
    const a = req.user.id;
    const back = (key, msg) => res.redirect(`/app/contractors?${key}=${encodeURIComponent(msg)}`);
    if (req.uploadError) return back('error', req.uploadError);
    if (!req.file || !req.file.size) return back('error', 'Choose the contractors file (.csv, .docx or .xlsx) to import.');
    let read;
    try { read = await fileRows(req.file.buffer); } catch (err) { return next(err); }
    if (read.error) return back('error', read.error);
    const rows = read.rows;
    // The heading row: the first (of the first 15) with a Company or Name column, so a title above the table is fine.
    const norm = (h) => String(h || '').trim().toLowerCase().replace(/[:*]+$/, '').trim();
    const headAt = rows.slice(0, 15).findIndex((r) => r.some((h) => ALIASES.name.includes(norm(h))));
    if (headAt < 0) return back('error', 'That file has no Company column. Use a file exported from Contractors, or a table with a Company heading.');
    const head = rows[headAt].map(norm);
    rows.splice(0, headAt + 1);
    // Columns by their heading (the export's, or other usual names for them).
    const at = Object.fromEntries(COLUMNS.map(([c]) => [c, ALIASES[c].reduce((found, h) => (found >= 0 ? found : head.indexOf(h)), -1)]));
    if (rows.length > MAX_ROWS) return back('error', `That file has more than ${MAX_ROWS} contractors.`);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const v = Object.fromEntries(COLUMNS.map(([c]) => [c, at[c] >= 0 ? clean(r[at[c]], LIMITS[c]) : '']));
        if (!v.name) { skipped += 1; continue; }
        const have = db.prepare('SELECT * FROM contractors WHERE account_id = ? AND lower(name) = lower(?)').get(a, v.name);
        if (have) {
          // Only fill in what's blank here.
          const fill = COLUMNS.map(([c]) => c).filter((c) => c !== 'name' && c !== 'code' && v[c] && !String(have[c] || '').trim());
          if (fill.length) {
            db.prepare(`UPDATE contractors SET ${fill.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND account_id = ?`).run(...fill.map((c) => v[c]), have.id, a);
            updated += 1;
          } else skipped += 1;
          continue;
        }
        // Keep the file's code unless it's already used here; otherwise the next one.
        const code = v.code && !db.prepare('SELECT 1 FROM contractors WHERE account_id = ? AND code = ?').get(a, v.code) ? v.code : nextCode(a);
        db.prepare(`INSERT INTO contractors (account_id, code, name, trade, phone, mobile, fax, email, address, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a, code, v.name, v.trade || null, v.phone || null, v.mobile || null, v.fax || null, v.email || null, v.address || null, v.notes || null);
        added += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Contractor import failed:', err.message);
      return back('error', 'The import failed, so nothing was changed. Check the file and try again.');
    }
    back('flash', `Imported contractors: ${added} new, ${updated} updated with missing details, ${skipped} already here.`);
  });

  return router;
};

module.exports.parseCsv = parseCsv;
module.exports.docxRows = docxRows;
