'use strict';

// Client-account accounting rules. All amounts are integer pence.

// Signed effect of each transaction type on what the agency holds for a landlord.
const LANDLORD_SIGN = { rent_received: 1, fee: -1, expense: -1, landlord_payment: -1, rent_charge: 0 };

// Fill in property/landlord links implied by the tenancy or property, so ledgers roll up.
function resolveLinks(db, accountId, values) {
  if (values.tenancy_id && !values.property_id) {
    const t = db.prepare('SELECT property_id FROM tenancies WHERE id = ? AND account_id = ?').get(values.tenancy_id, accountId);
    if (t) values.property_id = t.property_id;
  }
  if (values.property_id && !values.landlord_id) {
    const p = db.prepare('SELECT landlord_id FROM properties WHERE id = ? AND account_id = ?').get(values.property_id, accountId);
    if (p && p.landlord_id) values.landlord_id = p.landlord_id;
  }
  return values;
}

// When rent is received on a managed property, book the agency's management fee against it.
function bookManagementFee(db, accountId, txnId) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND account_id = ?').get(txnId, accountId);
  db.prepare("DELETE FROM transactions WHERE source_txn_id = ? AND txn_type = 'fee'").run(txnId);
  if (!txn || txn.txn_type !== 'rent_received' || !txn.property_id) return;
  const p = db.prepare('SELECT management_fee_pct FROM properties WHERE id = ? AND account_id = ?').get(txn.property_id, accountId);
  const pct = p && p.management_fee_pct;
  if (!pct || pct <= 0) return;
  const fee = Math.round((txn.amount_pence * pct) / 100);
  if (fee <= 0) return;
  db.prepare(
    `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, tenancy_id, description, amount_pence, source_txn_id)
     VALUES (?, ?, 'fee', ?, ?, ?, ?, ?, ?)`
  ).run(accountId, txn.txn_date, txn.landlord_id, txn.property_id, txn.tenancy_id,
    `Management fee ${pct}% of rent received`, fee, txn.id);
}

// Monthly-equivalent rent for a tenancy.
function monthlyRent(tenancy) {
  return tenancy.rent_frequency === 'weekly' ? Math.round((tenancy.rent_pence * 52) / 12) : tenancy.rent_pence;
}

// Raise one rent charge per active tenancy for the given month (YYYY-MM), skipping any
// tenancy already charged that month or not running during it. Returns the number raised.
function raiseMonthlyRent(db, accountId, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const tenancies = db.prepare(
    `SELECT ty.*, p.landlord_id FROM tenancies ty JOIN properties p ON p.id = ty.property_id
      WHERE ty.account_id = ? AND ty.status = 'active'
        AND ty.start_date <= ? AND (ty.end_date IS NULL OR ty.end_date >= ?)`
  ).all(accountId, monthEnd, monthStart);
  const alreadyCharged = db.prepare(
    `SELECT 1 FROM transactions WHERE account_id = ? AND tenancy_id = ? AND txn_type = 'rent_charge'
        AND substr(txn_date, 1, 7) = ?`
  );
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, tenancy_id, description, amount_pence)
     VALUES (?, ?, 'rent_charge', ?, ?, ?, ?, ?)`
  );
  let raised = 0;
  for (const t of tenancies) {
    if (alreadyCharged.get(accountId, t.id, month)) continue;
    const dueDay = Math.min(Number(t.start_date.slice(8, 10)) || 1, daysInMonth);
    const dueDate = `${month}-${String(dueDay).padStart(2, '0')}`;
    const desc = t.rent_frequency === 'weekly' ? `Rent for ${month} (weekly rent, monthly equivalent)` : `Rent for ${month}`;
    insert.run(accountId, dueDate, t.landlord_id, t.property_id, t.id, desc, monthlyRent(t));
    raised += 1;
  }
  return raised;
}

// Tenancies whose rent charged exceeds rent received.
function arrears(db, accountId) {
  return db.prepare(
    `SELECT ty.id, p.address_line1, t.name AS tenant_name,
            SUM(CASE tx.txn_type WHEN 'rent_charge' THEN tx.amount_pence WHEN 'rent_received' THEN -tx.amount_pence ELSE 0 END) AS owed
       FROM tenancies ty
       JOIN properties p ON p.id = ty.property_id
       JOIN tenants t ON t.id = ty.tenant_id
       JOIN transactions tx ON tx.tenancy_id = ty.id
      WHERE ty.account_id = ?
      GROUP BY ty.id
     HAVING owed > 0
      ORDER BY owed DESC`
  ).all(accountId);
}

function landlordBalanceSql(alias = 'tx') {
  return `SUM(CASE ${alias}.txn_type WHEN 'rent_received' THEN ${alias}.amount_pence
                              WHEN 'rent_charge' THEN 0
                              ELSE -${alias}.amount_pence END)`;
}

// Money held in the client account: rent in, minus everything paid out or taken as fees.
function clientAccountBalance(db, accountId) {
  const row = db.prepare(`SELECT COALESCE(${landlordBalanceSql('tx')}, 0) AS bal FROM transactions tx WHERE account_id = ?`).get(accountId);
  return row.bal;
}

function landlordStatement(db, accountId, landlordId, from, to) {
  const opening = db.prepare(
    `SELECT COALESCE(${landlordBalanceSql('tx')}, 0) AS bal FROM transactions tx
      WHERE account_id = ? AND landlord_id = ? AND txn_date < ?`
  ).get(accountId, landlordId, from).bal;
  const rows = db.prepare(
    `SELECT tx.*, p.address_line1 FROM transactions tx LEFT JOIN properties p ON p.id = tx.property_id
      WHERE tx.account_id = ? AND tx.landlord_id = ? AND tx.txn_date BETWEEN ? AND ?
        AND tx.txn_type != 'rent_charge'
      ORDER BY tx.txn_date, tx.id`
  ).all(accountId, landlordId, from, to);
  let running = opening;
  const totals = { rent_received: 0, fee: 0, expense: 0, landlord_payment: 0 };
  for (const r of rows) {
    running += LANDLORD_SIGN[r.txn_type] * r.amount_pence;
    r.balance = running;
    totals[r.txn_type] += r.amount_pence;
  }
  return { opening, closing: running, rows, totals };
}

module.exports = { resolveLinks, bookManagementFee, raiseMonthlyRent, monthlyRent, arrears, clientAccountBalance, landlordStatement, landlordBalanceSql };
