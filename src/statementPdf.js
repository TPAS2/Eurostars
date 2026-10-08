'use strict';

// The landlord statement as a printed "Statement of account and payment advice": the agency's
// heading in a grey band, the landlord's name and address with the statement details beside
// them, then income and expenditure per property in Net / Vat / Gross columns and the net amount
// due. Positions follow the agency's own statement (A4, measured from the top of the page).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fmt = require('./format');
const { safe, wrap } = require('./jobInvoice');

// Plain amounts, as on the original: 1468.50, -12.00.
const amount = (p) => (Number(p || 0) / 100).toFixed(2);

// Everything printed on a statement. s is a monthly_statements row joined with the landlord.
function statementDoc(db, accountId, s) {
  const detail = JSON.parse(s.detail_json);
  const c = db.prepare('SELECT agency_name, address, phone, email FROM users WHERE id = ?').get(accountId) || {};
  const l = db.prepare('SELECT name, code, address, statement_type FROM landlords WHERE id = ? AND account_id = ?').get(s.landlord_id, accountId) || {};
  const date = fmt.ukDate(String(s.generated_at || fmt.today()).slice(0, 10));
  const period = `${fmt.ukDate(detail.from)} - ${fmt.ukDate(detail.to)}`;
  const contact = [c.phone && `tel: ${c.phone}`, c.email && `email: ${c.email}`].filter(Boolean).join('  ');
  const blocks = detail.properties.filter((p) => p.rent || p.fees || p.expenses).map((p) => ({
    re: p.address_line1,
    income: p.rent ? [{ title: p.address_line1, sub: period, net: p.rent }] : [],
    expenditure: [
      p.fees ? { title: 'Management fee', net: p.fees } : null,
      p.expenses ? { title: 'Repairs & other costs', net: p.expenses } : null,
    ].filter(Boolean),
  }));
  const income = s.rent_pence;
  const spent = s.fees_pence + s.expenses_pence;
  const due = income - spent;
  return {
    company: { name: c.agency_name || '', address: String(c.address || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(', '), contact },
    to: [l.name || s.landlord_name, ...String(l.address || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)],
    details: [['Landlord:', l.code || ''], ['Statement No:', String(s.statement_no || '')], ['Ref/Chq No:', l.statement_type === 'Cheque' ? 'Cheque' : 'Autobank'], ['Date:', date]],
    date, blocks, income, spent, due,
    closing: due <= 0 ? 'Nothing to pay this month.' : l.statement_type === 'Cheque' ? 'Paid by cheque.' : 'Paid direct into your account as agreed.',
    filename: `Statement ${l.code || s.landlord_id} ${s.month}.pdf`,
  };
}

const W = 595.28;
const H = 841.89;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.753, 0.753, 0.753);
const COLS = { net: 365.5, vat: 445, gross: 529 }; // right edges of the money columns
const BOTTOM = 782; // start a new page below this (the page number sits at 793)

async function buildStatementPdf(d) {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Statement of account - ${d.to[0]} - ${d.date}`));
  doc.setAuthor(safe(d.company.name));
  doc.setCreator('Rift');
  doc.setProducer('Rift');
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const pages = [];
  let page;
  const text = (s, x, baseline, size, f = font) => page.drawText(safe(s), { x, y: H - baseline, size, font: f, color: BLACK });
  const right = (s, xRight, baseline, size, f = font) => text(s, xRight - f.widthOfTextAtSize(safe(s), size), baseline, size, f);
  const centre = (s, baseline, size, f = font) => text(s, (36 + 560.5) / 2 - f.widthOfTextAtSize(safe(s), size) / 2, baseline, size, f);
  const line = (x1, x2, top) => page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness: 0.5, color: BLACK });
  const money = (row, baseline, f = font) => {
    right(amount(row.net), COLS.net, baseline, 11.5, f === bold ? font : f);
    right('0.00', COLS.vat, baseline, 11.5);
    right(amount(row.net), COLS.gross, baseline, 11.5, f);
  };

  function newPage() {
    page = doc.addPage([W, H]);
    pages.push(page);
    // Frame and heading band.
    page.drawRectangle({ x: 36, y: H - 93.75, width: 524.5, height: 57.75, color: GREY });
    page.drawRectangle({ x: 36, y: H - 805.9, width: 524.5, height: 769.9, borderColor: BLACK, borderWidth: 0.5 });
    line(36, 560.5, 92.7);
    centre(d.company.name, 53, 20.5, bold);
    if (d.company.address) centre(d.company.address, 72, 10, bold);
    if (d.company.contact) centre(d.company.contact, 85, 10, bold);
  }

  newPage();
  // Landlord's name and address; statement details beside them.
  // (Long lines wrap so they never run into the details on the right.)
  d.to.flatMap((l) => wrap(font, 12, l, 305)).slice(0, 8).forEach((l, i) => text(l, 69.2, 161 + i * 13.7, 12));
  d.details.forEach(([label, value], i) => { text(label, 389, 158.5 + i * 14.1, 10, bold); right(value, 530, 158.5 + i * 14.1, 10); });
  centre('STATEMENT OF ACCOUNT AND PAYMENT ADVICE', 267, 14.5, bold);
  centre(`AS AT ${d.date}`, 284.5, 14.5, bold);
  centre('For Account: Default Client Cash Account', 302, 14.5, bold);
  const heads = () => {
    right('Net', COLS.net, y + 15.5, 10, bold); right('Vat', COLS.vat, y + 15.5, 10, bold); right('Gross', COLS.gross, y + 15.5, 10, bold);
    for (const x of Object.values(COLS)) right('£', x, y + 29, 10, bold);
    y += 29;
  };
  let y = 302;
  heads();
  const room = (needed) => { if (y + needed > BOTTOM) { newPage(); y = 110; heads(); } };

  // Each property: Re: line, then its income and expenditure. The amounts sit on the row's last line
  // (the period, or the title when there's no period), and long names wrap before the money columns.
  for (const b of d.blocks) {
    const re = wrap(bold, 12, `Re: ${b.re}`, 470);
    room(45 + re.length * 14);
    re.forEach((l, i) => { y += i ? 14 : 16; text(l, 57.8, y, 12, bold); });
    for (const [heading, rows] of [['INCOME', b.income], ['EXPENDITURE', b.expenditure]]) {
      if (!rows.length) continue;
      room(40);
      y += 17; text(heading, 66.3, y, 14.5, bold);
      for (const r of rows) {
        const title = wrap(bold, 12, r.title, 220);
        room(16 + title.length * 14 + (r.sub ? 14 : 0));
        title.forEach((l, i) => { y += i ? 14 : 16; text(l, 74.8, y, 12, bold); });
        if (r.sub) { y += 14; text(r.sub, 77.7, y, 11.5); }
        money(r, y);
      }
    }
  }
  // Totals.
  room(d.spent ? 84 : 68);
  y += 5.8; line(287.5, 535, y);
  y += 13.7; text('TOTAL INCOME', 66.3, y, 12, bold); money({ net: d.income }, y, bold);
  if (d.spent) { y += 16; text('TOTAL EXPENDITURE', 66.3, y, 12, bold); money({ net: d.spent }, y, bold); }
  y += 14; line(451, 538, y);
  y += 10.7; text('NET AMOUNT DUE', 66.3, y, 12, bold); right(amount(d.due), COLS.gross, y, 12, bold);
  y += 6.3; line(451, 538, y); line(451, 538, y + 2.8);
  y += 18.9; text(d.closing, 66.3, y, 12, bold);

  pages.forEach((p, i) => {
    page = p;
    right(`Page  ${i + 1}  of  ${pages.length}`, 537, 793, 8.5);
  });
  return doc.save();
}

module.exports = { statementDoc, buildStatementPdf, amount };
