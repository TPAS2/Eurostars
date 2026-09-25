'use strict';

// Rent roll: every property for one month, with the rent due, what came in, what was
// deducted (management fees and costs) and what's left for the landlord.
// Uses the same ledger rules as the monthly statements, so the figures agree.

const ledger = require('./ledger');
const { monthBounds } = require('./statements');

function rentRoll(db, accountId, month, landlordId = null) {
  const { from, to } = monthBounds(month);
  const byLandlord = landlordId ? ' AND p.landlord_id = ?' : '';
  const params = landlordId ? [accountId, landlordId] : [accountId];

  const properties = db.prepare(
    `SELECT p.id, p.address_line1, p.status, p.management_fee_pct, p.landlord_id, l.name AS landlord_name, l.code AS landlord_code
       FROM properties p LEFT JOIN landlords l ON l.id = p.landlord_id
      WHERE p.account_id = ?${byLandlord}
      ORDER BY p.address_line1 COLLATE NOCASE`
  ).all(...params);
  const rows = new Map(properties.map((p) => [p.id, {
    ...p, tenants: [], rent: 0, charged: 0, received: 0, fees: 0, expenses: 0,
  }]));

  // Tenancies running during the month: who lives there and the monthly rent.
  const tenancies = db.prepare(
    `SELECT ty.property_id, ty.rent_pence, ty.rent_frequency, t.name
       FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id JOIN properties p ON p.id = ty.property_id
      WHERE ty.account_id = ? AND ty.status = 'active' AND ty.start_date <= ? AND (ty.end_date IS NULL OR ty.end_date >= ?)${byLandlord}
      ORDER BY t.name COLLATE NOCASE`
  ).all(accountId, to, from, ...(landlordId ? [landlordId] : []));
  for (const t of tenancies) {
    const r = rows.get(t.property_id);
    if (!r) continue;
    r.tenants.push(t.name);
    r.rent += ledger.monthlyRent(t);
  }

  // Money for the month, by property.
  const money = db.prepare(
    `SELECT tx.property_id, tx.txn_type, SUM(tx.amount_pence) AS total
       FROM transactions tx JOIN properties p ON p.id = tx.property_id
      WHERE tx.account_id = ? AND tx.txn_date BETWEEN ? AND ?${byLandlord}
      GROUP BY tx.property_id, tx.txn_type`
  ).all(accountId, from, to, ...(landlordId ? [landlordId] : []));
  const field = { rent_charge: 'charged', rent_received: 'received', fee: 'fees', expense: 'expenses' };
  for (const m of money) {
    const r = rows.get(m.property_id);
    if (r && field[m.txn_type]) r[field[m.txn_type]] += m.total;
  }

  const list = [...rows.values()].map((r) => ({
    ...r,
    net: r.received - r.fees - r.expenses,
    outstanding: Math.max(0, r.charged - r.received),
  }));
  const totals = list.reduce((t, r) => {
    for (const k of ['rent', 'charged', 'received', 'fees', 'expenses', 'net', 'outstanding']) t[k] += r[k];
    return t;
  }, { rent: 0, charged: 0, received: 0, fees: 0, expenses: 0, net: 0, outstanding: 0 });
  totals.let = list.filter((r) => r.tenants.length).length;
  return { rows: list, totals };
}

module.exports = { rentRoll };
