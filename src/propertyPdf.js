'use strict';

// A one-page PDF overview of a property, like a listing brochure: the agency heading, the
// main photo and a row of smaller ones, the price, the address and the key facts. Only what
// the listing shows: never the landlord, tenants, certificates or notes.

const {
  PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
} = require('pdf-lib');
const { safe, wrap } = require('./jobInvoice');

const W = 595.28; // A4
const H = 841.89;
const M = 40; // margin
const NAVY = rgb(0.043, 0.071, 0.125);
const INK = rgb(0.067, 0.094, 0.153);
const GREY = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.86, 0.88, 0.91);
const SOFT = rgb(0.953, 0.957, 0.965);
const BLUE = rgb(0.086, 0.275, 0.784);

// data: { agency, address, place, prices: [text], facts: [[label, value]], status, date (dd/mm/yyyy),
//         photos: [{ mime, data }] (JPG or PNG; others are left out) }
async function buildPropertyPdf(data) {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`${data.address} - property overview`));
  doc.setAuthor(safe(data.agency));
  doc.setCreator('Rift');
  doc.setProducer('Rift');
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s, x, top, size, f = font, color = INK) => page.drawText(safe(s), { x, y: H - top, size, font: f, color });
  const rightText = (s, right, top, size, f = font, color = INK) => text(s, right - f.widthOfTextAtSize(safe(s), size), top, size, f, color);

  const images = [];
  for (const p of data.photos || []) {
    try {
      if (p.mime === 'image/jpeg') images.push(await doc.embedJpg(p.data));
      else if (p.mime === 'image/png') images.push(await doc.embedPng(p.data));
    } catch { /* an unreadable photo is left out */ }
    if (images.length >= 4) break;
  }
  // Draws an image filling the box (cropping the overflow), like object-fit: cover.
  const cover = (img, x, top, w, h) => {
    const y = H - top - h;
    const scale = Math.max(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    page.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
    page.drawImage(img, { x: x + (w - iw) / 2, y: y + (h - ih) / 2, width: iw, height: ih });
    page.pushOperators(popGraphicsState());
  };

  // Heading band.
  page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: NAVY });
  text(data.agency, M, 39, 17, bold, rgb(1, 1, 1));
  rightText('PROPERTY OVERVIEW', W - M, 37, 9, bold, rgb(0.72, 0.78, 0.9));

  let top = 88;
  const width = W - 2 * M;
  if (images.length) {
    const mainH = images.length > 1 ? 300 : 360;
    cover(images[0], M, top, width, mainH);
    top += mainH + 6;
    if (images.length > 1) {
      const n = images.length - 1;
      const gap = 6;
      const tw = (width - gap * (n - 1)) / n;
      images.slice(1).forEach((img, i) => cover(img, M + i * (tw + gap), top, tw, 110));
      top += 110 + 6;
    }
  } else {
    page.drawRectangle({ x: M, y: H - top - 160, width, height: 160, color: SOFT });
    const msg = 'No photos yet';
    text(msg, M + (width - font.widthOfTextAtSize(msg, 12)) / 2, top + 84, 12, font, GREY);
    top += 166;
  }

  // Price, address and status.
  top += 34;
  if (data.prices[0]) {
    text(data.prices[0], M, top, 26, bold);
    if (data.status) {
      const label = String(data.status).toUpperCase();
      const lw = bold.widthOfTextAtSize(safe(label), 8) + 16;
      page.drawRectangle({ x: W - M - lw, y: H - top + 1, width: lw, height: 18, color: SOFT, borderColor: LINE, borderWidth: 0.75 });
      text(label, W - M - lw + 8, top - 5, 8, bold, GREY);
    }
    if (data.prices[1]) { top += 22; text(data.prices[1], M, top, 13, bold, GREY); }
    top += 26;
  }
  for (const line of wrap(font, 14, [data.address, data.place].filter(Boolean).join(', '), width)) {
    text(line, M, top, 14);
    top += 19;
  }

  // Key facts in boxes along one row.
  if (data.facts.length) {
    top += 10;
    page.drawLine({ start: { x: M, y: H - top }, end: { x: W - M, y: H - top }, thickness: 0.75, color: LINE });
    top += 16;
    const gap = 10;
    const bw = (width - gap * (data.facts.length - 1)) / data.facts.length;
    data.facts.forEach(([label, value], i) => {
      const x = M + i * (bw + gap);
      page.drawRectangle({ x, y: H - top - 54, width: bw, height: 54, color: SOFT });
      page.drawRectangle({ x, y: H - top - 54, width: 3, height: 54, color: BLUE });
      text(String(label).toUpperCase(), x + 14, top + 20, 7.5, bold, GREY);
      let v = safe(value);
      while (bold.widthOfTextAtSize(v, 15) > bw - 22 && v.length > 1) v = v.slice(0, -1);
      text(v, x + 14, top + 41, 15, bold);
    });
    top += 54;
  }

  // Footer.
  page.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.75, color: LINE });
  page.drawText(safe(data.agency), { x: M, y: 30, size: 9, font: bold, color: GREY });
  const made = safe(`Produced ${data.date}`);
  page.drawText(made, { x: W - M - font.widthOfTextAtSize(made, 9), y: 30, size: 9, font, color: GREY });

  return doc.save();
}

module.exports = { buildPropertyPdf };
