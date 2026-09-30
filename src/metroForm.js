'use strict';

// Rent run step 5: Metro Bank's own "Bulk Payment Instruction" form (assets/), filled in.
// Page 1 is Metro's form with the details written into its boxes; the pages after it are the
// "attached Bulk Payment file" the form refers to: every payment, with a total.

const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'metro-bulk-payment-instruction.pdf');

// Where each box is on Metro's form (PDF points from the bottom left: x, y of the box's
// bottom edge, and its width), measured from the form itself.
const BOX = {
  store: { x: 82.0, y: 718.3, w: 468.0 },
  accountName: { x: 123.3, y: 666.0, w: 428.4 },
  contactName: { x: 123.7, y: 643.1, w: 428.4 },
  accountNumber: { x: 123.2, y: 619.7, w: 187.7 },
  totalFigures: { x: 144.4, y: 558.9, w: 187.7 },
  valueDate: { x: 377.0, y: 558.9, w: 176.0 },
  totalWords: { x: 145.4, y: 536.1, w: 407.3 },
  count: { x: 162.4, y: 513.7, w: 166.0 },
  signatory1: { x: 62.9, y: 391.2, w: 237.3 },
  signatory2: { x: 315.7, y: 391.8, w: 237.3 },
  // The Date box under each signature.
  signatureDate1: { x: 111.0, y: 370.0, w: 188.3 },
  signatureDate2: { x: 364.0, y: 370.7, w: 188.3 },
};
const BOX_HEIGHT = 18.2;

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; if (n) parts.push('and'); }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  else if (n) parts.push(ONES[n]);
  return parts.join(' ');
}

function wholeNumberWords(n) {
  if (n === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const parts = [];
  for (const [size, name] of scales) {
    if (n >= size) { parts.push(`${under1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n) parts.push((parts.length && n < 100 ? 'and ' : '') + under1000(n));
  return parts.join(' ');
}

// 123456 pence → "One thousand two hundred and thirty-four pounds and fifty-six pence".
function amountInWords(pence) {
  const pounds = Math.floor(pence / 100);
  const p = pence % 100;
  let words = `${wholeNumberWords(pounds)} pound${pounds === 1 ? '' : 's'}`;
  if (p) words += ` and ${wholeNumberWords(p)} ${p === 1 ? 'penny' : 'pence'}`;
  else words += ' only';
  return words.toUpperCase();
}

// Cheque style for the bank form: £5,000-00 (a dash before the pence).
const money = (pence) => `£${Math.floor(pence / 100).toLocaleString('en-GB')}-${String(pence % 100).padStart(2, '0')}`;

// The standard PDF fonts only cover Western European characters.
const safe = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E£·éèêëàâäôöûüçïîÉÈ]/g, '?');

// Shrinks text until it fits the width (down to 6pt), then cuts it.
function fit(font, text, size, width) {
  let t = safe(text);
  let s = size;
  while (s > 6 && font.widthOfTextAtSize(t, s) > width) s -= 0.5;
  while (t && font.widthOfTextAtSize(t, s) > width) t = t.slice(0, -1);
  return { t, s };
}

// data: { store, accountName, contactName, accountNumber, valueDate (dd/mm/yyyy), signatory1, signatory2,
//         payees: [{ name, sort_code, account_number, reference, pence }], monthLabel, agencyName }
async function fillMetroForm(data) {
  const doc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.05, 0.1, 0.35);
  const total = data.payees.reduce((t, p) => t + p.pence, 0);

  const page = doc.getPage(0);
  const put = (key, text, { size = 10.5, f = font } = {}) => {
    if (!text) return;
    const b = BOX[key];
    // Everything on the bank's form is written in capitals.
    const { t, s } = fit(f, String(text).toUpperCase(), size, b.w - 10);
    page.drawText(t, { x: b.x + 5, y: b.y + (BOX_HEIGHT - s * 0.7) / 2, size: s, font: f, color: ink });
  };
  put('store', data.store);
  put('accountName', data.accountName);
  put('contactName', data.contactName);
  put('accountNumber', data.accountNumber);
  // Typed-over figures (from the Rent run's step 5 box) win over the worked-out ones.
  put('totalFigures', data.totalFigures ?? (data.payees.length ? money(total) : ''), { f: bold });
  put('valueDate', data.valueDate);
  // The same date under both signatures.
  put('signatureDate1', data.valueDate);
  put('signatureDate2', data.valueDate);
  put('totalWords', data.totalWords ?? (data.payees.length ? amountInWords(total) : ''), { size: 9.5 });
  put('count', data.count ?? (data.payees.length ? String(data.payees.length) : ''));
  // Printed names under each signature, so the bank can read who signed.
  for (const [key, name] of [['signatory1', data.signatory1], ['signatory2', data.signatory2]]) {
    if (!name) continue;
    const b = BOX[key];
    const { t, s } = fit(font, name, 8, b.w - 10);
    page.drawText(t, { x: b.x + 5, y: b.y + 4, size: s, font, color: rgb(0.3, 0.3, 0.35) });
  }

  // The attached Bulk Payment file: every payment, 32 to a page.
  const PER_PAGE = 32;
  const pages = Math.max(1, Math.ceil(data.payees.length / PER_PAGE));
  const [W, H] = [595.28, 841.89];
  const cols = [
    { label: '#', x: 40, w: 22 }, { label: 'Payee (account name)', x: 62, w: 170 }, { label: 'Sort code', x: 232, w: 64 },
    { label: 'Account number', x: 296, w: 84 }, { label: 'Reference', x: 380, w: 100 }, { label: 'Amount', x: 480, w: 75, right: true },
  ];
  for (let pg = 0; pg < pages; pg++) {
    const p = doc.addPage([W, H]);
    let y = H - 50;
    p.drawText('Bulk Payment File', { x: 40, y, size: 18, font: bold, color: rgb(0.8, 0.07, 0.12) });
    p.drawText(safe(`Attached to the Metro Bank Bulk Payment Instruction · page ${pg + 1} of ${pages}`), { x: 40, y: y - 18, size: 9, font, color: rgb(0.3, 0.3, 0.35) });
    y -= 44;
    const meta = [
      ['Account name', data.accountName], ['Account number', data.accountNumber], ['Value date', data.valueDate],
      ['For', `${data.agencyName ? `${data.agencyName} · ` : ''}rent ${data.monthLabel || ''}`],
    ];
    meta.forEach(([k, v], i) => {
      const x = 40 + (i % 2) * 260;
      const yy = y - Math.floor(i / 2) * 16;
      p.drawText(safe(k), { x, y: yy, size: 9, font, color: rgb(0.3, 0.3, 0.35) });
      p.drawText(fit(bold, v || '', 10, 170).t, { x: x + 80, y: yy, size: 10, font: bold });
    });
    y -= 46;
    p.drawRectangle({ x: 36, y: y - 5, width: W - 72, height: 18, color: rgb(0.0, 0.33, 0.66) });
    for (const c of cols) {
      const tx = c.right ? c.x + c.w - bold.widthOfTextAtSize(c.label, 9) : c.x;
      p.drawText(c.label, { x: tx, y, size: 9, font: bold, color: rgb(1, 1, 1) });
    }
    y -= 22;
    const rows = data.payees.slice(pg * PER_PAGE, (pg + 1) * PER_PAGE);
    rows.forEach((r, i) => {
      if (i % 2) p.drawRectangle({ x: 36, y: y - 6, width: W - 72, height: 19, color: rgb(0.95, 0.96, 0.98) });
      const cells = [String(pg * PER_PAGE + i + 1), r.name, r.sort_code, r.account_number, r.reference, money(r.pence)];
      cols.forEach((c, j) => {
        const { t, s } = fit(font, cells[j], 9.5, c.w - 6);
        const tx = c.right ? c.x + c.w - font.widthOfTextAtSize(t, s) : c.x;
        p.drawText(t, { x: tx, y, size: s, font });
      });
      y -= 19;
    });
    if (!data.payees.length) { p.drawText('No payments ticked.', { x: 62, y, size: 10, font }); y -= 19; }
    if (pg === pages - 1) {
      p.drawLine({ start: { x: 36, y: y + 10 }, end: { x: W - 36, y: y + 10 }, thickness: 1, color: rgb(0.2, 0.2, 0.25) });
      y -= 8;
      p.drawText(`Total: ${data.payees.length} payment${data.payees.length === 1 ? '' : 's'}`, { x: 62, y, size: 10.5, font: bold });
      const tt = money(total);
      p.drawText(tt, { x: 555 - bold.widthOfTextAtSize(tt, 10.5), y, size: 10.5, font: bold });
      p.drawText(safe(data.payees.length ? amountInWords(total) : ''), { x: 62, y: y - 16, size: 9, font, color: rgb(0.3, 0.3, 0.35) });
    }
  }
  doc.setTitle(`Metro Bank Bulk Payment Instruction${data.monthLabel ? ` - ${data.monthLabel}` : ''}`);
  return doc.save();
}

module.exports = { fillMetroForm, amountInWords, money, TEMPLATE };
