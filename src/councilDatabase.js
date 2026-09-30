'use strict';

// Each council's database workbook, laid out like the agency's own (e.g. "Enfield Database"):
// a "Live" sheet and a "Previous tenant" sheet with the same yellow headings. Empty for now.

const HEADINGS = [
  { key: 'our_ref', label: 'OUR REF', width: 9.1 },
  { key: 'property_address', label: 'PROPERTY ADDRESS', width: 30.9 },
  { key: 'scheme', label: 'SCHEME', width: 10.4 },
  { key: 'property_size', label: 'PROPERTY SIZE', width: 12.7 },
  { key: 'property_reference', label: 'PROPERTY REFERENCE', width: 13.1 },
  { key: 'reservation_date', label: 'DATE OF RESERVATION', width: 15.4, date: true },
  { key: 'booking_date', label: 'DATE OF BOOKING', width: 14.3, date: true },
  { key: 'cancellation_date', label: 'CANCELLATION DATE', width: 23.3, date: true },
  { key: 'price_pence', label: 'PRICE PER NIGHT', width: 14.3, money: true },
  { key: 'client_name', label: "CLIENT'S NAME", width: 30.4 },
  { key: 'contact_number', label: 'CONTACT NUMBER', width: 20.6 },
  { key: 'people', label: 'NO. OF PEOPLE', width: 20 },
  { key: 'email', label: 'EMAIL', width: 41.0 },
];
const SHEETS = ['Live', 'Previous tenant'];
const EMPTY_ROWS = 20;
const MONEY = '_-"£"* #,##0.00_-;\\-"£"* #,##0.00_-;_-"£"* "-"??_-;_-@_-';

// entries: { live: [rows], previous: [rows] } from council_db_entries.
async function councilWorkbook({ councilName, agencyName, entries = { live: [], previous: [] } }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const font = { name: 'Cambria', size: 11 };
  const medium = { style: 'medium' };
  const thin = { style: 'thin' };
  const last = String.fromCharCode(64 + HEADINGS.length); // M
  for (const name of SHEETS) {
    const ws = wb.addWorksheet(name);
    ws.columns = HEADINGS.map((h) => ({ width: h.width }));
    const live = name === 'Live';
    // Title across the top, then the headings over two rows.
    ws.mergeCells(`A1:${last}1`);
    const title = ws.getCell('A1');
    title.value = live ? `${String(councilName).toUpperCase()} - ${String(agencyName).toUpperCase()}` : 'PREVIOUS TENANTS';
    title.font = { ...font, size: 15, bold: true };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = live ? 18.75 : 27;
    const top = live ? 3 : 2;
    HEADINGS.forEach((h, i) => {
      const col = String.fromCharCode(65 + i);
      ws.mergeCells(`${col}${top}:${col}${top + 1}`);
      const c = ws.getCell(`${col}${top}`);
      c.value = h.label;
      c.font = { ...font, bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = { top: medium, left: medium, bottom: medium, right: medium };
    });
    // The entries, then empty rows ready to fill in.
    const rows = live ? entries.live : entries.previous;
    for (let r = top + 2; r < top + 2 + rows.length + EMPTY_ROWS; r++) {
      const e = rows[r - top - 2];
      HEADINGS.forEach((h, i) => {
        const c = ws.getRow(r).getCell(i + 1);
        if (e && e[h.key] != null && e[h.key] !== '') {
          if (h.date) { const [y, m, d] = e[h.key].split('-').map(Number); c.value = new Date(Date.UTC(y, m - 1, d)); }
          else if (h.money) c.value = e[h.key] / 100;
          else c.value = e[h.key];
        }
        c.font = font;
        c.border = { top: thin, left: thin, bottom: thin, right: thin };
        c.alignment = { horizontal: i === 1 || i === 9 || i === 12 ? 'left' : 'center', vertical: 'middle' };
        if (h.date) c.numFmt = 'dd/mm/yyyy';
        if (h.money) c.numFmt = MONEY;
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function databaseFilename(councilName) {
  return `${String(councilName).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Council'}_Database.xlsx`;
}

module.exports = { HEADINGS, SHEETS, councilWorkbook, databaseFilename };
