'use strict';

// Month end: the statements report (preview and CSV) and the emails that go with it.
// Everything here reads the saved monthly statements, so the report, the emails and the
// statement pages always show the same figures.

const fmt = require('./format');
const { monthLabel } = require('./statements');

const pounds = (pence) => (Number(pence || 0) / 100).toFixed(2);

// One row per property on each landlord's statement, plus a total row per landlord.
function statementsReport(db, accountId, month) {
  const statements = db.prepare(
    `SELECT s.*, l.name AS landlord_name, l.code AS landlord_code, l.email AS landlord_email
       FROM monthly_statements s JOIN landlords l ON l.id = s.landlord_id
      WHERE s.account_id = ? AND s.month = ? ORDER BY l.name COLLATE NOCASE`
  ).all(accountId, month);
  const missing = db.prepare(
    `SELECT l.id, l.name FROM landlords l
      WHERE l.account_id = ? AND NOT EXISTS (SELECT 1 FROM monthly_statements s WHERE s.landlord_id = l.id AND s.month = ?)
      ORDER BY l.name COLLATE NOCASE`
  ).all(accountId, month);

  const landlords = statements.map((s) => {
    const detail = JSON.parse(s.detail_json);
    return {
      id: s.landlord_id, statementId: s.id, name: s.landlord_name, code: s.landlord_code || '', email: s.landlord_email || '',
      emailedAt: s.emailed_at, emailedTo: s.emailed_to,
      properties: detail.properties.map((p) => ({
        address: p.address_line1, due: p.charged, received: p.rent, fees: p.fees, costs: p.expenses, net: p.net, outstanding: p.outstanding,
      })),
      totals: {
        due: detail.properties.reduce((t, p) => t + p.charged, 0),
        received: s.rent_pence, fees: s.fees_pence, costs: s.expenses_pence, net: s.net_pence, outstanding: s.outstanding_pence,
        opening: s.opening_pence, paid: s.payments_pence, held: s.closing_pence,
      },
    };
  });
  const sum = (k) => landlords.reduce((t, l) => t + l.totals[k], 0);
  const totals = Object.fromEntries(['due', 'received', 'fees', 'costs', 'net', 'outstanding', 'opening', 'paid', 'held'].map((k) => [k, sum(k)]));
  return { month, monthLabel: monthLabel(month), landlords, totals, missing };
}

const CSV_HEADERS = [
  'Month', 'Landlord', 'Landlord code', 'Landlord email', 'Property', 'Rent due', 'Rent received', 'Management fees',
  'Costs', 'Net for month', 'Rent outstanding', 'Balance at start', 'Paid to landlord', 'Balance held at end',
];

// Text cells that a spreadsheet would treat as a formula are prefixed with an apostrophe.
function csvCell(v, numeric = false) {
  let s = v === null || v === undefined ? '' : String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportCsv(report) {
  const lines = [CSV_HEADERS.map((h) => csvCell(h))];
  const text = (...cells) => cells.map((c) => csvCell(c));
  const money = (...cells) => cells.map((c) => (c === '' ? '' : csvCell(pounds(c), true)));
  for (const l of report.landlords) {
    for (const p of l.properties) {
      lines.push([...text(report.month, l.name, l.code, l.email, p.address), ...money(p.due, p.received, p.fees, p.costs, p.net, p.outstanding, '', '', '')]);
    }
    const t = l.totals;
    lines.push([...text(report.month, l.name, l.code, l.email, 'Landlord total'), ...money(t.due, t.received, t.fees, t.costs, t.net, t.outstanding, t.opening, t.paid, t.held)]);
  }
  const t = report.totals;
  lines.push([...text(report.month, 'ALL LANDLORDS', '', '', 'Grand total'), ...money(t.due, t.received, t.fees, t.costs, t.net, t.outstanding, t.opening, t.paid, t.held)]);
  // A byte-order mark so Excel reads the file as UTF-8 and names with accents come out right.
  return `﻿${lines.map((r) => r.join(',')).join('\r\n')}\r\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The email a landlord receives with their monthly statement.
function statementEmail({ agencyName, statement, landlordName }) {
  const s = statement;
  const detail = JSON.parse(s.detail_json);
  const label = monthLabel(s.month);
  const m = fmt.money;
  const minus = (p) => (p ? `−${m(p)}` : '—');
  const subject = `Your statement for ${label} from ${agencyName}`;

  const propLines = detail.properties.map((p) => `  ${p.address_line1}: received ${m(p.rent)}, fees ${minus(p.fees)}, costs ${minus(p.expenses)}, net ${m(p.net)}${p.outstanding ? ` (${m(p.outstanding)} outstanding)` : ''}`);
  const text = [
    `Dear ${landlordName},`, '',
    `Here is your statement for ${label}.`, '',
    s.summary, '',
    `Rent received:        ${m(s.rent_pence)}`,
    `Management fees:      ${minus(s.fees_pence)}`,
    `Repairs & other costs: ${minus(s.expenses_pence)}`,
    `Net for the month:    ${m(s.net_pence)}`,
    s.payments_pence ? `Paid to you:          ${m(s.payments_pence)}` : null,
    `Balance held for you: ${m(s.closing_pence)}`, '',
    'By property:', ...propLines, '',
    `If you have any questions, just reply to this email.`, '', agencyName,
  ].filter((l) => l !== null).join('\n');

  const td = 'padding:6px 10px;border-bottom:1px solid #d5dae1;';
  const num = `${td}text-align:right;white-space:nowrap;`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="max-width:640px;margin:0 auto;padding:24px;">
<div style="background:#ffffff;border:1px solid #d5dae1;border-radius:10px;padding:24px;">
<div style="font-weight:700;font-size:18px;">${esc(agencyName)}</div>
<h1 style="font-size:20px;margin:6px 0 16px;">Your statement for ${esc(label)}</h1>
<p>Dear ${esc(landlordName)},</p>
<p style="white-space:pre-wrap;line-height:1.5;">${esc(s.summary)}</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;">
<tr><td style="${td}">Rent received</td><td style="${num}">${m(s.rent_pence)}</td></tr>
<tr><td style="${td}">Management fees</td><td style="${num}">${minus(s.fees_pence)}</td></tr>
<tr><td style="${td}">Repairs &amp; other costs</td><td style="${num}">${minus(s.expenses_pence)}</td></tr>
<tr><td style="${td}font-weight:700;">Net for the month</td><td style="${num}font-weight:700;">${m(s.net_pence)}</td></tr>
${s.payments_pence ? `<tr><td style="${td}">Paid to you</td><td style="${num}">${m(s.payments_pence)}</td></tr>` : ''}
<tr><td style="${td}">Balance held for you</td><td style="${num}">${m(s.closing_pence)}</td></tr>
</table>
<h2 style="font-size:16px;margin:20px 0 6px;">By property</h2>
<table style="border-collapse:collapse;width:100%;font-size:13px;">
<tr style="background:#eef0f3;"><th style="${td}text-align:left;">Property</th><th style="${num}">Received</th><th style="${num}">Fees</th><th style="${num}">Costs</th><th style="${num}">Net</th></tr>
${detail.properties.map((p) => `<tr><td style="${td}">${esc(p.address_line1)}${p.outstanding ? `<br><span style="color:#961a10;font-size:12px;">${m(p.outstanding)} outstanding</span>` : ''}</td><td style="${num}">${m(p.rent)}</td><td style="${num}">${minus(p.fees)}</td><td style="${num}">${minus(p.expenses)}</td><td style="${num}font-weight:700;">${m(p.net)}</td></tr>`).join('\n')}
</table>
<p style="margin-top:20px;">If you have any questions, just reply to this email.</p>
<p>${esc(agencyName)}</p>
</div></div></body></html>`;
  return { subject, text, html };
}

// The email carrying the CSV report.
function reportEmail({ agencyName, report }) {
  const t = report.totals;
  const subject = `Landlord statements report for ${report.monthLabel} (${agencyName})`;
  const text = [
    `Attached is the landlord statements report for ${report.monthLabel}.`, '',
    `Landlords: ${report.landlords.length}`,
    `Rent received: ${fmt.money(t.received)}`,
    `Management fees: ${fmt.money(t.fees)}`,
    `Costs: ${fmt.money(t.costs)}`,
    `Net for landlords: ${fmt.money(t.net)}`,
    `Rent outstanding: ${fmt.money(t.outstanding)}`,
    `Balance held at end of month: ${fmt.money(t.held)}`, '',
    agencyName,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;"><p>${esc(text).replace(/\n/g, '<br>')}</p></body></html>`;
  return { subject, text, html, filename: `statements-${report.month}.csv` };
}

module.exports = { statementsReport, reportCsv, statementEmail, reportEmail, csvCell };
