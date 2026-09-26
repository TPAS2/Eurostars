'use strict';

// Invoice rows for lists: the property, and whether the cost was deducted from the landlord
// (paid with "charge to landlord"), with the statement it appears on.
const INVOICE_LIST_SQL = `
  SELECT i.*, p.address_line1, m.title AS job_title,
         tx.id AS deduction_id, tx.txn_date AS deducted_on, tx.landlord_id AS deducted_landlord_id, l.name AS deducted_landlord,
         ms.id AS statement_id
    FROM invoices i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN maintenance_jobs m ON m.id = i.maintenance_job_id
    LEFT JOIN transactions tx ON tx.id = i.payment_txn_id AND tx.account_id = i.account_id AND tx.txn_type = 'expense'
    LEFT JOIN landlords l ON l.id = tx.landlord_id
    LEFT JOIN monthly_statements ms ON ms.account_id = i.account_id AND ms.landlord_id = tx.landlord_id AND ms.month = substr(tx.txn_date, 1, 7)`;

// Where to check the deduction: that month's statement, or (if it hasn't been made yet) that
// month's statements page, where it can be generated.
function statementLink(inv) {
  if (!inv.deduction_id || !inv.deducted_landlord_id) return null;
  if (inv.statement_id) return `/app/monthly/${inv.statement_id}`;
  return `/app/monthly?month=${inv.deducted_on.slice(0, 7)}`;
}

module.exports = { INVOICE_LIST_SQL, statementLink };
