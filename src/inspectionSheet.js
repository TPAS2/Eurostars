'use strict';

// The property safety inspection sheet, laid out like the agency's own tablet sheet: property
// address, date and who inspected; the safety requirements, each answered Yes, No or N/A; notes;
// and the tenant's signature. Positions match the original
// sheet (A4, measured from the top of the page). Given no inspection, it is the blank template.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { safe, wrap } = require('./jobInvoice');

const SAFETY_ITEMS = [
  { key: 'window_restrictor', label: 'Window Restrictor (All rooms above ground level)' },
  { key: 'smoke_alarms', label: 'Mains Operated Smoke Alarms (All levels)' },
  { key: 'heat_sensor', label: 'Heat Sensor' },
  { key: 'stair_rail', label: 'Stair Hand Rail' },
  { key: 'light_kitchen', label: 'Enclosed Light Fitting (Kitchen)' },
  { key: 'fire_blanket', label: 'Fire Blanket' },
  { key: 'privacy_lock', label: 'Privacy Lock (To Bathroom)' },
  { key: 'fire_door', label: 'Fire Check Door' },
  { key: 'fire_strips', label: 'Fire Strips to Fire Check Door' },
  { key: 'door_closure', label: 'Door Closure to Fire Check Door' },
  { key: 'cooker_chain', label: 'Cooker Chain' },
  { key: 'light_bathroom', label: 'Enclosed Light Fitting (Bathroom)' },
  { key: 'co_alarm', label: 'Co2 Alarm' },
  { key: 'thumb_main', label: 'Thumb Turn Lock (To main door)' },
  { key: 'thumb_back', label: 'Thumb Turn Lock (To back door)' },
];
const ANSWERS = ['Yes', 'No', 'N/A'];

// The answers from a submitted form (fields named checklist__<key>); anything missing is N/A.
function parseChecklist(body) {
  const out = {};
  for (const { key } of SAFETY_ITEMS) {
    const v = String(body[`checklist__${key}`] || '');
    out[key] = ANSWERS.includes(v) ? v : 'N/A';
  }
  return out;
}

function readChecklist(json) {
  let v = {};
  try { v = JSON.parse(json || '{}') || {}; } catch { v = {}; }
  return parseChecklist(Object.fromEntries(Object.entries(v).map(([k, x]) => [`checklist__${k}`, x])));
}

// "12 Yes · 1 No · 2 N/A"
function summary(json) {
  const c = readChecklist(json);
  const n = (a) => SAFETY_ITEMS.filter(({ key }) => c[key] === a).length;
  return ANSWERS.map((a) => `${n(a)} ${a}`).join(' · ');
}

const W = 595.2;
const H = 841.68;
const BLUE = rgb(0.557, 0.663, 0.859);
const BLACK = rgb(0, 0, 0);
const PEN = rgb(0.05, 0.16, 0.55);
// Row lines of the table (tops), from the original sheet.
const ROW_LINES = [222.1, 245.8, 269.6, 294.0, 317.7, 341.5, 365.3, 389.0, 413.4, 437.2, 460.9, 484.7, 508.5, 532.2, 556.6, 579.9];

// data: { company: { name }, inspection: null for the blank template, else { address, date, inspectedBy,
//         checklist (JSON), notes }, signature: { png, name, date } (optional) }
async function buildInspectionSheet(data) {
  const doc = await PDFDocument.create();
  const ins = data.inspection || null;
  doc.setTitle(ins ? `Property safety inspection - ${safe(ins.address)}` : 'Property safety inspection sheet');
  doc.setAuthor(safe(data.company.name));
  doc.setCreator('Rift');
  doc.setProducer('Rift');
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s, x, baseline, size, f = font, color = BLACK) => page.drawText(safe(s), { x, y: H - baseline, size, font: f, color });
  const rect = (x1, top, x2, bottom, color) => page.drawRectangle({ x: x1, y: H - bottom, width: x2 - x1, height: bottom - top, color });

  // Heading: the agency's name where the original has its logos.
  text(data.company.name, 52.5, 95, 22, bold, rgb(0.25, 0.32, 0.45));
  text('Property Safety Inspection', 52.5, 112, 10, font, rgb(0.4, 0.45, 0.55));

  // Property, date, inspector.
  text('Property Address:', 52.7, 147, 8.2, bold);
  text('Date of Inspection:', 52.7, 171, 8.2, bold);
  text('Inspected By:', 52.7, 195, 8.2, bold);
  if (ins) {
    text(ins.address, 134, 147, 10);
    text(ins.date, 134, 171, 10);
    text(ins.inspectedBy, 134, 195, 10);
  }

  // The table: header band, outer lines and a line under every row.
  rect(51.0, 209.6, 265.9, 222.2, BLUE);
  text('Safety Requirement', 121.6, 219, 8.2, bold);
  rect(50.3, 208.9, 51.8, 580.7, BLACK);
  rect(265.0, 208.9, 266.6, 580.7, BLACK);
  rect(51.8, 208.8, 266.6, 210.4, BLACK);
  for (const top of ROW_LINES) rect(51.8, top - 0.6, 265.8, top + 0.6, BLACK);
  const checklist = ins ? readChecklist(ins.checklist) : null;
  SAFETY_ITEMS.forEach(({ key, label }, i) => {
    const bottom = ROW_LINES[i + 1];
    text(label, 52.7, bottom - 2.6, 8.2);
    if (checklist) {
      const answer = checklist[key];
      const colour = answer === 'No' ? rgb(0.7, 0.1, 0.06) : answer === 'Yes' ? rgb(0.03, 0.4, 0.2) : BLACK;
      text(answer, 297.2, bottom - 3.5, 12, answer === 'N/A' ? font : bold, colour);
    }
  });

  // Notes.
  text('Notes', 52.7, 601.5, 8.2, bold);
  rect(50.6, 603.2, 51.5, 722.9, BLACK);
  rect(455.1, 603.2, 456.0, 722.9, BLACK);
  rect(51.5, 603.2, 456.0, 604.1, BLACK);
  rect(51.5, 722.0, 456.0, 722.9, BLACK);
  if (ins && ins.notes) {
    let top = 616;
    for (const line of wrap(font, 9.5, ins.notes, 395).slice(0, 9)) { text(line, 56, top, 9.5); top += 11.8; }
  }

  // Tenant's signature.
  text('Signed by Tenant', 52.7, 744, 8.2, bold);
  const sig = data.signature;
  if (sig && sig.png) {
    try {
      const img = await doc.embedPng(sig.png);
      const scale = Math.min(200 / img.width, 34 / img.height);
      page.drawImage(img, { x: 54, y: H - 786, width: img.width * scale, height: img.height * scale });
    } catch { /* an unreadable signature is left off */ }
    text([sig.name, sig.date].filter(Boolean).join('   '), 270, 776, 9, font, PEN);
  }
  page.drawLine({ start: { x: 52.4, y: H - 788 }, end: { x: 260, y: H - 788 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });

  return doc.save();
}

module.exports = { SAFETY_ITEMS, ANSWERS, parseChecklist, readChecklist, summary, buildInspectionSheet };
