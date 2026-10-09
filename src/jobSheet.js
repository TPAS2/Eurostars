'use strict';

// The maintenance job sheet ("WORKSHEET"), laid out like the agency's own paper job sheet: the
// company heading band, the contractor's name and details, the job number, the property, billing
// and job details, contact for access, the description of work, and the signature lines for the
// tenant and the maintenance person or contractor. Given no job, it is the blank template.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { safe, wrap } = require('./jobInvoice');

const W = 595.28; // A4
const H = 841.89;
const L = 90; // left edge of the content
const R = 540; // right edge of the content
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const BAND = rgb(0.86, 0.86, 0.86);
const PEN = rgb(0.05, 0.16, 0.55);

// data: {
//   company: { name, address, phone, email },
//   job: null for the blank template, else { number, date, contractor: { name, address, code, phone, mobile, fax, email },
//     propertyCode, propertyAddress, billingName, dateReported, estimateRequired, ourEstimate,
//     preferredStart, goAhead, rating, access: [lines], work: [lines] },
//   signatures: { tenant: { png, name, satisfied, date }, contractor: { png, name, date } } (optional)
// }
async function buildJobSheet(data) {
  const doc = await PDFDocument.create();
  const job = data.job || null;
  doc.setTitle(job ? `Job sheet ${job.number}` : 'Job sheet');
  doc.setAuthor(safe(data.company.name));
  doc.setCreator('Rift');
  doc.setProducer('Rift');
  const page = doc.addPage([W, H]);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const timesB = await doc.embedFont(StandardFonts.TimesRomanBold);
  const text = (s, x, top, size = 10.5, font = times, color = BLACK) => page.drawText(safe(s), { x, y: H - top, size, font, color });
  const right = (s, top, size = 10.5, font = times) => text(s, R - font.widthOfTextAtSize(safe(s), size), top, size, font);
  const centre = (s, top, size, font) => text(s, (W - font.widthOfTextAtSize(safe(s), size)) / 2, top, size, font);
  const box = (top, bottom, left = L, rightEdge = R) => page.drawRectangle({
    x: left, y: H - bottom, width: rightEdge - left, height: bottom - top, borderColor: BLACK, borderWidth: 0.8,
  });
  const dots = (x1, x2, top) => {
    for (let x = x1; x < x2; x += 3) page.drawCircle({ x, y: H - top, size: 0.45, color: BLACK });
  };
  const v = (s) => (job && s !== null && s !== undefined ? String(s) : '');

  // Frame and heading band with the company's details.
  page.drawRectangle({ x: 55, y: H - 805, width: W - 90, height: 805 - 66, borderColor: BLACK, borderWidth: 0.8 });
  page.drawRectangle({ x: 55, y: H - 118, width: W - 90, height: 52, color: BAND, borderColor: BLACK, borderWidth: 0.8 });
  centre(data.company.name, 89, 18, timesB);
  const co = data.company;
  const addr = String(co.address || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  if (addr) centre(addr, 101, 8, timesB);
  const contact = [co.phone && `Tel: ${co.phone}`, co.email && `Email: ${co.email}`].filter(Boolean).join('   ');
  if (contact) centre(contact, 111, 8, timesB);

  // The contractor: name and address on the left, code and contact details on the right.
  const c = (job && job.contractor) || {};
  let top = 222;
  for (const line of [v(c.name), ...String(v(c.address)).split(/\r?\n/)].map((l) => l.trim()).filter(Boolean).slice(0, 7)) {
    text(line, L, top);
    top += 13;
  }
  [['Contractor Code:', c.code], ['Phone:', c.phone], ['Mobile:', c.mobile], ['Fax:', c.fax], ['E-mail:', c.email], ['Date:', job && job.date]]
    .forEach(([label, value], i) => {
      text(label, 385, 222 + i * 18, 10.5, timesB);
      if (v(value)) right(v(value), 222 + i * 18);
    });

  // WORKSHEET and the job number.
  text('WORKSHEET', L, 372, 22, timesB);
  text('Job Number:', 385, 368, 10.5, timesB);
  box(350, 375, 470, R);
  if (job) text(String(job.number), 470 + (75 - times.widthOfTextAtSize(String(job.number), 13)) / 2, 367, 13);
  page.drawLine({ start: { x: L, y: H - 384 }, end: { x: R, y: H - 384 }, thickness: 0.8, color: BLACK });

  // The property.
  text('Re: Property:', L, 400, 10.5, timesB);
  text(v(job && job.propertyCode), L + 75, 400);
  box(405, 421);
  text(v(job && job.propertyAddress), L + 3, 417, 10);

  // Billing and job details.
  [['Billing Name:', job && job.billingName], ['Date Reported:', job && job.dateReported], ['Estimate Required:', job && job.estimateRequired], ['Our Estimate:', job && job.ourEstimate]]
    .forEach(([label, value], i) => {
      text(label, L, 445 + i * 14, 10.5, timesB);
      text(v(value), 205, 445 + i * 14);
    });
  [['Preferred Start Date:', job && job.preferredStart], ['Go Ahead?', job && job.goAhead], ['Rating:', job && job.rating]]
    .forEach(([label, value], i) => {
      text(label, 385, 462 + i * 16, 10.5, timesB);
      if (v(value)) right(v(value), 462 + i * 16);
    });

  // Contact for access.
  text('Contact for Access:', L, 518, 10.5, timesB);
  box(524, 572);
  // Three lines fit as usual; a fourth if typed, a little closer together.
  const access = ((job && job.access) || []).slice(0, 4);
  access.forEach((line, i) => (access.length > 3 ? text(line, L + 3, 534 + i * 10.5, 9.5) : text(line, L + 3, 536 + i * 12, 10)));

  // Description of work, then the signatures, in one box.
  text('Description of Work:', L, 592, 10.5, timesB);
  box(599, 790);
  top = 614;
  const work = [];
  for (const line of (job && job.work) || []) work.push(...wrap(times, 10.5, line, R - L - 10));
  for (const line of work.slice(0, 6)) { text(line, L + 5, top); top += 13; }
  if (work.length > 6) text('(continued on the job in Rift)', L + 5, top, 9, times, GREY);

  const sig = data.signatures || {};
  const drawSig = async (s, x, baseline, maxW) => {
    if (!s || !s.png) return;
    try {
      const img = await doc.embedPng(s.png);
      const scale = Math.min(maxW / img.width, 30 / img.height);
      page.drawImage(img, { x, y: H - baseline + 1, width: img.width * scale, height: img.height * scale });
    } catch { /* an unreadable signature is left off */ }
  };

  // Tenant: satisfied yes / no (the answer circled), signature and date.
  text('Works Carried out to the Satisfaction of the Tenant/SU:', L + 5, 712, 10);
  text('Yes:', 345, 712, 10);
  text('No:', 380, 712, 10);
  text('(Please circle as appropriate)', 410, 712, 9);
  if (sig.tenant && sig.tenant.satisfied) {
    const yes = sig.tenant.satisfied === 'Yes';
    page.drawEllipse({ x: yes ? 354 : 387, y: H - 709, xScale: yes ? 14 : 12, yScale: 8, borderColor: PEN, borderWidth: 1 });
  }
  text('Signed By Tenant/SU:', L + 5, 746, 10);
  dots(L + 100, 300, 746);
  await drawSig(sig.tenant, L + 102, 744, 105);
  text('Date:', 310, 746, 10);
  if (sig.tenant && sig.tenant.date) text(sig.tenant.date, 340, 745, 10, times, PEN);
  else dots(338, 420, 746);
  if (sig.tenant && sig.tenant.name) text(sig.tenant.name, L + 100, 756, 7.5, times, GREY);

  // Maintenance / contractor: signature and date.
  text('Signed By Maintenance / Contractor:', L + 5, 778, 10);
  dots(L + 160, 400, 778);
  await drawSig(sig.contractor, L + 162, 776, 145);
  text('Date:', 410, 778, 10);
  if (sig.contractor && sig.contractor.date) text(sig.contractor.date, 440, 777, 10, times, PEN);
  else dots(438, 520, 778);
  if (sig.contractor && sig.contractor.name) text(sig.contractor.name, L + 160, 787, 7.5, times, GREY);

  return doc.save();
}

module.exports = { buildJobSheet };
