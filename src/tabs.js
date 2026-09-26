'use strict';

// The menu tabs a company's people can be given or have hidden (set per person by the admin).
// A hidden tab is removed from that person's menu and its pages are blocked for them.
// The dashboard and "My account" are always available.

const TABS = [
  { key: 'councils', label: 'Councils', paths: ['/app/councils'] },
  { key: 'councilrec', label: 'Council reconciliation', paths: ['/app/council-reconciliation'] },
  { key: 'properties', label: 'Properties', paths: ['/app/properties'] },
  { key: 'landlords', label: 'Landlords', paths: ['/app/landlords'] },
  { key: 'tenants', label: 'Tenants', paths: ['/app/tenants'] },
  { key: 'tenancies', label: 'Tenancies', paths: ['/app/tenancies'] },
  { key: 'maintenance', label: 'Repairs (maintenance)', paths: ['/app/maintenance'] },
  { key: 'invoices', label: 'Invoices', paths: ['/app/invoices'] },
  { key: 'compliance', label: 'Compliance', paths: ['/app/compliance'] },
  { key: 'rentrun', label: 'Rent run', paths: ['/app/rent-run', '/app/monthly/calculate', '/app/monthly/email', '/app/monthly/report'] },
  // Not in the menu, but the pages behind Record rent received / Record payment / Pay landlord.
  { key: 'transactions', label: 'Recording payments', paths: ['/app/transactions'] },
  { key: 'monthly', label: 'Monthly statements', paths: ['/app/monthly'] },
];
const KEYS = new Set(TABS.map((t) => t.key));

// Longest prefixes first, so /app/monthly/report belongs to the Rent run, not Monthly statements.
const PREFIXES = TABS.flatMap((t) => t.paths.map((p) => ({ p, key: t.key }))).sort((a, b) => b.p.length - a.p.length);

function tabForPath(path) {
  const hit = PREFIXES.find(({ p }) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}.`));
  return hit ? hit.key : null;
}

// Stored as a JSON list of hidden tab keys; anything unreadable means nothing is hidden.
function parseHidden(value) {
  try {
    const list = JSON.parse(value || '[]');
    return Array.isArray(list) ? list.filter((k) => KEYS.has(k)) : [];
  } catch {
    return [];
  }
}

// Blocks a hidden tab's pages for the signed-in person.
function guard(req, res, next) {
  if (!req.user || req.user.is_admin || !req.user.hidden_tabs || !req.user.hidden_tabs.length) return next();
  const key = tabForPath(req.originalUrl.split('?')[0]);
  if (!key || !req.user.hidden_tabs.includes(key)) return next();
  if (req.get('X-Autosave') === '1') return res.status(403).json({ ok: false, errors: { form: 'You don’t have access to this section.' } });
  const tab = TABS.find((t) => t.key === key);
  res.status(403).render('error', { title: 'Not available', message: `The ${tab.label} section isn’t available on your login. Ask your administrator if you need it.` });
}

module.exports = { TABS, KEYS, tabForPath, parseHidden, guard };
