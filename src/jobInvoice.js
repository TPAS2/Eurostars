'use strict';

// The landlord's maintenance invoice for a finished job, laid out like the agency's own Word
// invoice ("ATLANTIC LODGE HOUSING 2 (Maintenance Invoice)"): the company heading, Date, Client
// and Property Address boxes, the INVOICE box listing the work, the deduction note and the TOTAL.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-09-10" → { day: '10', suffix: 'th', rest: 'September 2026' }
function longDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  return { day: String(d), suffix, rest: `${MONTHS[m - 1]} ${y}` };
}

const money = (pence) => `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The standard PDF fonts only cover Western European characters.
const safe = (s) => String(s ?? '').replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E£·éèêëàâäôöûüçïîÉÈ]/g, '?');

// Splits text into lines that fit the width.
function wrap(font, size, text, width) {
  const lines = [];
  for (const para of safe(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// data: { company: { name, address, phone, email }, date (YYYY-MM-DD), client, property: [lines],
//         items: [text], totalPence, note }
async function buildJobInvoice(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter, as the Word original
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const timesB = await doc.embedFont(StandardFonts.TimesRomanBold);
  const black = rgb(0, 0, 0);
  const H = 792;
  // Positions are measured from the top of the page, as in the Word layout.
  const text = (s, x, top, size, font, color = black) => page.drawText(safe(s), { x, y: H - top, size, font, color });
  const box = (top, bottom, left = 90, right = 522) => page.drawRectangle({
    x: left, y: H - bottom, width: right - left, height: bottom - top, borderColor: black, borderWidth: 0.75,
  });

  // Heading: company name (blue), "(Maintenance Invoice)" (grey), address and contact lines.
  const c = data.company;
  text(String(c.name || '').toUpperCase(), 90, 57, 22, helv, rgb(0, 0, 1));
  text('(Maintenance Invoice)', 99, 74, 14, helvB, rgb(0.6, 0.6, 0.6));
  const address = String(c.address || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(', ');
  if (address) text(address, 90, 87, 10, helv, rgb(0.5, 0.5, 0.5));
  const contact = [c.phone ? `Tel: ${c.phone}` : '', c.email ? 'Email: ' : ''].filter(Boolean).join(' ');
  if (contact) {
    text(contact, 90, 99, 10, helv, rgb(0.6, 0.6, 0.6));
    if (c.email) {
      const x = 90 + helv.widthOfTextAtSize(safe(contact), 10) + helv.widthOfTextAtSize(' ', 10);
      text(c.email, x, 99, 10, helv, rgb(0.02, 0.39, 0.76));
      page.drawLine({ start: { x, y: H - 100.5 }, end: { x: x + helv.widthOfTextAtSize(safe(c.email), 10), y: H - 100.5 }, thickness: 0.6, color: rgb(0.02, 0.39, 0.76) });
    }
  }

  // Date box.
  box(121, 148);
  text('Date:', 126, 135.5, 12, helvB);
  if (data.date) {
    const d = longDate(data.date);
    let x = 270;
    text(d.day, x, 135.5, 11, helv); x += helv.widthOfTextAtSize(d.day, 11);
    text(d.suffix, x, 131, 7, helv); x += helv.widthOfTextAtSize(d.suffix, 7);
    text(` ${d.rest}`, x, 135.5, 11, helv);
  }

  // Client box.
  box(161, 188);
  text('Client', 126, 175.5, 12, helvB);
  text(':', 126 + helvB.widthOfTextAtSize('Client', 12), 175.5, 12, helv);
  text(data.client || '', 270, 175.5, 11, helv);

  // Property address box.
  box(200, 256);
  text('Property Address:', 126, 214, 11, helvB);
  (data.property || []).slice(0, 3).forEach((line, i) => text(line, 277, 214 + i * 13, 11, helvB));

  // The INVOICE box: heading, the work done as bullets, and the deduction note at the foot.
  box(267, 641, 89, 521);
  const heading = 'INVOICE';
  const hw = helvB.widthOfTextAtSize(heading, 12);
  text(heading, 305 - hw / 2, 303, 12, helvB);
  page.drawLine({ start: { x: 305 - hw / 2, y: H - 305 }, end: { x: 305 + hw / 2, y: H - 305 }, thickness: 0.9, color: black });
  let top = 345;
  const lastLine = 610;
  for (const item of data.items || []) {
    const lines = wrap(times, 12, item, 385);
    if (!lines.length || top > lastLine) continue;
    page.drawCircle({ x: 112, y: H - top + 3.8, size: 2.3, color: black });
    for (const l of lines) {
      if (top > lastLine) break;
      text(l, 126, top, 12, times);
      top += 14.5;
    }
    top += 4;
  }
  if (data.note) text(data.note, 126, 631, 12, timesB, rgb(1, 0, 0));

  // TOTAL box.
  box(641, 683);
  text('TOTAL', 97, 659, 12, helvB);
  const total = money(data.totalPence || 0);
  text(total, 500 - helvB.widthOfTextAtSize(total, 12), 659, 12, helvB);

  doc.setTitle(`${c.name || ''} (Maintenance Invoice)`);
  return doc.save();
}

// Everything the invoice needs for one job, or null if the job isn't this company's.
function jobInvoiceData(db, accountId, jobId) {
  const job = db.prepare(
    `SELECT j.*, p.address_line1, p.town, p.postcode, l.id AS landlord_id, l.name AS landlord_name, l.email AS landlord_email
       FROM maintenance_jobs j JOIN properties p ON p.id = j.property_id
       LEFT JOIN landlords l ON l.id = p.landlord_id AND l.account_id = j.account_id
      WHERE j.id = ? AND j.account_id = ?`
  ).get(jobId, accountId);
  if (!job) return null;
  const co = db.prepare('SELECT agency_name, address, phone, email FROM users WHERE id = ?').get(accountId);
  const date = job.invoice_date || null;
  const property = [job.address_line1, job.town, job.postcode].map((s) => String(s || '').trim()).filter(Boolean);
  const items = [job.title, ...String(job.description || '').split(/\r?\n/)].map((s) => s.trim()).filter(Boolean);
  const [y, m] = String(date || '').split('-').map(Number);
  const when = date ? ` - ${MONTHS[m - 1]} ${y}` : '';
  const filename = `${[job.address_line1, job.postcode].filter(Boolean).join(' ')}${when}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || `maintenance-invoice-${job.id}`;
  return {
    job,
    pdf: {
      company: { name: co.agency_name, address: co.address, phone: co.phone, email: co.email },
      date, client: job.landlord_name || '', property, items, totalPence: job.cost_pence || 0,
      note: 'Payment will be deducted from the rent payment',
    },
    filename: `${filename}.pdf`,
  };
}

module.exports = { buildJobInvoice, jobInvoiceData, longDate };
