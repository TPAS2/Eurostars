'use strict';

// Export and import for contractors, landlords, properties and tenants: a CSV file of an agency's
// records, so the same ones can be brought into another agency. Import also reads a table in a Word
// document (.docx) or an Excel workbook's first sheet (.xlsx). Importing adds the ones that aren't
// there yet (matched by company/name, or property address) and fills in any blank details on the
// ones that are; it never overwrites what's already saved.

const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const { csvCell } = require('../monthend');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const fmt = require('../format');

// What each list exports and imports: [field, heading, other headings people use, type].
// Types: text (with a length), select (options), int, number, money (pence), date, landlord, council.
const T = (max) => ({ type: 'text', max });
const KINDS = {
  contractors: {
    table: 'contractors', label: 'contractors', file: 'contractors.csv', key: 'name', codePrefix: 'C',
    keyHelp: 'Company', order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, name COLLATE NOCASE",
    columns: [
      ['code', 'Contractor code', ['code', 'ref', 'reference'], T(30)],
      ['name', 'Company', ['name', 'company name', 'contractor', 'contractor name', 'business', 'supplier'], T(200)],
      ['trade', 'Trade', ['service', 'type'], T(100)],
      ['phone', 'Phone', ['telephone', 'tel', 'tel.', 'phone number', 'landline'], T(50)],
      ['mobile', 'Mobile', ['mobile number', 'mob', 'cell'], T(50)],
      ['fax', 'Fax', [], T(50)],
      ['email', 'Email', ['e-mail', 'email address'], T(254)],
      ['address', 'Address', [], T(500)],
      ['notes', 'Notes', ['note', 'comments'], T(2000)],
    ],
  },
  landlords: {
    table: 'landlords', label: 'landlords', file: 'landlords.csv', key: 'name', codePrefix: 'L', keyHelp: 'Name',
    order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, name COLLATE NOCASE",
    columns: [
      ['code', 'Landlord code', ['code', 'lcode', 'ref', 'reference'], T(30)],
      ['name', 'Name', ['landlord', 'landlord name', 'full name'], T(200)],
      ['address', 'Correspondence address', ['address'], T(1000)],
      ['statement_type', 'Statement type', [], { type: 'select', options: ['Email', 'Cheque'], default: 'Email' }],
      ['phone', 'Telephone number', ['phone', 'telephone', 'tel', 'mobile'], T(50)],
      ['date_started', 'Lease commencement date', ['lease date', 'start date', 'date started'], { type: 'date' }],
      ['email', 'Email', ['e-mail', 'email address'], T(254)],
      ['overseas', 'Overseas landlord', ['overseas'], { type: 'select', options: ['No', 'Yes'], default: 'No' }],
      ['bank_name', 'Bank name', ['bank'], T(100)],
      ['bank_account_name', 'Account name', ['bank account name'], T(200)],
      ['bank_account_number', 'Account number', ['bank account number'], T(20)],
      ['bank_sort_code', 'Sort code', ['bank sort code'], T(20)],
      ['payment_note', 'Payment terms', ['payment note'], { type: 'select', options: ['Nightly', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'], default: 'Monthly' }],
      ['notes', 'Notes', ['note', 'comments'], T(2000)],
    ],
  },
  properties: {
    table: 'properties', label: 'properties', file: 'properties.csv', key: 'address_line1', codePrefix: 'P', keyHelp: 'Property address',
    order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, address_line1 COLLATE NOCASE",
    columns: [
      ['code', 'Property code', ['code', 'ref', 'reference'], T(30)],
      ['address_line1', 'Property address', ['address', 'property', 'address line 1'], T(300)],
      ['town', 'Town / city', ['town', 'city'], T(100)],
      ['postcode', 'Postcode', ['post code'], T(20)],
      ['landlord_id', 'Landlord', ['landlord code', 'landlord name'], { type: 'landlord' }],
      ['council_id', 'Council', [], { type: 'council' }],
      ['property_type', 'Type', ['property type'], { type: 'select', options: ['House', 'Flat', 'Maisonette', 'HMO', 'Bungalow', 'Studio', 'Commercial', 'Other'] }],
      ['bedrooms', 'Bedrooms', ['beds'], { type: 'int' }],
      ['bathrooms', 'Bathrooms', ['baths'], { type: 'int' }],
      ['parking', 'Parking', [], { type: 'select', options: ['None', 'Street', 'Permit', 'Driveway', 'Allocated space', 'Garage'] }],
      ['rent_pence', 'Rent from council (£ per month)', ['rent from council', 'council rent', 'rent'], { type: 'money' }],
      ['tenant_rent_pence', 'Rent from tenant (£ per month)', ['rent from tenant', 'tenant rent'], { type: 'money' }],
      ['landlord_rent_pence', 'Rent to landlord (£ per month)', ['rent to landlord', 'landlord rent'], { type: 'money' }],
      ['price_per_night_pence', 'Price per night (£)', ['price per night'], { type: 'money' }],
      ['status', 'Status', [], { type: 'select', options: ['vacant', 'let', 'managed', 'under offer', 'unavailable', 'handed back'], default: 'vacant' }],
      ['management_fee_pct', 'Management fee %', ['management fee', 'fee %'], { type: 'number' }],
      ['acquired_date', 'Date acquired', ['acquired'], { type: 'date' }],
      ['lease_start_date', 'Lease start with landlord', ['lease start'], { type: 'date' }],
      ['handed_back_date', 'Date handed back', ['handed back'], { type: 'date' }],
      ['notes', 'Notes', ['note', 'comments'], T(2000)],
    ],
  },
  tenants: {
    table: 'tenants', label: 'tenants', file: 'tenants.csv', key: 'name', keyHelp: 'Name', order: 'name COLLATE NOCASE',
    columns: [
      ['name', 'Name', ['tenant', 'tenant name', 'full name'], T(200)],
      ['email', 'Email', ['e-mail', 'email address'], T(254)],
      ['phone', 'Phone', ['telephone', 'tel', 'mobile', 'phone number'], T(50)],
      ['council_ref', 'Council reference number', ['council reference', 'council ref', 'reference'], T(100)],
      ['notes', 'Notes', ['note', 'comments'], T(2000)],
    ],
  },
};

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

// Undo the apostrophe the export puts in front of anything a spreadsheet would read as a formula.
const clean = (v, max) => String(v || '').replace(/^'(?=[=+\-@])/, '').trim().slice(0, max);

// A cell from a file into what's saved: { value } or { skip: true } when it can't be read.
function readCell(raw, kind) {
  const t = clean(raw, kind.max || 2000);
  if (!t) return { value: null };
  switch (kind.type) {
    case 'select': { const hit = kind.options.find((o) => o.toLowerCase() === t.toLowerCase()); return { value: hit || null }; }
    case 'int': { const n = Number(t.replace(/,/g, '')); return { value: Number.isInteger(n) ? n : null }; }
    case 'number': { const n = Number(t.replace(/[%,\s]/g, '')); return { value: Number.isFinite(n) ? n : null }; }
    case 'money': { const p = fmt.parseMoney(t.replace(/[£,\s]/g, '')); return { value: Number.isNaN(p) ? null : p }; }
    case 'date': {
      if (fmt.isIsoDate(t)) return { value: t };
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
      if (!m) return { value: null };
      const iso = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return { value: fmt.isIsoDate(iso) ? iso : null };
    }
    default: return { value: t };
  }
}

// A saved value for the export file. A property's landlord is written by name, which matches in another agency (codes differ).
function writeCell(row, field, kind, db, a) {
  const v = row[field];
  if (v === null || v === undefined || v === '') return '';
  if (kind.type === 'money') return (Number(v) / 100).toFixed(2);
  if (kind.type === 'landlord') { const l = db.prepare('SELECT code, name FROM landlords WHERE id = ? AND account_id = ?').get(v, a); return l ? l.name : ''; }
  if (kind.type === 'council') { const c = db.prepare('SELECT name FROM councils WHERE id = ? AND account_id = ?').get(v, a); return c ? c.name : ''; }
  return v;
}

// kindName: contractors, landlords, properties or tenants.
module.exports = function transferRoutes(db, kindName = 'contractors') {
  const K = KINDS[kindName];
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file');
  const cols = K.columns.map(([field]) => field);

  router.get('/export.csv', (req, res) => {
    const a = req.user.id;
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${K.table} WHERE account_id = ? ORDER BY ${K.order}`).all(a);
    const lines = [K.columns.map(([, h]) => csvCell(h)).join(','), ...rows.map((r) => K.columns.map(([f, , , kind]) => csvCell(writeCell(r, f, kind, db, a))).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${K.file}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(`\ufeff${lines.join('\r\n')}\r\n`);
  });

  function nextCode(a) {
    let best = null;
    for (const { code } of db.prepare(`SELECT code FROM ${K.table} WHERE account_id = ? AND code IS NOT NULL AND code != ''`).all(a)) {
      const m = /^(.*?)(\d+)$/.exec(String(code).trim());
      if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1], n: Number(m[2]), width: m[2].length };
    }
    if (!best) best = { prefix: K.codePrefix, n: 0, width: 4 };
    let code;
    do { best.n += 1; code = `${best.prefix}${String(best.n).padStart(best.width, '0')}`; } while (db.prepare(`SELECT 1 FROM ${K.table} WHERE account_id = ? AND code = ?`).get(a, code));
    return code;
  }

  // A landlord by code or name, a council by name (added if it isn't there yet).
  const landlordFor = (a, t) => (t ? (db.prepare('SELECT id FROM landlords WHERE account_id = ? AND code = ? COLLATE NOCASE').get(a, t)
    || db.prepare('SELECT id FROM landlords WHERE account_id = ? AND name = ? COLLATE NOCASE').get(a, t) || {}).id || null : null);
  const councilFor = (a, t) => {
    if (!t) return null;
    const c = db.prepare('SELECT id FROM councils WHERE account_id = ? AND name = ? COLLATE NOCASE').get(a, t);
    return c ? c.id : Number(db.prepare('INSERT INTO councils (account_id, name) VALUES (?, ?)').run(a, t).lastInsertRowid);
  };

  router.post('/import', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : 'The upload failed. Please try again.';
      req.body = req.body || {};
      auth.checkCsrfAfterUpload(req, res, next);
    });
  }, async (req, res, next) => {
    const a = req.user.id;
    const back = (key, msg) => res.redirect(`/app/${kindName}?${key}=${encodeURIComponent(msg)}`);
    if (req.uploadError) return back('error', req.uploadError);
    if (!req.file || !req.file.size) return back('error', `Choose the ${K.label} file (.csv, .docx or .xlsx) to import.`);
    let read;
    try { read = await fileRows(req.file.buffer); } catch (err) { return next(err); }
    if (read.error) return back('error', read.error);
    const rows = read.rows;
    // Each column's headings: its own, the field name, and other usual names for it.
    const norm = (h) => String(h || '').trim().toLowerCase().replace(/[:*]+$/, '').trim();
    const names = Object.fromEntries(K.columns.map(([f, h, more]) => [f, [h.toLowerCase(), f.replace(/_id$|_pence$/, '').replace(/_/g, ' '), f, ...more]]));
    // The heading row: the first (of the first 15) with the main column, so a title above the table is fine.
    const headAt = rows.slice(0, 15).findIndex((r) => r.some((h) => names[K.key].includes(norm(h))));
    if (headAt < 0) return back('error', `That file has no ${K.keyHelp} column. Use a file exported from ${K.label[0].toUpperCase()}${K.label.slice(1)}, or a table with a ${K.keyHelp} heading.`);
    const head = rows[headAt].map(norm);
    rows.splice(0, headAt + 1);
    const at = Object.fromEntries(cols.map((f) => [f, names[f].reduce((found, h) => (found >= 0 ? found : head.indexOf(h)), -1)]));
    if (rows.length > MAX_ROWS) return back('error', `That file has more than ${MAX_ROWS} ${K.label}.`);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const v = {};
        for (const [f, , , kind] of K.columns) {
          if (at[f] < 0) { v[f] = null; continue; }
          if (kind.type === 'landlord') v[f] = landlordFor(a, clean(r[at[f]], 200));
          else if (kind.type === 'council') v[f] = null; // looked up below, only when needed
          else v[f] = readCell(r[at[f]], kind).value;
        }
        const councilName = at.council_id >= 0 ? clean(r[at.council_id], 200) : '';
        if (!v[K.key]) { skipped += 1; continue; }
        const have = db.prepare(`SELECT * FROM ${K.table} WHERE account_id = ? AND lower(${K.key}) = lower(?)`).get(a, v[K.key]);
        if (have) {
          // Only fill in what's blank here.
          if (councilName && !have.council_id) v.council_id = councilFor(a, councilName);
          const fill = cols.filter((c) => c !== K.key && c !== 'code' && v[c] !== null && v[c] !== '' && (have[c] === null || have[c] === undefined || String(have[c]).trim() === ''));
          if (fill.length) {
            db.prepare(`UPDATE ${K.table} SET ${fill.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND account_id = ?`).run(...fill.map((c) => v[c]), have.id, a);
            updated += 1;
          } else skipped += 1;
          continue;
        }
        if (councilName) v.council_id = councilFor(a, councilName);
        for (const [f, , , kind] of K.columns) if ((v[f] === null || v[f] === undefined) && kind.default) v[f] = kind.default;
        if (kindName === 'properties' && !v.acquired_date) v.acquired_date = fmt.today();
        if (cols.includes('code')) v.code = v.code && !db.prepare(`SELECT 1 FROM ${K.table} WHERE account_id = ? AND code = ?`).get(a, v.code) ? v.code : nextCode(a);
        const use = cols.filter((c) => v[c] !== null && v[c] !== undefined);
        db.prepare(`INSERT INTO ${K.table} (account_id, ${use.join(', ')}) VALUES (?, ${use.map(() => '?').join(', ')})`).run(a, ...use.map((c) => v[c]));
        added += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`Import of ${K.label} failed:`, err.message);
      return back('error', 'The import failed, so nothing was changed. Check the file and try again.');
    }
    back('flash', `Imported ${K.label}: ${added} new, ${updated} updated with missing details, ${skipped} already here.`);
  });

  return router;
};

module.exports.KINDS = KINDS;
module.exports.parseCsv = parseCsv;
module.exports.docxRows = docxRows;
