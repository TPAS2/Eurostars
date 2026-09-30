'use strict';

// Changes to landlords' bank details that nobody has confirmed yet. Redirecting a landlord's rent
// by changing their bank details is a common fraud, so these are shown as warnings (on the
// landlord's page and in the rent run's payment steps) until someone checks them with the landlord.

const mask = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d ? `••••${d.slice(-4)}` : 'none';
};

function unchecked(db, accountId, landlordId = null) {
  return db.prepare(
    `SELECT c.*, l.name AS landlord_name, u.name AS changed_by_name
       FROM landlord_bank_changes c JOIN landlords l ON l.id = c.landlord_id AND l.account_id = c.account_id
       LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.account_id = ? AND c.checked_at IS NULL ${landlordId ? 'AND c.landlord_id = ?' : ''}
      ORDER BY c.changed_at DESC, c.id DESC`
  ).all(accountId, ...(landlordId ? [landlordId] : [])).map((c) => ({
    ...c, oldAccount: mask(c.old_account), newAccount: mask(c.new_account), oldSort: mask(c.old_sort_code), newSort: mask(c.new_sort_code),
  }));
}

module.exports = { unchecked, mask };
