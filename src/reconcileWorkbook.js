'use strict';

// Council reconciliation as an Excel workbook, laid out like the agency's own
// "PAYMENT RECONCILIATIONS" sheets: title, month, headings, one line per council with the
// outstanding worked out by formula, and totals.

const MONEY = '_-"£"* #,##0.00_-;\\-"£"* #,##0.00_-;_-"£"* "-"??_-;_-@_-';
const WIDTHS = [10.3, 32.5, 16.7, 14.5, 15.3, 20.7, 23.0];

function headings(agencyName) {
  return ['DATE', 'DESCRIPTION', 'LOCAL AUTHORITY INVOICE AMOUNTS', `PAYMENTS TO ${String(agencyName).toUpperCase()} BY LOCAL AUTHORITIES`, 'OUTSTANDING', 'Date Received', 'Email Sent'];
}

async function reconciliationWorkbook({ agencyName, monthLabel, rows }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(monthLabel.slice(0, 31));
  const font = { name: 'Calibri', size: 11 };
  const thin = { style: 'thin' };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  ws.columns = WIDTHS.map((width) => ({ width }));

  ws.getCell('A2').value = `RECONCILIATION  ${String(agencyName).toUpperCase()}`;
  ws.getCell('A2').font = { name: 'Bookman Old Style', size: 14, bold: true, color: { argb: 'FF000000' } };
  ws.getRow(2).height = 17.5;
  ws.getCell('B4').value = monthLabel.toUpperCase();
  ws.getCell('B4').font = { ...font, bold: true };

  headings(agencyName).forEach((h, i) => {
    const c = ws.getRow(5).getCell(i + 1);
    c.value = h;
    c.font = { ...font, bold: true, color: { argb: 'FF000000' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    if (i < 5) c.border = { bottom: thin };
  });
  ws.getRow(5).height = 51;

  const date = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const first = 7;
  rows.forEach((r, i) => {
    const n = first + i;
    const row = ws.getRow(n);
    row.getCell(2).value = r.name;
    if (r.owed) row.getCell(3).value = r.owed / 100;
    if (r.received) row.getCell(4).value = r.received / 100;
    row.getCell(5).value = { formula: `SUM(C${n}-D${n})`, result: (r.owed - r.received) / 100 };
    if (r.receivedDate) row.getCell(6).value = date(r.receivedDate);
    row.getCell(7).value = r.emailSentDate ? date(r.emailSentDate) : (r.owed ? 'Not Sent' : null);
    for (let col = 1; col <= 7; col++) {
      const c = row.getCell(col);
      c.font = font;
      c.border = box;
      if (col >= 3 && col <= 5) c.numFmt = MONEY;
      if (col >= 6) { c.numFmt = 'mm-dd-yy'; c.alignment = { horizontal: 'center' }; }
    }
    // Nothing in yet for money that's owed: highlighted, as on the agency's sheets.
    if (r.owed && !r.received) row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  });

  const last = first + rows.length - 1;
  const t = first + rows.length + 1;
  const totals = rows.reduce((s, r) => ({ owed: s.owed + r.owed, received: s.received + r.received }), { owed: 0, received: 0 });
  [['C', totals.owed], ['D', totals.received], ['E', totals.owed - totals.received]].forEach(([col, v], i) => {
    const c = ws.getCell(`${col}${t}`);
    c.value = { formula: `SUM(${col}${first}:${col}${Math.max(last, first)})`, result: v / 100 };
    c.font = { ...font, bold: true, size: i === 2 ? 14 : 11, color: { argb: 'FF000000' } };
    c.numFmt = '"£"#,##0.00';
    if (i < 2) c.border = { bottom: thin };
  });
  ws.getRow(t).height = 18.5;
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { reconciliationWorkbook, headings };
