'use strict';

// The month's Metro Bank payment instruction (Rent run step 5): who is paid, from which account,
// and the details written onto Metro's form. Saved per company per month.

const fmt = require('./format');
const st = require('./statements');
const { amountInWords, money } = require('./metroForm');

// A typed total in figures ("5000", "£5,000.00", "5000-5") written the bank's way: £5,000-00.
function tidyFigures(v) {
  const m = String(v || '').replace(/[£,\s]/g, '').match(/^(\d+)(?:[.\-](\d{0,2}))?$/);
  return m ? money(Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'))) : String(v || '');
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const shortMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(y).slice(2)}`;
};

module.exports = function paymentInstruction(db) {
// Landlords to pay this month: those paid by bank (statement type Email) holding money.
function suggestedPayees(accountId, month) {
  return db.prepare(
    `SELECT l.id, l.name, l.code, l.bank_account_name, l.bank_sort_code, l.bank_account_number, s.closing_pence
       FROM landlords l JOIN monthly_statements s ON s.landlord_id = l.id AND s.account_id = l.account_id AND s.month = ?
      WHERE l.account_id = ? AND l.statement_type != 'Cheque' AND s.closing_pence > 0
      ORDER BY l.name COLLATE NOCASE`
  ).all(month, accountId).map((l) => ({
    include: true, landlord_id: l.id, name: l.bank_account_name || l.name, sort_code: l.bank_sort_code || '',
    account_number: l.bank_account_number || '', amount: fmt.penceToInput(l.closing_pence),
    // Banks allow 18 characters: e.g. "RO1 Rent Aug 26".
    reference: clip(`${l.code ? `${l.code} ` : ''}Rent ${shortMonth(month)}`, 18),
  }));
}

function load(accountId, month) {
  const row = db.prepare('SELECT data_json, updated_at FROM payment_instructions WHERE account_id = ? AND month = ?').get(accountId, month);
  if (row) return { ...JSON.parse(row.data_json), saved_at: row.updated_at };
  // A new month starts from the last instruction's "paying from" details.
  const last = db.prepare('SELECT data_json FROM payment_instructions WHERE account_id = ? ORDER BY month DESC LIMIT 1').get(accountId);
  const prev = last ? JSON.parse(last.data_json) : {};
  return {
    store: prev.store || '', contact_name: prev.contact_name || '',
    from_name: prev.from_name || '', from_sort_code: prev.from_sort_code || '', from_account_number: prev.from_account_number || '',
    payment_date: '', signatory_1: prev.signatory_1 || '', signatory_2: prev.signatory_2 || '', notes: '',
    payees: suggestedPayees(accountId, month), saved_at: null,
  };
}

function total(data) {
  return data.payees.filter((p) => p.include).reduce((t, p) => t + (Number.isNaN(fmt.parseMoney(p.amount)) ? 0 : fmt.parseMoney(p.amount)), 0);
}


// Worked-out figures for the form: total in figures and words, and the number of payments.
function figures(data) {
  const pence = total(data);
  const n = data.payees.filter((p) => p.include).length;
  return { totalFigures: n ? money(pence) : '', totalWords: n ? amountInWords(pence) : '', count: n ? String(n) : '' };
}

// Save the step 5 box. Figures typed over are kept; left as worked out, they follow the payments.
function saveForm(accountId, month, body, userName) {
  const data = load(accountId, month);
  delete data.saved_at;
  const auto = figures(data);
  const f = (k, n = 60) => clip(body[k], n);
  Object.assign(data, {
    store: f('store'), from_name: f('from_name'), contact_name: f('contact_name'), from_account_number: f('from_account_number', 12),
    payment_date: fmt.isIsoDate(String(body.payment_date || '')) ? body.payment_date : '',
    signatory_1: f('signatory_1'), signatory_2: f('signatory_2'),
  });
  for (const k of ['totalFigures', 'totalWords', 'count']) {
    const v = k === 'totalFigures' ? tidyFigures(f(k, 200)) : f(k, 200);
    data[`${k}_override`] = v && v !== auto[k] ? v : '';
  }
  db.prepare(
    `INSERT INTO payment_instructions (account_id, month, data_json) VALUES (?, ?, ?)
     ON CONFLICT (account_id, month) DO UPDATE SET data_json = excluded.data_json, updated_at = datetime('now')`
  ).run(accountId, month, JSON.stringify(data));
  return data;
}

// What the step 5 box shows: saved values, or suggestions (worked-out figures, your name).
function formFor(user, month) {
  const data = load(user.id, month);
  const auto = figures(data);
  const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(user.id);
  return {
    store: data.store || '', from_name: data.from_name || '', contact_name: data.contact_name || user.name || '',
    from_account_number: data.from_account_number || '', payment_date: data.payment_date || '',
    totalFigures: tidyFigures(data.totalFigures_override) || auto.totalFigures, totalWords: data.totalWords_override || auto.totalWords,
    count: data.count_override || auto.count, signatory_1: data.signatory_1 || '', signatory_2: data.signatory_2 || '',
    payees: data.payees.filter((p) => p.include).length, saved_at: data.saved_at, agencyName: agency.agency_name,
  };
}

// Everything fillMetroForm needs. `typed` (the step 5 box, unsaved) previews changes.
function metroData(user, month, typed = null) {
  const data = load(user.id, month);
  if (typed) {
    const f = (k, n = 60) => clip(typed[k], n);
    Object.assign(data, {
      store: f('store'), from_name: f('from_name'), contact_name: f('contact_name'), from_account_number: f('from_account_number', 12),
      payment_date: fmt.isIsoDate(String(typed.payment_date || '')) ? typed.payment_date : '',
      signatory_1: f('signatory_1'), signatory_2: f('signatory_2'),
      totalFigures_override: f('totalFigures', 200), totalWords_override: f('totalWords', 200), count_override: f('count', 200),
    });
  }
  const agency = db.prepare('SELECT agency_name, name FROM users WHERE id = ?').get(user.id);
  const payees = data.payees.filter((p) => p.include).map((p) => ({
    name: p.name, sort_code: p.sort_code, account_number: p.account_number, reference: p.reference,
    pence: Number.isNaN(fmt.parseMoney(p.amount)) ? 0 : fmt.parseMoney(p.amount),
  }));
  return {
    store: '', accountName: data.from_name, // Store: left blank on the form for now contactName: data.contact_name || user.name || agency.name,
    accountNumber: data.from_account_number, valueDate: data.payment_date ? fmt.ukDate(data.payment_date) : '',
    signatory1: '', signatory2: '', payees, // signed by hand after printing
    totalFigures: tidyFigures(data.totalFigures_override) || undefined, totalWords: data.totalWords_override || undefined, count: data.count_override || undefined,
    monthLabel: st.monthLabel(month), agencyName: agency.agency_name,
  };
}

return { suggestedPayees, load, total, figures, saveForm, formFor, metroData };
};
