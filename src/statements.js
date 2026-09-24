'use strict';

// Monthly landlord statements. All figures are calculated here from the client-account
// ledger; the AI only writes the covering summary, and any amount it mentions must be one
// of these figures or the summary is replaced with a plain template.

const fmt = require('./format');
const ledger = require('./ledger');

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function previousMonth(isoDate = fmt.today()) {
  const [y, m] = isoDate.slice(0, 7).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

function isMonth(s) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
}

// Everything that goes on one landlord's statement for one month.
function computeStatement(db, accountId, landlordId, month) {
  const { from, to } = monthBounds(month);
  const landlord = db.prepare('SELECT * FROM landlords WHERE id = ? AND account_id = ?').get(landlordId, accountId);
  if (!landlord) return null;

  const { opening, closing, rows } = ledger.landlordStatement(db, accountId, landlordId, from, to);

  const properties = db.prepare('SELECT id, address_line1, postcode, management_fee_pct FROM properties WHERE account_id = ? AND landlord_id = ? ORDER BY address_line1')
    .all(accountId, landlordId);
  const byProperty = new Map(properties.map((p) => [p.id, { ...p, rent: 0, fees: 0, expenses: 0, charged: 0 }]));
  const other = { id: null, address_line1: 'General (not linked to a property)', rent: 0, fees: 0, expenses: 0, charged: 0 };

  const lines = [];
  let payments = 0;
  for (const r of rows) {
    const bucket = (r.property_id && byProperty.get(r.property_id)) || other;
    if (r.txn_type === 'rent_received') bucket.rent += r.amount_pence;
    else if (r.txn_type === 'fee') bucket.fees += r.amount_pence;
    else if (r.txn_type === 'expense') bucket.expenses += r.amount_pence;
    else if (r.txn_type === 'landlord_payment') payments += r.amount_pence;
    lines.push({
      date: r.txn_date, type: r.txn_type, property: r.address_line1 || '',
      description: r.description || fmt.humanize(r.txn_type), amount: r.amount_pence,
      direction: r.txn_type === 'rent_received' ? 'in' : 'out', balance: r.balance,
    });
  }

  // Rent due in the month, to spot arrears.
  const charges = db.prepare(
    `SELECT property_id, SUM(amount_pence) AS due FROM transactions
      WHERE account_id = ? AND landlord_id = ? AND txn_type = 'rent_charge' AND txn_date BETWEEN ? AND ?
      GROUP BY property_id`
  ).all(accountId, landlordId, from, to);
  for (const c of charges) {
    const bucket = (c.property_id && byProperty.get(c.property_id)) || other;
    bucket.charged += c.due;
  }

  const propertyRows = [...byProperty.values(), other]
    .filter((p) => p.id !== null || p.rent || p.fees || p.expenses)
    .map((p) => ({ ...p, net: p.rent - p.fees - p.expenses, outstanding: Math.max(0, p.charged - p.rent) }));

  const totals = propertyRows.reduce(
    (t, p) => ({ rent: t.rent + p.rent, fees: t.fees + p.fees, expenses: t.expenses + p.expenses, outstanding: t.outstanding + p.outstanding }),
    { rent: 0, fees: 0, expenses: 0, outstanding: 0 }
  );
  totals.net = totals.rent - totals.fees - totals.expenses;
  totals.payments = payments;

  return { landlord, month, from, to, opening, closing, properties: propertyRows, lines, totals };
}

// The figures handed to the AI, pre-formatted so it never has to do arithmetic.
function factsForAi(agencyName, s) {
  return {
    agency: agencyName,
    landlord: s.landlord.name,
    month: monthLabel(s.month),
    opening_balance_held: fmt.money(s.opening),
    rent_received: fmt.money(s.totals.rent),
    management_fees_deducted: fmt.money(s.totals.fees),
    other_costs_deducted: fmt.money(s.totals.expenses),
    net_for_month: fmt.money(s.totals.net),
    paid_to_landlord_this_month: fmt.money(s.totals.payments),
    closing_balance_held: fmt.money(s.closing),
    rent_outstanding: fmt.money(s.totals.outstanding),
    properties: s.properties.map((p) => ({
      address: p.address_line1,
      rent_received: fmt.money(p.rent),
      rent_due_this_month: fmt.money(p.charged),
      rent_outstanding: fmt.money(p.outstanding),
      management_fee: fmt.money(p.fees),
      management_fee_rate: p.management_fee_pct ? `${p.management_fee_pct}%` : null,
      costs: fmt.money(p.expenses),
      net: fmt.money(p.net),
    })),
    deductions: s.lines.filter((l) => l.direction === 'out' && l.type !== 'landlord_payment')
      .map((l) => ({ date: fmt.ukDate(l.date), property: l.property, description: l.description, amount: fmt.money(l.amount) })),
  };
}

// Every "£x" in the AI's text must be one of the statement's own figures.
function unknownAmounts(text, facts) {
  const allowed = new Set();
  const collect = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/£[\d,]+(?:\.\d{2})?/g)) allowed.add(normaliseAmount(m[0]));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(facts);
  const found = [...text.matchAll(/£\s?[\d,]+(?:\.\d{1,2})?/g)].map((m) => m[0]);
  return found.filter((a) => !allowed.has(normaliseAmount(a)));
}

function normaliseAmount(a) {
  const n = Number(a.replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? n.toFixed(2) : a;
}

function templateSummary(facts, s) {
  const parts = [];
  const let_ = s.properties.filter((p) => p.rent > 0).map((p) => p.address_line1);
  if (s.totals.rent > 0) {
    parts.push(`In ${facts.month} we received ${facts.rent_received} in rent${let_.length ? ` from ${let_.join(', ')}` : ''}.`);
  } else {
    parts.push(`No rent was received on your behalf in ${facts.month}.`);
  }
  const ded = [];
  if (s.totals.fees) ded.push(`management fees of ${facts.management_fees_deducted}`);
  if (s.totals.expenses) ded.push(`costs of ${facts.other_costs_deducted}`);
  parts.push(ded.length ? `We deducted ${ded.join(' and ')}, leaving ${facts.net_for_month} for the month.` : `There were no deductions this month, so the net amount is ${facts.net_for_month}.`);
  if (s.totals.payments) parts.push(`We paid you ${facts.paid_to_landlord_this_month} during the month.`);
  parts.push(`We are holding ${facts.closing_balance_held} for you at the end of the month.`);
  if (s.totals.outstanding) parts.push(`Rent of ${facts.rent_outstanding} due this month is still outstanding and we are following it up.`);
  return parts.join(' ');
}

// Compute, summarise and save (or refresh) one statement. Returns the saved row id.
async function generateStatement(db, { accountId, agencyName, landlordId, month, writer, log = console.error }) {
  const s = computeStatement(db, accountId, landlordId, month);
  if (!s) return null;
  const facts = factsForAi(agencyName, s);

  let summary = null;
  let source = 'template';
  let model = null;
  let note = null;
  if (writer) {
    try {
      const ai = await writer(facts);
      const bad = unknownAmounts(ai.text, facts);
      if (bad.length) {
        note = `AI summary rejected: it mentioned amounts not on the statement (${bad.join(', ')}).`;
      } else {
        summary = ai.text;
        source = 'ai';
        model = ai.model;
      }
    } catch (err) {
      log(`AI statement summary failed for landlord ${landlordId} ${month}:`, err.message);
      note = 'The AI summary could not be generated, so a standard summary was used.';
    }
  }
  if (!summary) summary = templateSummary(facts, s);

  const snapshot = JSON.stringify({ properties: s.properties, lines: s.lines, from: s.from, to: s.to });
  db.prepare(
    `INSERT INTO monthly_statements
       (account_id, landlord_id, month, opening_pence, rent_pence, fees_pence, expenses_pence, net_pence,
        payments_pence, closing_pence, outstanding_pence, detail_json, summary, summary_source, ai_model, note, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (account_id, landlord_id, month) DO UPDATE SET
       opening_pence = excluded.opening_pence, rent_pence = excluded.rent_pence, fees_pence = excluded.fees_pence,
       expenses_pence = excluded.expenses_pence, net_pence = excluded.net_pence, payments_pence = excluded.payments_pence,
       closing_pence = excluded.closing_pence, outstanding_pence = excluded.outstanding_pence, detail_json = excluded.detail_json,
       summary = excluded.summary, summary_source = excluded.summary_source, ai_model = excluded.ai_model,
       note = excluded.note, generated_at = excluded.generated_at`
  ).run(accountId, landlordId, month, s.opening, s.totals.rent, s.totals.fees, s.totals.expenses, s.totals.net,
    s.totals.payments, s.closing, s.totals.outstanding, snapshot, summary, source, model, note);
  return db.prepare('SELECT id FROM monthly_statements WHERE account_id = ? AND landlord_id = ? AND month = ?').get(accountId, landlordId, month).id;
}

async function generateForAccount(db, { accountId, agencyName, month, writer, onlyMissing = false, log }) {
  const landlords = db.prepare('SELECT id FROM landlords WHERE account_id = ? ORDER BY name').all(accountId);
  const existing = new Set(db.prepare('SELECT landlord_id FROM monthly_statements WHERE account_id = ? AND month = ?').all(accountId, month).map((r) => r.landlord_id));
  const todo = landlords.filter((l) => !(onlyMissing && existing.has(l.id)));
  // A few AI calls at a time keeps a big portfolio quick without hammering rate limits.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map((l) => generateStatement(db, { accountId, agencyName, landlordId: l.id, month, writer, log })));
  }
  return todo.length;
}

// Once a month has ended, make sure every active agency has last month's statements.
async function runMonthlyJob(db, writer, { today = fmt.today(), log = console.log } = {}) {
  const month = previousMonth(today);
  const accounts = db.prepare(
    "SELECT id, agency_name FROM users WHERE status = 'active' AND EXISTS (SELECT 1 FROM landlords l WHERE l.account_id = users.id)"
  ).all();
  let total = 0;
  for (const a of accounts) {
    total += await generateForAccount(db, { accountId: a.id, agencyName: a.agency_name, month, writer, onlyMissing: true, log: console.error });
  }
  if (total) log(`Generated ${total} monthly statement${total === 1 ? '' : 's'} for ${month}.`);
  return total;
}

module.exports = {
  computeStatement, factsForAi, unknownAmounts, templateSummary, generateStatement, generateForAccount,
  runMonthlyJob, monthLabel, previousMonth, isMonth, monthBounds,
};
