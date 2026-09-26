'use strict';

// Council reconciliation: for each council and month, the rent owed by the council for its
// tenancies against the money actually received, with the difference still owed.

const ledger = require('./ledger');
const { monthBounds } = require('./statements');

// Per tenancy in a council's properties for the month. "Owed" is the rent charged for the month,
// or the tenancy's monthly rent if the month's rent hasn't been charged yet.
function councilTenancies(db, accountId, month, councilId = null) {
  const { from, to } = monthBounds(month);
  const rows = db.prepare(
    `SELECT ty.id AS tenancy_id, ty.status, ty.start_date, ty.end_date, ty.rent_pence, ty.rent_frequency,
            t.name AS tenant, p.id AS property_id, p.address_line1, p.council_id,
            COALESCE(SUM(CASE WHEN tx.txn_type = 'rent_charge' THEN tx.amount_pence END), 0) AS charged,
            COALESCE(SUM(CASE WHEN tx.txn_type = 'rent_received' THEN tx.amount_pence END), 0) AS received
       FROM tenancies ty
       JOIN properties p ON p.id = ty.property_id
       JOIN tenants t ON t.id = ty.tenant_id
       LEFT JOIN transactions tx ON tx.tenancy_id = ty.id AND tx.account_id = ty.account_id AND tx.txn_date BETWEEN ? AND ?
      WHERE ty.account_id = ? AND p.council_id IS NOT NULL ${councilId ? 'AND p.council_id = ?' : ''}
      GROUP BY ty.id
     HAVING charged > 0 OR received > 0 OR (ty.status = 'active' AND ty.start_date <= ? AND (ty.end_date IS NULL OR ty.end_date >= ?))
      ORDER BY p.address_line1 COLLATE NOCASE, t.name COLLATE NOCASE`
  ).all(from, to, accountId, ...(councilId ? [councilId] : []), to, from);
  return rows.map((r) => {
    const owed = r.charged || (r.status === 'active' ? ledger.monthlyRent(r) : 0);
    const diff = r.received - owed;
    let status = 'paid';
    if (!owed && !r.received) status = 'none';
    else if (!r.received) status = 'not-paid';
    else if (diff < 0) status = 'part-paid';
    else if (diff > 0) status = 'overpaid';
    return { ...r, owed, diff, status };
  });
}

// One row per council on the Councils tab (all of them), with totals.
function reconciliation(db, accountId, month) {
  const councils = db.prepare('SELECT id, name FROM councils WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId);
  const notes = new Map(db.prepare('SELECT council_id, notes FROM council_rec_notes WHERE account_id = ? AND month = ?').all(accountId, month)
    .map((n) => [n.council_id, n.notes]));
  const props = new Map(db.prepare('SELECT council_id, COUNT(*) AS n FROM properties WHERE account_id = ? AND council_id IS NOT NULL GROUP BY council_id').all(accountId)
    .map((p) => [p.council_id, p.n]));
  const byCouncil = new Map(councils.map((c) => [c.id, {
    ...c, properties: props.get(c.id) || 0, tenancies: 0, owed: 0, received: 0, notes: notes.get(c.id) || '', unpaid: 0,
  }]));
  for (const t of councilTenancies(db, accountId, month)) {
    const c = byCouncil.get(t.council_id);
    if (!c) continue;
    c.tenancies += 1;
    c.owed += t.owed;
    c.received += t.received;
    if (t.status === 'not-paid' || t.status === 'part-paid') c.unpaid += 1;
  }
  const rows = [...byCouncil.values()].map((c) => ({ ...c, balance: c.owed - c.received }));
  const totals = rows.reduce((t, c) => ({
    properties: t.properties + c.properties, tenancies: t.tenancies + c.tenancies, owed: t.owed + c.owed,
    received: t.received + c.received, balance: t.balance + c.balance,
  }), { properties: 0, tenancies: 0, owed: 0, received: 0, balance: 0 });
  return { rows, totals };
}

module.exports = { reconciliation, councilTenancies };
