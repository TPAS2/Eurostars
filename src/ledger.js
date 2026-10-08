'use strict';

// Client-account accounting rules. All amounts are integer pence.

// Signed effect of each transaction type on what the agency holds for a landlord.
const LANDLORD_SIGN = { rent_received: 1, landlord_rent: 1, fee: -1, expense: -1, landlord_payment: -1, rent_charge: 0 };

// A property on a fixed monthly payment to its landlord ("Rent paid to landlord") is credited
// that amount on each Rent run whether or not the rent has come in. From the first month it's
// credited, rent received on that property belongs to the agency, so it no longer counts
// towards the landlord's balance (rent received in earlier months still does).
function fixedRentSql(alias = 'tx') {
  return `EXISTS (SELECT 1 FROM transactions lr WHERE lr.account_id = ${alias}.account_id AND lr.property_id = ${alias}.property_id
            AND lr.txn_type = 'landlord_rent' AND substr(lr.txn_date, 1, 7) <= substr(${alias}.txn_date, 1, 7))`;
}

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
  if (!txn || !['rent_received', 'landlord_rent'].includes(txn.txn_type) || !txn.property_id) return;
  // Rent received on a fixed-payment property is the agency's, so no fee is taken from it.
  if (txn.txn_type === 'rent_received' && db.prepare(`SELECT ${fixedRentSql('t')} AS fixed FROM transactions t WHERE t.id = ?`).get(txn.id).fixed) return;
  const p = db.prepare('SELECT management_fee_pct FROM properties WHERE id = ? AND account_id = ?').get(txn.property_id, accountId);
  const pct = p && p.management_fee_pct;
  if (!pct || pct <= 0) return;
  const fee = Math.round((txn.amount_pence * pct) / 100);
  if (fee <= 0) return;
  db.prepare(
    `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, tenancy_id, description, amount_pence, source_txn_id)
     VALUES (?, ?, 'fee', ?, ?, ?, ?, ?, ?)`
  ).run(accountId, txn.txn_date, txn.landlord_id, txn.property_id, txn.tenancy_id,
    `Management fee ${pct}% of ${txn.txn_type === 'landlord_rent' ? 'rent' : 'rent received'}`, fee, txn.id);
}

// Credit each fixed-payment property's landlord with their monthly rent for the month (YYYY-MM),
// whether or not the rent has come in, and take any management fee from it. Skips properties
// already credited that month, whose lease with the landlord starts after the month, or handed back
// before the month. (Not "date acquired": that's filled in with the day a property is entered.)
function creditLandlordRent(db, accountId, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const props = db.prepare(
    `SELECT id, landlord_id, landlord_rent_pence FROM properties
      WHERE account_id = ? AND landlord_id IS NOT NULL AND landlord_rent_pence > 0
        AND (lease_start_date IS NULL OR lease_start_date = '' OR lease_start_date <= ?)
        AND (handed_back_date IS NULL OR handed_back_date >= ?)
        AND NOT (status = 'handed back' AND handed_back_date IS NULL)`
  ).all(accountId, monthEnd, monthStart);
  const already = db.prepare("SELECT 1 FROM transactions WHERE account_id = ? AND property_id = ? AND txn_type = 'landlord_rent' AND substr(txn_date, 1, 7) = ?");
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, description, amount_pence)
     VALUES (?, ?, 'landlord_rent', ?, ?, ?, ?)`
  );
  let credited = 0;
  for (const p of props) {
    if (already.get(accountId, p.id, month)) continue;
    const id = Number(insert.run(accountId, monthStart, p.landlord_id, p.id, `Rent for ${month}`, p.landlord_rent_pence).lastInsertRowid);
    bookManagementFee(db, accountId, id);
    // Fees taken from rent received on this property from this month on are no longer due.
    db.prepare(
      `DELETE FROM transactions WHERE account_id = ? AND txn_type = 'fee' AND source_txn_id IN
         (SELECT id FROM transactions WHERE account_id = ? AND property_id = ? AND txn_type = 'rent_received' AND substr(txn_date, 1, 7) >= ?)`
    ).run(accountId, accountId, p.id, month);
    credited += 1;
  }
  return credited;
}

// Monthly-equivalent rent for a tenancy: its own rent if it has one, otherwise the property's rent
// from whoever pays it (Rent from tenant, property_tenant_rent_pence, or Rent from council,
// property_rent_pence, when the caller selects them), falling back to the other if that one is blank.
function monthlyRent(tenancy) {
  if (!(tenancy.rent_pence > 0)) {
    // The property's rent from whoever pays it; if that one is blank, the other one.
    const council = tenancy.property_rent_pence > 0 ? tenancy.property_rent_pence : 0;
    const tenant = tenancy.property_tenant_rent_pence > 0 ? tenancy.property_tenant_rent_pence : 0;
    return tenancy.paid_by === 'Tenant' ? (tenant || council) : (council || tenant);
  }
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
    `SELECT ty.*, p.landlord_id, p.rent_pence AS property_rent_pence, p.tenant_rent_pence AS property_tenant_rent_pence
       FROM tenancies ty JOIN properties p ON p.id = ty.property_id
      WHERE ty.account_id = ? AND ty.status = 'active' AND (ty.rent_pence > 0 OR p.rent_pence > 0 OR p.tenant_rent_pence > 0)
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
    const desc = t.rent_pence > 0 && t.rent_frequency === 'weekly' ? `Rent for ${month} (weekly rent, monthly equivalent)` : `Rent for ${month}`;
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
  return `SUM(CASE WHEN ${alias}.txn_type = 'rent_received' THEN (CASE WHEN ${fixedRentSql(alias)} THEN 0 ELSE ${alias}.amount_pence END)
                   WHEN ${alias}.txn_type = 'landlord_rent' THEN ${alias}.amount_pence
                   WHEN ${alias}.txn_type = 'rent_charge' THEN 0
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
        AND NOT (tx.txn_type = 'rent_received' AND ${fixedRentSql('tx')})
      ORDER BY tx.txn_date, tx.id`
  ).all(accountId, landlordId, from, to);
  let running = opening;
  const totals = { rent_received: 0, landlord_rent: 0, fee: 0, expense: 0, landlord_payment: 0 };
  for (const r of rows) {
    running += LANDLORD_SIGN[r.txn_type] * r.amount_pence;
    r.balance = running;
    totals[r.txn_type] += r.amount_pence;
  }
  return { opening, closing: running, rows, totals };
}

// Why a landlord might not be paid: properties with a landlord but no Rent to landlord, and
// properties with Rent to landlord but no landlord (handed-back ones left out).
function landlordRentGaps(db, accountId) {
  const live = "account_id = ? AND NOT (status = 'handed back' AND handed_back_date IS NULL) AND (handed_back_date IS NULL OR handed_back_date >= date('now', 'start of month', '-1 month'))";
  return {
    noRent: db.prepare(`SELECT id, code, address_line1 FROM properties WHERE ${live} AND landlord_id IS NOT NULL AND (landlord_rent_pence IS NULL OR landlord_rent_pence <= 0) ORDER BY code COLLATE NOCASE, address_line1 COLLATE NOCASE`).all(accountId),
    noLandlord: db.prepare(`SELECT id, code, address_line1 FROM properties WHERE ${live} AND landlord_id IS NULL AND landlord_rent_pence > 0 ORDER BY code COLLATE NOCASE, address_line1 COLLATE NOCASE`).all(accountId),
  };
}

module.exports = { landlordRentGaps, resolveLinks, bookManagementFee, creditLandlordRent, raiseMonthlyRent, monthlyRent, arrears, clientAccountBalance, landlordStatement, landlordBalanceSql };
