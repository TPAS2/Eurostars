'use strict';

// Rent run step 5: Metro Bank's bulk payment file, made from the Rift report. Every landlord on
// the Rift report who's paid by bank, with their bank details from the landlord's page. Like
// Metro's own file, there's a row per property (the reference is the address) when the
// landlord's money splits exactly by property; otherwise one row for the landlord. The rows
// always add up to the Rift report.
//
// The file is Metro's own macro-enabled template (assets/, with its data and personal details
// taken out), so it looks and works exactly like theirs: its button still makes the .txt upload file.

const fs = require('node:fs');
const path = require('node:path');
const { monthLabel } = require('./statements');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'metro-bulk-payment-template.xlsm.tpl');
const HEADINGS = ['SORT CODE', 'BENEFICIARY NAME', 'BENEFICIARY ACCOUNT', 'REFERENCE', 'AMOUNT'];
// Metro only reads the first 18 characters of a name or reference.
const MAX_TEXT = 18;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

const digits = (v) => String(v || '').replace(/\D/g, '');

// A landlord's money for the month split by property, when it adds up exactly.
function byProperty(detailJson, closing) {
  let props = [];
  try { props = JSON.parse(detailJson || '{}').properties || []; } catch { props = []; }
  const parts = props.filter((p) => p.id).map((p) => ({ address: p.address_line1, pence: (p.rent || 0) - (p.fees || 0) - (p.expenses || 0) }))
    .filter((p) => p.pence > 0);
  const let_ = props.filter((p) => p.id && (p.rent || 0) > 0);
  const owned = props.filter((p) => p.id);
  // Their one property (the one let this month, or the only one they have).
  const single = let_.length === 1 ? let_[0].address_line1 : owned.length === 1 ? owned[0].address_line1 : '';
  return { parts, single, exact: parts.length > 1 && parts.reduce((t, p) => t + p.pence, 0) === closing };
}

// Every landlord paid by bank who has a statement for the month, a row per property where their
// money splits exactly by property (else one row). Unpaid ones (nothing held) get pence: null.
function paymentRows(db, accountId, month) {
  const [y, m] = month.split('-').map(Number);
  const all = db.prepare(
    `SELECT l.id AS landlord_id, l.name, l.code, l.statement_type, l.bank_account_name, l.bank_sort_code, l.bank_account_number,
            l.bank_name, l.payment_note, s.closing_pence, s.detail_json
       FROM monthly_statements s JOIN landlords l ON l.id = s.landlord_id AND l.account_id = s.account_id
      WHERE s.account_id = ? AND s.month = ?
      ORDER BY l.code IS NULL OR l.code = '', l.code COLLATE NOCASE, l.name COLLATE NOCASE`
  ).all(accountId, month);
  const rows = [];
  const cheques = [];
  const problems = [];
  for (const l of all) {
    if (l.statement_type === 'Cheque') { if (l.closing_pence > 0) cheques.push({ name: l.name, pence: l.closing_pence }); continue; }
    const paid = l.closing_pence > 0;
    const sort = digits(l.bank_sort_code);
    const account = digits(l.bank_account_number);
    const issues = [];
    if (sort.length !== 6) issues.push(sort ? 'sort code isn’t 6 digits' : 'no sort code');
    if (account.length !== 8) issues.push(account ? 'account number isn’t 8 digits' : 'no account number');
    if (paid && issues.length) problems.push({ landlord_id: l.landlord_id, name: l.name, issues });
    const base = {
      landlord_id: l.landlord_id, landlordName: l.name, code: l.code || '', name: l.bank_account_name || l.name, account,
      sortCode: sort.length === 6 ? `${sort.slice(0, 2)}-${sort.slice(2, 4)}-${sort.slice(4)}` : sort, sortDigits: sort,
      bankName: l.bank_name || '', note: l.payment_note || '',
    };
    const split = byProperty(l.detail_json, l.closing_pence);
    if (paid && split.exact) {
      for (const p of split.parts) rows.push({ ...base, reference: p.address, pence: p.pence });
    } else {
      const reference = split.single || `${l.code ? `${l.code} ` : ''}Rent ${SHORT_MONTHS[m - 1]} ${String(y).slice(2)}`;
      rows.push({ ...base, reference, pence: paid ? l.closing_pence : null });
    }
  }
  return { month, monthLabel: monthLabel(month), rows, cheques, problems };
}

// Step 5 (Metro's bulk file): the payments only, adding up to the Rift report (less cheques).
function bulkRows(db, accountId, month) {
  const all = paymentRows(db, accountId, month);
  const rows = all.rows.filter((r) => r.pence);
  return { ...all, rows, total: rows.reduce((t, r) => t + r.pence, 0) };
}

// Step 4 (the Bank Transfer sheet): everyone paid by bank, with "No payment" where nothing's due.
function transferRows(db, accountId, month) {
  const all = paymentRows(db, accountId, month);
  return { ...all, total: all.rows.reduce((t, r) => t + (r.pence || 0), 0) };
}

const xml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // Characters XML can't hold at all.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const str = (ref, style, v) => (v === '' || v == null ? `<c r="${ref}" s="${style}"/>` : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
const num = (ref, style, v) => `<c r="${ref}" s="${style}"><v>${v}</v></c>`;

// Metro's template with the rows written in (the cell styles are the template's own).
async function bulkWorkbook(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheet = await zip.file(sheetPath).async('string');
  const out = [];
  const row = (r, cells) => out.push(`<row r="${r}" spans="1:6" x14ac:dyDescent="0.35">${cells}</row>`);
  file.rows.forEach((p, i) => {
    const r = i + 2;
    // An account number starting with 0 stays as text so the 0 isn't lost.
    const acc = !p.account ? `<c r="C${r}" s="9"/>` : /^0/.test(p.account) ? str(`C${r}`, 9, p.account) : num(`C${r}`, 9, Number(p.account));
    row(r, str(`A${r}`, 8, p.sortCode) + str(`B${r}`, 10, p.name) + acc + str(`D${r}`, 10, p.reference)
      + num(`E${r}`, 7, (p.pence / 100).toFixed(2)) + `<c r="F${r}" s="5"/>`);
  });
  const totalRow = file.rows.length + 2;
  const sum = file.rows.length ? `<f>SUM(E2:E${totalRow - 1})</f>` : '';
  row(totalRow, `<c r="A${totalRow}" s="8"/><c r="B${totalRow}" s="10"/><c r="C${totalRow}" s="9"/><c r="D${totalRow}" s="10"/>`
    + `<c r="E${totalRow}" s="19">${sum}<v>${(file.total / 100).toFixed(2)}</v></c><c r="F${totalRow}" s="5"/>`);
  // The empty lines below, as in Metro's file (rows not listed are hidden).
  const styledTo = Math.max(1033, totalRow + 20);
  for (let r = totalRow + 1; r <= styledTo; r++) row(r, `<c r="A${r}" s="2"/><c r="B${r}" s="1"/><c r="C${r}" s="3"/><c r="D${r}" s="1"/><c r="E${r}" s="1"/><c r="F${r}" s="5"/>`);
  for (let r = styledTo + 1; r <= styledTo + 40; r++) row(r, `<c r="F${r}" s="5"/>`);
  sheet = sheet.replace('{{ROWS}}', out.join('')).replace('{{DIM}}', `A1:F${styledTo + 40}`);
  zip.file(sheetPath, sheet);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const TRANSFER_TEMPLATE = path.join(__dirname, '..', 'assets', 'online-payments-template.xlsx.tpl');
const LONG_MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const UPPER_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC'];
const transferTitle = (agencyName, month) => { const [y, m] = month.split('-').map(Number); return `${agencyName} ${LONG_MONTHS[m - 1]} ${y} Bank Transfer`; };
const transferFileName = (agencyName, month) => {
  const [y, m] = month.split('-').map(Number);
  return `${`${agencyName} ${UPPER_SHORT[m - 1]} ${y} Online payments`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_')}.xlsx`;
};

// Step 4: the agency's own "Bank Transfer" sheet (assets/, with its data taken out), written in.
async function transferWorkbook(file, agencyName) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(TRANSFER_TEMPLATE));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheet = await zip.file(sheetPath).async('string');
  const out = [];
  const row = (r, cells, extra = '') => out.push(`<row r="${r}" spans="1:8"${extra} x14ac:dyDescent="0.35">${cells}</row>`);
  row(1, str('B1', 71, transferTitle(agencyName, file.month)) + '<c r="C1" s="71"/><c r="D1" s="71"/>');
  row(2, '', ' ht="15" thickBot="1"');
  row(3, str('A3', 5, 'Landlord') + str('B3', 55, 'LCODE') + str('C3', 6, 'Property Address / Reference') + str('D3', 6, 'Sort Code')
    + str('E3', 7, 'Account Number') + str('F3', 8, 'Bank Name') + str('G3', 9, 'Amount') + '<c r="H3" s="1"/>', ' ht="15" thickBot="1"');
  file.rows.forEach((p, i) => {
    const r = i + 4;
    const acc = !p.account ? `<c r="E${r}" s="30"/>` : /^0/.test(p.account) ? str(`E${r}`, 30, p.account) : num(`E${r}`, 30, Number(p.account));
    const amount = p.pence ? num(`G${r}`, 15, (p.pence / 100).toFixed(2)) : str(`G${r}`, 21, 'No payment');
    const note = p.note ? str(`H${r}`, 65, p.note) : `<c r="H${r}" s="1"/>`;
    row(r, str(`A${r}`, 35, p.landlordName) + str(`B${r}`, 35, p.code) + str(`C${r}`, 35, p.reference) + str(`D${r}`, 30, p.sortCode)
      + acc + str(`F${r}`, 30, p.bankName) + amount + note);
  });
  const last = file.rows.length + 3;
  const t = last + 1;
  row(t, str(`F${t}`, 67, 'Total') + `<c r="G${t}" s="68">${file.rows.length ? `<f>SUM(G4:G${last})</f>` : ''}<v>${(file.total / 100).toFixed(2)}</v></c>`, ' ht="15" thickBot="1"');
  sheet = sheet.replace('{{ROWS}}', out.join('')).replace('{{DIM}}', `A1:H${t}`);
  zip.file(sheetPath, sheet);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// e.g. "24th_SEPTEMBER_2026.xlsm", like Metro's file, dated with the payment date (or today).
const ORD = (d) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
function fileName(isoDate, ext) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${ORD(d)}_${LONG_MONTHS[m - 1]}_${y}.${ext}`;
}

module.exports = { bulkRows, bulkWorkbook, fileName, transferRows, transferWorkbook, transferTitle, transferFileName, HEADINGS, MAX_TEXT };
