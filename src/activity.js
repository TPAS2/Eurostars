'use strict';

// Activity log: what each signed-in person views and changes, for the admin panel.
// Every page view and every successful change is recorded with a plain-English summary.

const { ENTITIES } = require('./entities');
const fmt = require('./format');

const KEEP_DAYS = 180;
const AUTOSAVE_QUIET_MS = 5 * 60 * 1000; // one "Edited" entry per record per 5 minutes of typing

function recordTitle(db, def, id, accountId) {
  if (!def || !Number.isInteger(id)) return '';
  const row = db.prepare(`SELECT * FROM ${def.table} WHERE id = ? AND account_id = ?`).get(id, accountId);
  if (!row) return '';
  if (def.titleField) return String(row[def.titleField] ?? '');
  if (def.key === 'tenancies') {
    const t = db.prepare('SELECT p.address_line1 AS a, t.name AS n FROM tenancies ty JOIN properties p ON p.id = ty.property_id JOIN tenants t ON t.id = ty.tenant_id WHERE ty.id = ?').get(id);
    return t ? `${t.a} (${t.n})` : '';
  }
  if (def.key === 'transactions') return `${fmt.humanize(row.txn_type)} ${fmt.money(row.amount_pence)}`;
  return `#${id}`;
}

const withTitle = (text, title) => (title ? `${text}: ${title}` : text);

// Works out a summary for the request. Runs before the route so deleted records can be named.
function describe(db, req) {
  const user = req.user;
  const path = req.path;
  const post = req.method === 'POST';
  const a = user.id;
  const parts = path.split('/').filter(Boolean);

  if (path === '/logout') return { action: 'signed out', text: 'Signed out' };

  if (parts[0] === 'admin') {
    const target = parts[1] === 'users' && /^\d+$/.test(parts[2] || '')
      ? db.prepare('SELECT username FROM users WHERE id = ?').get(Number(parts[2])) : null;
    const who = target ? `@${target.username}` : '';
    if (!post) {
      if (parts.length === 1) return { action: 'viewed', text: 'Viewed the admin panel' };
      if (parts[1] === 'backups' && parts[2]) return { action: 'downloaded', text: 'Downloaded a backup' };
      if (parts[1] === 'backups') return { action: 'viewed', text: 'Viewed backups' };
      if (parts[1] === 'accounts') return { action: 'viewed', text: 'Viewed account details' };
      if (parts[1] === 'access') return { action: 'viewed', text: 'Viewed tab access' };
      if (parts[1] === 'security') return { action: 'viewed', text: 'Viewed security settings' };
      if (parts[1] === 'users.csv') return { action: 'downloaded', text: 'Downloaded the user list' };
      if (parts[2] === 'new') return { action: 'viewed', text: 'Opened Add account' };
      if (parts[3] === 'export') return { action: 'downloaded', text: `Downloaded all data for ${who}` };
      if (target) return { action: 'viewed', text: `Viewed account ${who}` };
      return { action: 'viewed', text: 'Viewed the admin panel' };
    }
    if (parts[1] === 'people') {
      const m = /^\d+$/.test(parts[2] || '') ? db.prepare('SELECT name, login_name, company_id FROM users WHERE id = ?').get(Number(parts[2])) : null;
      const c = m ? db.prepare('SELECT username FROM users WHERE id = ?').get(m.company_id) : null;
      const label = m ? `${m.name} (${c ? c.username : ''} + ${m.login_name})` : 'a person';
      const verb = { password: 'Reset password for', suspend: 'Suspended', activate: 'Reactivated', delete: 'Removed' }[parts[3]] || 'Changed';
      return { action: parts[3] === 'delete' ? 'deleted' : 'updated', text: `${verb} ${label}` };
    }
    if (parts[1] === 'users' && parts[3] === 'people') return { action: 'created', text: `Added ${String(req.body.name || 'a person').trim()} to ${who}` };
    if (parts[1] === 'users' && parts.length === 2) return { action: 'created', text: `Created account @${String(req.body.username || '').trim()}` };
    if (parts[1] === 'backups') return { action: 'created', text: 'Made a backup' };
    if (parts[1] === 'access') return { action: 'updated', text: 'Changed which tabs people can see' };
    if (parts[3] === 'tabs') return { action: 'updated', text: `Changed which tabs a person sees at ${who}` };
    const verb = { details: 'Saved details for', password: 'Reset password for', suspend: 'Suspended', activate: 'Reactivated', logout: 'Signed out everywhere', delete: 'Deleted account' }[parts[3]];
    if (verb) return { action: parts[3] === 'delete' ? 'deleted' : 'updated', text: `${verb} ${who}` };
    return { action: 'updated', text: `Admin change (${path})` };
  }

  if (parts[0] !== 'app') return null;
  if (parts.length === 1) return { action: 'viewed', text: 'Viewed the dashboard' };

  const [, section, idPart, sub] = parts;
  const id = /^\d+$/.test(idPart || '') ? Number(idPart) : null;

  // Sections with their own routes.
  if (section === 'account') return { action: 'viewed', text: 'Viewed my account' };
  if (section === 'statements') return { action: 'viewed', text: 'Viewed landlord statements' };
  if (section === 'council-reconciliation') return post ? { action: 'updated', text: `Updated council reconciliation notes for ${req.body.month || ''}`.trim(), autosave: req.get('X-Autosave') === '1' } : { action: 'viewed', text: 'Viewed council reconciliation' };
  if (section === 'rent-run') return { action: 'viewed', text: 'Viewed the rent run' };
  if (section === 'rent' && post) return { action: 'created', text: `Raised rent for ${req.body.month || 'a month'}` };
  if (section === 'monthly') {
    const m = /^\d{4}-\d{2}$/.test(String(req.body.month || req.query.month || '')) ? String(req.body.month || req.query.month) : '';
    if (idPart === 'calculate' && post) return { action: 'created', text: `Calculated all rents and statements for ${m}` };
    if (idPart === 'email' && post) return { action: 'updated', text: req.body.landlord_id ? `Emailed a landlord their statement for ${m}` : `Emailed landlords their statements for ${m}` };
    if (idPart === 'report' && sub === 'email' && post) return { action: 'updated', text: `Emailed the statements report for ${m}` };
    if (idPart === 'report' && !post) return { action: 'viewed', text: `Previewed the statements report for ${m}` };
    if (idPart === 'report.csv') return { action: 'downloaded', text: `Downloaded the statements report CSV for ${m}` };
    if (post) return { action: 'created', text: `Generated monthly statement${req.body.landlord_id ? '' : 's'} for ${req.body.month || ''}`.trim() };
    return { action: 'viewed', text: id ? 'Viewed a monthly statement' : 'Viewed monthly statements' };
  }
  if (section === 'invoices') {
    const inv = id ? db.prepare('SELECT supplier, invoice_number, amount_pence FROM invoices WHERE id = ? AND account_id = ?').get(id, a) : null;
    const name = inv ? `${inv.supplier}${inv.invoice_number ? ' ' + inv.invoice_number : ''} (${fmt.money(inv.amount_pence)})` : '';
    if (!post) {
      if (sub === 'file') return { action: 'viewed', text: withTitle('Opened invoice file', name) };
      if (idPart === 'new') return { action: 'viewed', text: 'Opened Upload invoice' };
      return { action: 'viewed', text: id ? withTitle('Viewed invoice', name) : 'Viewed invoices' };
    }
    if (!id) return { action: 'created', text: withTitle('Uploaded invoice', String(req.body.supplier || '').trim()) };
    if (sub === 'pay') return { action: 'updated', text: withTitle('Paid invoice', name) };
    if (sub === 'unpay') return { action: 'updated', text: withTitle('Undid payment on invoice', name) };
    if (sub === 'delete') return { action: 'deleted', text: withTitle('Deleted invoice', name) };
    return { action: 'updated', text: withTitle('Edited invoice', name) };
  }
  if (section === 'councils' && sub === 'photo') {
    if (!post) return null;
    const title = recordTitle(db, ENTITIES.councils, id, a);
    return { action: parts[4] === 'delete' ? 'deleted' : 'updated', text: withTitle(parts[4] === 'delete' ? 'Removed the picture of council' : 'Changed the picture of council', title) };
  }
  if (section === 'properties' && sub === 'add-tenant') {
    const title = recordTitle(db, ENTITIES.properties, id, a);
    return post ? { action: 'created', text: withTitle('Added a tenant to', title) } : { action: 'viewed', text: withTitle('Opened Add tenant for', title) };
  }

  const def = Object.prototype.hasOwnProperty.call(ENTITIES, section) ? ENTITIES[section] : null;
  if (!def) return null;
  const one = def.singular.toLowerCase();
  if (!post) {
    if (!idPart) return { action: 'viewed', text: `Viewed ${def.plural.toLowerCase()}` };
    if (idPart === 'new') return { action: 'viewed', text: `Opened new ${one}` };
    const title = recordTitle(db, def, id, a);
    return sub === 'edit' ? { action: 'viewed', text: withTitle(`Opened ${one} for editing`, title) } : { action: 'viewed', text: withTitle(`Viewed ${one}`, title) };
  }
  if (!idPart) {
    const title = def.titleField ? String(req.body[def.titleField] || '').trim() : '';
    return { action: 'created', text: withTitle(`Added ${one}`, title) };
  }
  const title = recordTitle(db, def, id, a);
  if (sub === 'delete') return { action: 'deleted', text: withTitle(`Deleted ${one}`, title) };
  return { action: 'updated', text: withTitle(`Edited ${one}`, title), autosave: req.get('X-Autosave') === '1' };
}

function middleware(db) {
  const insert = db.prepare('INSERT INTO activity_log (user_id, action, summary, path, ip) VALUES (?, ?, ?, ?, ?)');
  const recentEdit = db.prepare(
    "SELECT 1 FROM activity_log WHERE user_id = ? AND path = ? AND action = 'updated' AND created_at > datetime('now', ?)"
  );
  return (req, res, next) => {
    if (!req.user || (req.method !== 'GET' && req.method !== 'POST')) return next();
    let info = null;
    try { info = describe(db, req); } catch { info = null; }
    if (!info) return next();
    const user = req.user;
    // Captured now: by the time the response finishes, routers have rewritten req.url.
    const pagePath = req.originalUrl.split('?')[0].slice(0, 300);
    const fullPath = req.originalUrl.slice(0, 300);
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      if (req.method === 'GET' && res.statusCode !== 200) return; // redirects aren't page views
      try {
        if (info.autosave && recentEdit.get(user.person_id, pagePath, `-${AUTOSAVE_QUIET_MS / 1000} seconds`)) return;
        insert.run(user.person_id, info.action, info.text.slice(0, 300), info.autosave ? pagePath : fullPath, req.ip);
      } catch (err) {
        console.error('Could not record activity:', err.message);
      }
    });
    next();
  };
}

function logSignIn(db, userId, ip) {
  db.prepare("INSERT INTO activity_log (user_id, action, summary, path, ip) VALUES (?, 'signed in', 'Signed in', '/login', ?)").run(userId, ip);
}

function prune(db) {
  db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)").run(`-${KEEP_DAYS} days`);
}

module.exports = { middleware, logSignIn, prune, describe, KEEP_DAYS };
