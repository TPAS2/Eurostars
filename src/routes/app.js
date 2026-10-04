'use strict';

const express = require('express');
const { ENTITIES, REF_LABELS } = require('../entities');
const { transaction } = require('../db');
const ledger = require('../ledger');
const reconcile = require('../reconcile');
const { INVOICE_LIST_SQL, statementLink } = require('../invoiceSql');
const statements = require('../statements');
const fmt = require('../format');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_LIMIT = 500;

// The certificates offered when adding a property (more can be added on its page).
const NEW_PROPERTY_CERTS = ['Gas Safety (CP12)', 'EICR', 'EPC', 'Insurance'];
const certValues = (body) => Object.fromEntries(Object.entries(body).filter(([k]) => /^cert_\d+_(issued|expiry)$/.test(k)));

const UK_BANKS = ['Allied Irish Bank', 'Bank of Scotland', 'Barclays', 'Chase', 'Co-operative Bank', 'Coutts', 'Cynergy Bank', 'First Direct',
  'Halifax', 'HSBC', 'Lloyds', 'Metro Bank', 'Monzo', 'Nationwide', 'NatWest', 'Revolut', 'Royal Bank of Scotland', 'Santander', 'Starling',
  'Tide', 'TSB', 'Virgin Money'];

module.exports = function appRoutes(db) {
  const router = express.Router();

  // Tenancies whose end date has come are marked ended (a future end date takes effect on the day).
  router.use((req, res, next) => {
    if (req.user && !req.user.is_admin) {
      db.prepare("UPDATE tenancies SET status = 'ended' WHERE account_id = ? AND status != 'ended' AND end_date IS NOT NULL AND end_date <= ?")
        .run(req.user.id, fmt.today());
    }
    next();
  });

  // ---------- helpers ----------

  function refOptions(refKey, accountId) {
    const r = REF_LABELS[refKey];
    return db.prepare(`SELECT ${r.alias}.id AS id, ${r.label} AS label FROM ${r.from} WHERE ${r.alias}.account_id = ? ORDER BY label COLLATE NOCASE`).all(accountId);
  }

  // Everyone at the company (its main login and its people), for "Added by" boxes.
  function peopleOptions(accountId) {
    return db.prepare("SELECT id, name AS label FROM users WHERE (id = ? OR company_id = ?) AND status = 'active' ORDER BY company_id IS NOT NULL, name COLLATE NOCASE").all(accountId, accountId);
  }

  function refLabelMaps(def, accountId) {
    const maps = {};
    for (const f of def.fields) {
      if (f.type === 'ref' && !maps[f.ref]) {
        maps[f.ref] = new Map(refOptions(f.ref, accountId).map((o) => [o.id, o.label]));
      }
      if (f.type === 'person' && !maps.people) maps.people = new Map(peopleOptions(accountId).map((o) => [o.id, o.label]));
    }
    return maps;
  }

  function display(def, field, row, maps) {
    const f = def.fieldMap[field];
    const v = row[field];
    if (f.type === 'computed') return v || { text: '' };
    if (v === null || v === undefined || v === '') return { text: '' };
    switch (f.type) {
      case 'money': return { text: fmt.money(v), num: true };
      case 'date': return { text: fmt.ukDate(v) };
      case 'number': return { text: String(v), num: true };
      case 'integer': return { text: String(v), num: true };
      case 'ref': return { text: maps[f.ref].get(v) || '(deleted)', href: `/app/${f.ref}/${v}` };
      case 'person': return { text: (maps.people && maps.people.get(v)) || 'Someone who has left' };
      case 'select': return { text: (f.optionLabels && f.optionLabels[v]) || fmt.humanize(v), badge: true };
      default: return { text: String(v) };
    }
  }

  function rowTitle(def, row, maps) {
    if (def.titleField) return row[def.titleField];
    if (def.key === 'tenancies') return maps.properties.get(row.property_id) + ' — ' + (maps.tenants.get(row.tenant_id) || '');
    if (def.key === 'transactions') return `${fmt.humanize(row.txn_type)} ${fmt.money(row.amount_pence)} on ${fmt.ukDate(row.txn_date)}`;
    return `${def.singular} #${row.id}`;
  }

  // Validate and coerce submitted form values. Returns { values, errors }.
  function parseForm(def, body, accountId) {
    const values = {};
    const errors = {};
    for (const f of def.fields) {
      let raw = body[f.name];
      // A dropdown left out of the submission entirely takes its default (e.g. Statement type: Email).
      if (raw === undefined && f.type === 'select' && f.default !== undefined) raw = f.default;
      raw = raw === undefined || raw === null ? '' : String(raw).trim();
      if (raw === '') {
        if (f.required) errors[f.name] = `${f.label} is required.`;
        values[f.name] = null;
        continue;
      }
      const max = f.type === 'textarea' ? 10000 : 500;
      if (raw.length > max) { errors[f.name] = `${f.label} is too long.`; continue; }
      // Several emails or phone numbers: one per line (commas and semicolons work too).
      if (f.multi) {
        const items = raw.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
        const bad = f.multi === 'email' ? items.filter((x) => !EMAIL_RE.test(x)) : items.filter((x) => !/^[+\d][\d\s()+-]{5,}$/.test(x));
        if (bad.length) errors[f.name] = `Check ${bad.map((b) => `"${b}"`).join(', ')}: ${f.multi === 'email' ? 'not a valid email address' : 'not a valid phone number'}.`;
        values[f.name] = items.join('\n');
        continue;
      }
      switch (f.type) {
        case 'email':
          if (!EMAIL_RE.test(raw)) errors[f.name] = 'Enter a valid email address.';
          values[f.name] = raw;
          break;
        case 'integer': {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) errors[f.name] = `${f.label} must be a whole number.`;
          values[f.name] = n;
          break;
        }
        case 'number': {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0 || n > 100) errors[f.name] = `${f.label} must be between 0 and 100.`;
          values[f.name] = n;
          break;
        }
        case 'money': {
          const p = fmt.parseMoney(raw);
          if (Number.isNaN(p)) errors[f.name] = 'Enter an amount like 950 or 950.00.';
          values[f.name] = p;
          break;
        }
        case 'date':
          if (!fmt.isIsoDate(raw)) errors[f.name] = 'Enter a valid date.';
          values[f.name] = raw;
          break;
        case 'select':
          if (!f.options.includes(raw)) errors[f.name] = `Choose a valid ${f.label.toLowerCase()}.`;
          values[f.name] = raw;
          break;
        case 'person': {
          const id = Number(raw);
          const ok = Number.isInteger(id) && db.prepare('SELECT 1 FROM users WHERE id = ? AND (id = ? OR company_id = ?)').get(id, accountId, accountId);
          if (!ok) errors[f.name] = `Choose who ${f.label.toLowerCase()}.`;
          values[f.name] = id;
          break;
        }
        case 'ref': {
          const id = Number(raw);
          const owned = Number.isInteger(id) &&
            db.prepare(`SELECT 1 FROM ${ENTITIES[f.ref].table} WHERE id = ? AND account_id = ?`).get(id, accountId);
          if (!owned) errors[f.name] = `Choose a valid ${f.label.toLowerCase()}.`;
          values[f.name] = id;
          break;
        }
        default:
          values[f.name] = raw;
          // UK bank details: stored in a standard form so payment instructions print cleanly.
          if (f.pattern === 'sortcode') {
            const digits = raw.replace(/[\s-]/g, '');
            if (!/^\d{6}$/.test(digits)) errors[f.name] = 'Enter a 6-digit sort code, like 12-34-56.';
            else values[f.name] = `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
          } else if (f.pattern === 'accountnumber') {
            const digits = raw.replace(/\s/g, '');
            if (!/^\d{8}$/.test(digits)) errors[f.name] = 'Enter an 8-digit account number.';
            else values[f.name] = digits;
          }
      }
    }
    // A tenancy can't be booked or start after it ends.
    if (def.key === 'tenancies' && values.end_date) {
      if (values.start_date && values.start_date > values.end_date) errors.start_date = 'The start date can’t be after the end date.';
      if (values.booking_date && values.booking_date > values.end_date) errors.booking_date = 'The reservation date can’t be after the end date.';
      // Once its end date has come, a tenancy is ended.
      if (values.end_date <= fmt.today()) values.status = 'ended';
    }
    if (def.key === 'transactions' && ['rent_charge', 'rent_received'].includes(values.txn_type) && !values.tenancy_id) {
      errors.tenancy_id = 'Rent charges and receipts must be linked to a tenancy.';
    }
    if (def.key === 'transactions' && values.txn_type === 'landlord_payment' && !values.landlord_id && !values.property_id) {
      errors.landlord_id = 'Choose which landlord was paid.';
    }
    return { values, errors };
  }

  function formDefaults(def, query) {
    const values = {};
    for (const f of def.fields) {
      if (query[f.name] !== undefined) values[f.name] = f.type === 'ref' ? Number(query[f.name]) : String(query[f.name]);
      else if (f.default === 'today') values[f.name] = fmt.today();
      else if (f.default !== undefined) values[f.name] = f.default;
    }
    return values;
  }

  // Tenancies live under the Tenants tab.
  const sectionOf = (def) => (def.key === 'tenancies' ? 'tenants' : def.key);

  function renderForm(res, def, { row, values, errors, accountId, status = 200 }) {
    const options = {};
    for (const f of def.fields) if (f.type === 'ref') options[f.name] = refOptions(f.ref, accountId);
    for (const f of def.fields) if (f.type === 'person') options[f.name] = peopleOptions(accountId);
    if (def.key === 'maintenance') options.contractor = db.prepare('SELECT name FROM contractors WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId).map((c) => c.name);
    // Bank names to pick from: the usual UK banks plus any already typed in.
    if (def.key === 'landlords') {
      const used = db.prepare("SELECT DISTINCT bank_name FROM landlords WHERE account_id = ? AND bank_name IS NOT NULL AND bank_name != ''").all(accountId).map((r) => r.bank_name.trim());
      options.bank_name = [...new Set([...UK_BANKS, ...used])].sort((x, y) => x.localeCompare(y));
    }
    const tenantCouncil = def.key === 'tenants' && row ? tenantProperty(accountId, row.id) : null;
    if (tenantCouncil) tenantCouncil.options = refOptions('councils', accountId);
    res.status(status).render('form', { title: row ? `Edit ${def.singular.toLowerCase()}` : `New ${def.singular.toLowerCase()}`, def, row, values, errors, options, tenantCouncil, fmt, section: sectionOf(def) });
  }

  // The property of a tenant's current tenancy (or latest one), whose council the tenant's Edit form can change.
  function tenantProperty(accountId, tenantId) {
    return db.prepare(
      `SELECT p.id AS property_id, p.address_line1, p.council_id FROM tenancies ty JOIN properties p ON p.id = ty.property_id
        WHERE ty.account_id = ? AND ty.tenant_id = ?
        ORDER BY ty.status = 'active' DESC, ty.status = 'pending' DESC, ty.start_date DESC LIMIT 1`
    ).get(accountId, tenantId) || null;
  }

  // Keep derived data consistent after a record is saved.
  // Did the sort code, account number or account name change (ignoring spaces and dashes)?
  const bankKey = (v) => String(v || '').replace(/[\s-]/g, '').toLowerCase();
  function bankDetailsChanged(row, values) {
    return ['bank_account_name', 'bank_sort_code', 'bank_account_number'].some((k) => k in values && bankKey(values[k]) !== bankKey(row[k]))
      // Only when complete details were there already: filling them in for the first time isn't a change.
      && (String(row.bank_sort_code || '').replace(/\D/g, '').length === 6 || String(row.bank_account_number || '').replace(/\D/g, '').length === 8);
  }

  // Confirm a bank details change (after checking it with the landlord, e.g. by phone).
  router.post('/landlords/:id/bank-checked', (req, res) => {
    const id = Number(req.params.id);
    const l = Number.isInteger(id) && db.prepare('SELECT id FROM landlords WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!l) return res.status(404).render('error', { title: 'Not found', message: 'That landlord was not found.' });
    db.prepare("UPDATE landlord_bank_changes SET checked_at = datetime('now'), checked_by = ? WHERE landlord_id = ? AND account_id = ? AND checked_at IS NULL")
      .run(req.user.person_id || req.user.id, l.id, req.user.id);
    res.redirect(`/app/landlords/${l.id}?flash=${encodeURIComponent('Bank details marked as checked.')}`);
  });

  function afterSave(def, accountId, id, values) {
    if (def.key === 'transactions') ledger.bookManagementFee(db, accountId, id);
    if (def.key === 'tenancies' && values.status === 'active') {
      db.prepare("UPDATE properties SET status = 'let' WHERE id = ? AND account_id = ?").run(values.property_id, accountId);
    }
    // A renamed contractor keeps their invoices, which show the new name.
    if (def.key === 'contractors' && values.name) {
      db.prepare('UPDATE invoices SET supplier = ? WHERE contractor_id = ? AND account_id = ?').run(values.name, id, accountId);
    }
  }

  function prepareValues(def, accountId, values) {
    if (def.key === 'transactions') ledger.resolveLinks(db, accountId, values);
    // A job saved as completed is dated today, unless a date was given.
    if (def.key === 'maintenance' && values.status === 'completed' && !values.completed_date) values.completed_date = fmt.today();
    if (def.key === 'maintenance' && values.status && values.status !== 'completed') values.completed_date = null;
    // A handed-back date means the property has gone back to the landlord.
    if (def.key === 'properties' && values.handed_back_date) values.status = 'handed back';
    return values;
  }

  function getEntity(req, res) {
    const def = Object.prototype.hasOwnProperty.call(ENTITIES, req.params.entity) ? ENTITIES[req.params.entity] : null;
    if (!def) res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
    return def;
  }

  function getOwnedRow(def, req, res) {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && db.prepare(`SELECT * FROM ${def.table} WHERE id = ? AND account_id = ?`).get(id, req.user.id);
    if (!row) res.status(404).render('error', { title: 'Not found', message: `That ${def.singular.toLowerCase()} doesn't exist.` });
    return row || null;
  }

  // The certificates every let property needs, shown together on the property page.
  const KEY_CERTS = [
    { type: 'Gas Safety (CP12)', title: 'Gas certificate', icon: 'gas' },
    { type: 'EICR', title: 'Electrical certificate (EICR)', icon: 'electric' },
    { type: 'EPC', title: 'Energy certificate (EPC)', icon: 'energy' },
    { type: 'Insurance', title: 'Insurance', icon: 'insurance' },
  ];

  function certStatus(expiry, today) {
    if (expiry < today) return { key: 'expired', label: 'Expired' };
    if (expiry <= fmt.addDays(today, 30)) return { key: 'expiring', label: 'Expiring soon' };
    return { key: 'valid', label: 'Valid' };
  }

  function keyCertificates(a, propertyId) {
    const today = fmt.today();
    const rows = db.prepare(
      `SELECT * FROM compliance_items WHERE account_id = ? AND property_id = ? AND item_type IN (${KEY_CERTS.map(() => '?').join(',')})
        ORDER BY expiry_date DESC, id DESC`
    ).all(a, propertyId, ...KEY_CERTS.map((k) => k.type));
    return KEY_CERTS.map((k) => {
      const list = rows.filter((r) => r.item_type === k.type);
      const [current, ...previous] = list;
      if (current) current.files = db.prepare('SELECT id, filename FROM compliance_files WHERE account_id = ? AND item_id = ? ORDER BY id').all(a, current.id);
      return { ...k, current: current || null, previous, status: current ? certStatus(current.expiry_date, today) : { key: 'missing', label: 'Missing' } };
    });
  }

  // Council links that run through properties: the councils a landlord or tenant is connected to.
  function relatedLists(def, row, a) {
    const link = (entity, id, text) => ({ text, href: `/app/${entity}/${id}` });
    // A council's page lists just its properties (as a child list), nothing else.
    if (def.key === 'councils' || def.key === 'landlords') return [];
    const councilsVia = (sql, ...params) => db.prepare(sql).all(...params);
    if (def.key === 'landlords') {
      const rows = councilsVia(
        `SELECT c.id, c.name, COUNT(p.id) AS n FROM properties p JOIN councils c ON c.id = p.council_id
          WHERE p.account_id = ? AND p.landlord_id = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`, a, row.id);
      return [{ title: 'Councils', empty: 'None of this landlord\'s properties has a council set yet.', headers: ['Council', 'Properties'],
        rows: rows.map((c) => [link('councils', c.id, c.name), { text: String(c.n), num: true }]) }];
    }
    // A tenant's council is shown in the details box at the top of their page.
    if (def.key === 'tenants') return [];
    return [];
  }

  // ---------- dashboard ----------

  router.get('/', (req, res) => {
    if (req.user.is_admin) return res.redirect('/admin');
    const a = req.user.id;
    const today = fmt.today();
    const soon = fmt.addDays(today, 60);
    const count = (sql, ...p) => db.prepare(sql).get(a, ...p).n;
    const stats = {
      properties: count('SELECT COUNT(*) n FROM properties WHERE account_id = ?'),
      let: count("SELECT COUNT(*) n FROM properties WHERE account_id = ? AND status = 'let'"),
      vacant: count("SELECT COUNT(*) n FROM properties WHERE account_id = ? AND status = 'vacant'"),
      landlords: count('SELECT COUNT(*) n FROM landlords WHERE account_id = ?'),
      tenants: count('SELECT COUNT(*) n FROM tenants WHERE account_id = ?'),
      activeTenancies: count("SELECT COUNT(*) n FROM tenancies WHERE account_id = ? AND status = 'active'"),
      openJobs: count("SELECT COUNT(*) n FROM maintenance_jobs WHERE account_id = ? AND status != 'completed'"),
      unpaidInvoices: count("SELECT COUNT(*) n FROM invoices WHERE account_id = ? AND status = 'unpaid'"),
      unpaidInvoicesTotal: count("SELECT COALESCE(SUM(amount_pence), 0) n FROM invoices WHERE account_id = ? AND status = 'unpaid'"),
      overdueInvoices: count("SELECT COUNT(*) n FROM invoices WHERE account_id = ? AND status = 'unpaid' AND due_date < ?", today),
      clientBalance: ledger.clientAccountBalance(db, a),
    };
    // This month's money: what the councils are invoiced (council reconciliation), what's paid to
    // landlords (the Rift report: what each is held at the month end), and the difference.
    const thisMonth = today.slice(0, 7);
    stats.monthLabel = statements.monthLabel(thisMonth);
    stats.councilInvoiced = reconcile.reconciliation(db, a, thisMonth).totals.owed;
    const rift = require('../monthend').cfpReport(db, a, thisMonth);
    stats.paidToLandlords = rift.total;
    stats.landlordsPaid = rift.rows.length;
    stats.statementsReady = !!db.prepare('SELECT 1 FROM monthly_statements WHERE account_id = ? AND month = ? LIMIT 1').get(a, thisMonth);
    stats.grossProfit = stats.councilInvoiced - stats.paidToLandlords;
    // Properties at a glance: any needing maintenance, empty ones ready to rent, reservations, new and
    // handed-back properties this month.
    const openJob = "EXISTS (SELECT 1 FROM maintenance_jobs m WHERE m.property_id = p.id AND m.account_id = p.account_id AND m.status != 'completed')";
    const empty = db.prepare(
      `SELECT p.id, p.address_line1, ${openJob} AS needs_work,
              (SELECT COUNT(*) FROM maintenance_jobs m WHERE m.property_id = p.id AND m.account_id = p.account_id AND m.status != 'completed') AS jobs
         FROM properties p WHERE p.account_id = ? AND p.status = 'vacant' ORDER BY p.address_line1 COLLATE NOCASE`
    ).all(a);
    const needsWork = db.prepare(
      `SELECT p.id, p.address_line1,
              (SELECT COUNT(*) FROM maintenance_jobs m WHERE m.property_id = p.id AND m.account_id = p.account_id AND m.status != 'completed') AS jobs
         FROM properties p WHERE p.account_id = ? AND p.status != 'handed back' AND ${openJob} ORDER BY p.address_line1 COLLATE NOCASE`
    ).all(a);
    const monthFrom = `${thisMonth}-01`;
    const monthTo = `${thisMonth}-31`;
    const propertyBox = {
      empty,
      needsWork,
      ready: empty.filter((p) => !p.needs_work),
      booked: db.prepare(
        `SELECT ty.id, p.id AS property_id, p.address_line1, t.name AS tenant, COALESCE(ty.booking_date, ty.start_date) AS date
           FROM tenancies ty JOIN properties p ON p.id = ty.property_id JOIN tenants t ON t.id = ty.tenant_id
          WHERE ty.account_id = ? AND COALESCE(ty.booking_date, ty.start_date) BETWEEN ? AND ? ORDER BY date`
      ).all(a, monthFrom, monthTo),
      acquired: db.prepare('SELECT id, address_line1, acquired_date AS date FROM properties WHERE account_id = ? AND acquired_date BETWEEN ? AND ? ORDER BY acquired_date').all(a, monthFrom, monthTo),
      handedBack: db.prepare('SELECT id, address_line1, handed_back_date AS date FROM properties WHERE account_id = ? AND handed_back_date BETWEEN ? AND ? ORDER BY handed_back_date').all(a, monthFrom, monthTo),
    };
    const compliance = db.prepare(
      `SELECT c.id, c.item_type, c.expiry_date, p.address_line1, p.id AS property_id
         FROM compliance_items c JOIN properties p ON p.id = c.property_id
        WHERE c.account_id = ? AND c.expiry_date <= ?
          AND NOT EXISTS (SELECT 1 FROM compliance_items c2 WHERE c2.property_id = c.property_id
                          AND c2.item_type = c.item_type AND c2.expiry_date > c.expiry_date)
        ORDER BY c.expiry_date LIMIT 20`
    ).all(a, soon);
    // Notifications: certificates expired or expiring within two months, soonest first. Those
    // expired or due within a month are highlighted as urgent.
    const monthAhead = fmt.addDays(today, 30);
    const certName = { 'Gas Safety (CP12)': 'Gas certificate', EICR: 'Electrical certificate (EICR)' };
    const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
    const notifications = compliance.map((c) => {
      const days = daysBetween(today, c.expiry_date);
      return {
        ...c, name: certName[c.item_type] || c.item_type, expired: days < 0, urgent: c.expiry_date <= monthAhead,
        when: days < 0 ? `expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`,
      };
    });
    res.render('dashboard', { propertyBox,
      title: 'Dashboard', section: 'dashboard', stats, notifications,
      today, month: today.slice(0, 7), fmt, flash: req.query.flash || '',
    });
  });

  router.post('/rent/raise', (req, res) => {
    const month = String(req.body.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.redirect('/app?flash=' + encodeURIComponent('Choose a valid month.'));
    const n = transaction(db, () => ledger.raiseMonthlyRent(db, req.user.id, month));
    const msg = encodeURIComponent(`Raised ${n} rent charge${n === 1 ? '' : 's'} for ${month}.`);
    res.redirect('/app?flash=' + msg);
  });

  // ---------- council reconciliation: what each council owes for the month and what came in ----------

  const shiftMonth = (month, by) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
  };

  router.get('/council-reconciliation', (req, res) => {
    const a = req.user.id;
    const month = statements.isMonth(req.query.month) ? String(req.query.month) : fmt.today().slice(0, 7);
    const rec = reconcile.reconciliation(db, a, month);
    const councilId = Number(req.query.council_id);
    const open = Number.isInteger(councilId) ? rec.rows.find((c) => c.id === councilId) : null;
    res.render('councilrec', {
      title: 'Council reconciliation', section: 'councilrec', month, monthLabel: statements.monthLabel(month),
      prev: shiftMonth(month, -1), next: shiftMonth(month, 1), thisMonth: fmt.today().slice(0, 7), rec, open,
      detail: open ? reconcile.councilTenancies(db, a, month, open.id) : null, rowStatus: reconcile.rowStatus, fmt,
      owedAll: reconcile.owedAllMonths(db, a, fmt.today().slice(0, 7) > month ? fmt.today().slice(0, 7) : month),
      year: reconcile.yearTotals(db, a, month, fmt.today().slice(0, 7)),
    });
  });

  // The month's reconciliation as an Excel workbook, and as a page to print.
  router.get('/council-reconciliation.xlsx', async (req, res, next) => {
    try {
      const a = req.user.id;
      const month = statements.isMonth(req.query.month) ? String(req.query.month) : fmt.today().slice(0, 7);
      const rec = reconcile.reconciliation(db, a, month);
      const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(a).agency_name;
      const xlsx = await require('../reconcileWorkbook').reconciliationWorkbook({ agencyName: agency, monthLabel: statements.monthLabel(month), rows: rec.rows });
      const name = `${agency} Payment Reconciliation ${statements.monthLabel(month)}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(xlsx);
    } catch (err) { next(err); }
  });

  router.get('/council-reconciliation/print', (req, res) => {
    const a = req.user.id;
    const month = statements.isMonth(req.query.month) ? String(req.query.month) : fmt.today().slice(0, 7);
    const rec = reconcile.reconciliation(db, a, month);
    const agency = db.prepare('SELECT agency_name FROM users WHERE id = ?').get(a).agency_name;
    res.render('councilrec-print', {
      title: `Reconciliation ${statements.monthLabel(month)}`, month, monthLabel: statements.monthLabel(month), rec, agency,
      headings: require('../reconcileWorkbook').headings(agency), fmt,
    });
  });

  // Notes for one council's month (saved automatically as they're typed).
  router.post('/council-reconciliation/notes', (req, res) => {
    const a = req.user.id;
    const month = String(req.body.month || '');
    const council = db.prepare('SELECT id FROM councils WHERE id = ? AND account_id = ?').get(Number(req.body.council_id), a);
    const autosave = req.get('X-Autosave') === '1';
    if (!council || !statements.isMonth(month)) {
      return autosave ? res.status(422).json({ ok: false, errors: { notes: 'Could not save these notes.' } })
        : res.status(404).render('error', { title: 'Not found', message: 'That council was not found.' });
    }
    const notes = String(req.body.notes || '').trim().slice(0, 5000);
    // Money owed / money in typed on the page: blank means "use the calculated figure".
    const errors = {};
    const amount = (field, label) => {
      const raw = String(req.body[field] ?? '').trim();
      if (!raw) return null;
      const p = fmt.parseMoney(raw);
      if (Number.isNaN(p)) { errors[field] = `Enter ${label} like 950 or 950.00, or leave it blank.`; return null; }
      return p;
    };
    const owed = amount('owed', 'money owed');
    const received = amount('received', 'money in');
    const date = (field, label) => {
      const raw = String(req.body[field] ?? '').trim();
      if (!raw) return null;
      if (!fmt.isIsoDate(raw)) { errors[field] = `Enter the ${label}, or leave it blank.`; return null; }
      return raw;
    };
    const receivedDate = date('received_date', 'date received');
    const emailSentDate = date('email_sent_date', 'date the email was sent');
    if (Object.keys(errors).length) {
      return autosave ? res.status(422).json({ ok: false, errors }) : res.redirect(`/app/council-reconciliation?month=${month}`);
    }
    if (notes || owed !== null || received !== null || receivedDate || emailSentDate) {
      db.prepare(
        `INSERT INTO council_rec_notes (account_id, council_id, month, notes, owed_pence, received_pence, received_date, email_sent_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, council_id, month) DO UPDATE SET notes = excluded.notes, owed_pence = excluded.owed_pence,
           received_pence = excluded.received_pence, received_date = excluded.received_date,
           email_sent_date = excluded.email_sent_date, updated_at = datetime('now')`
      ).run(a, council.id, month, notes, owed, received, receivedDate, emailSentDate);
    } else {
      db.prepare('DELETE FROM council_rec_notes WHERE account_id = ? AND council_id = ? AND month = ?').run(a, council.id, month);
    }
    if (autosave) {
      // Send back the row's new figures and the totals so the page updates without reloading.
      const rec = reconcile.reconciliation(db, a, month);
      const c = rec.rows.find((r) => r.id === council.id);
      const st = reconcile.rowStatus(c);
      const bal = (b) => (b > 0 ? fmt.money(b) : b < 0 ? `${fmt.money(-b)} over` : '—');
      const t = rec.totals;
      const yr = reconcile.yearTotals(db, a, month, fmt.today().slice(0, 7));
      const all = reconcile.owedAllMonths(db, a, fmt.today().slice(0, 7) > month ? fmt.today().slice(0, 7) : month).balance;
      return res.json({
        ok: true,
        updates: [
          { id: `rec-balance-${c.id}`, text: bal(c.balance), className: c.balance > 0 ? 'bad-text strong' : c.balance < 0 ? 'ok-text' : '' },
          { id: `rec-status-${c.id}`, text: st.text, className: st.cls },
          { id: 'rec-total-owed', text: fmt.money(t.owed) },
          { id: 'rec-total-received', text: fmt.money(t.received) },
          { id: 'rec-total-balance', text: bal(t.balance) },
          { id: 'rec-owed-month', text: bal(t.balance), className: `value${t.balance > 0 ? ' bad-text' : ''}` },
          { id: 'rec-owed-all', text: bal(all), className: `value${all > 0 ? ' bad-text' : ''}` },
          { id: 'rec-year-invoiced', text: fmt.money(yr.invoiced) },
          { id: 'rec-year-received', text: fmt.money(yr.received) },
        ],
      });
    }
    res.redirect(`/app/council-reconciliation?month=${month}`);
  });


  // ---------- my account: read-only; only the admin edits account details ----------

  // The dashboard's dark mode switch: saved to the person signed in.
  router.post('/theme', (req, res) => {
    const theme = ['light', 'dark'].includes(req.body.theme) ? req.body.theme : null;
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.person_id);
    res.json({ ok: true, theme });
  });

  router.get('/account', (req, res) => {
    const acct = db.prepare(
      `SELECT m.id, c.id AS company_id, c.username, m.login_name, m.name, c.agency_name, COALESCE(m.email, c.email) AS email,
              COALESCE(m.phone, c.phone) AS phone, c.address, m.is_admin, m.created_at
         FROM users m JOIN users c ON c.id = COALESCE(m.company_id, m.id) WHERE m.id = ?`
    ).get(req.user.person_id);
    res.render('account', { title: 'My account', section: 'account', acct });
  });

  // ---------- add a tenant to a property (tenant + tenancy in one step) ----------

  const TENANT_FIELDS = ENTITIES.tenants.fields.filter((f) => f.name !== 'notes');
  const LET_FIELDS = ENTITIES.tenancies.fields.filter((f) => !['property_id', 'tenant_id'].includes(f.name));

  function ownedProperty(req, res) {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) && db.prepare('SELECT * FROM properties WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!p) res.status(404).render('error', { title: 'Not found', message: "That property doesn't exist." });
    return p || null;
  }

  function renderAddTenant(res, req, property, values, errors, status = 200) {
    res.status(status).render('add-tenant', {
      title: `Add tenant to ${property.address_line1}`, section: 'properties', property, values, errors,
      tenants: refOptions('tenants', req.user.id), tenantFields: TENANT_FIELDS, letFields: LET_FIELDS, fmt,
    });
  }

  // End a tenancy: set its end date (today unless another is given) and mark it ended.
  router.post('/tenancies/:id/end', (req, res) => {
    const a = req.user.id;
    const t = db.prepare('SELECT * FROM tenancies WHERE id = ? AND account_id = ?').get(Number(req.params.id), a);
    if (!t) return res.status(404).render('error', { title: 'Not found', message: 'That tenancy was not found.' });
    const back = (key, msg) => res.redirect(`/app/properties/${t.property_id}?${key}=${encodeURIComponent(msg)}`);
    const end = String(req.body.end_date || '').trim() || fmt.today();
    if (!fmt.isIsoDate(end)) return back('error', 'Enter a valid end date.');
    if (t.start_date && end < t.start_date) return back('error', `The end date can’t be before the start date (${fmt.ukDate(t.start_date)}).`);
    if (t.booking_date && end < t.booking_date) return back('error', `The end date can’t be before the reservation date (${fmt.ukDate(t.booking_date)}).`);
    db.prepare("UPDATE tenancies SET end_date = ?, status = 'ended' WHERE id = ? AND account_id = ?").run(end, t.id, a);
    back('flash', `Tenancy ended on ${fmt.ukDate(end)}.`);
  });

  router.get('/properties/:id/add-tenant', (req, res) => {
    const property = ownedProperty(req, res);
    if (!property) return;
    const values = { tenant_mode: 'new', ...formDefaults(ENTITIES.tenancies, {}) };
    renderAddTenant(res, req, property, values, {});
  });

  router.post('/properties/:id/add-tenant', (req, res) => {
    const property = ownedProperty(req, res);
    if (!property) return;
    const a = req.user.id;
    const mode = req.body.tenant_mode === 'existing' ? 'existing' : 'new';
    const body = { ...req.body, property_id: String(property.id) };
    const tenantParsed = mode === 'new' ? parseForm(ENTITIES.tenants, req.body, a) : { values: {}, errors: {} };
    if (mode === 'new') body.tenant_id = ''; // filled after the tenant is created
    const letParsed = parseForm(ENTITIES.tenancies, body, a);
    if (mode === 'new') delete letParsed.errors.tenant_id;
    const errors = { ...tenantParsed.errors, ...letParsed.errors };
    if (Object.keys(errors).length) {
      return renderAddTenant(res, req, property, { ...req.body, tenant_mode: mode }, errors, 422);
    }
    const tenancyId = transaction(db, () => {
      const tv = letParsed.values;
      if (mode === 'new') {
        const t = tenantParsed.values;
        const info = db.prepare('INSERT INTO tenants (account_id, name, email, phone, council_ref, notes) VALUES (?, ?, ?, ?, ?, ?)')
          .run(a, t.name, t.email, t.phone, t.council_ref ?? null, t.notes);
        tv.tenant_id = Number(info.lastInsertRowid);
      }
      if (!('rent_pence' in tv)) tv.rent_pence = 0; // rent isn't entered any more
      const cols = Object.keys(tv);
      const info = db.prepare(`INSERT INTO tenancies (account_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(a, ...cols.map((c) => tv[c]));
      const id = Number(info.lastInsertRowid);
      afterSave(ENTITIES.tenancies, a, id, tv);
      return id;
    });
    res.redirect(`/app/tenancies/${tenancyId}`);
  });

  // ---------- generic CRUD ----------

  router.get('/:entity', (req, res) => {
    // Tenants and tenancies are one tab now.
    if (req.params.entity === 'tenancies') return res.redirect('/app/tenants');
    const def = getEntity(req, res);
    if (!def) return;
    const a = req.user.id;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const textFields = def.fields.filter((f) => ['text', 'email', 'tel', 'textarea'].includes(f.type)).map((f) => f.name);
    let where = 'account_id = ?';
    const params = [a];
    if (q && textFields.length) {
      const like = `%${q}%`;
      const terms = textFields.map((f) => { params.push(like); return `${f} LIKE ?`; });
      // Also match the names of linked records, e.g. a property's landlord or council.
      for (const f of def.fields) {
        const ref = f.type === 'ref' && ENTITIES[f.ref];
        if (!ref || !ref.titleField) continue;
        terms.push(`${f.name} IN (SELECT id FROM ${ref.table} WHERE account_id = ? AND ${ref.titleField} LIKE ?)`);
        params.push(a, like);
      }
      where += ` AND (${terms.join(' OR ')})`;
    }
    // Maintenance is shown one month at a time (by reported date), like the invoice tabs.
    let monthView = null;
    if (def.key === 'maintenance') {
      const thisMonth = fmt.today().slice(0, 7);
      const month = req.query.month === 'all' ? 'all' : /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : thisMonth;
      const jobMonth = "substr(COALESCE(reported_date, created_at), 1, 7)";
      if (month !== 'all') { where += ` AND ${jobMonth} = ?`; params.push(month); }
      const shift = (by) => { const [y, m] = (month === 'all' ? thisMonth : month).split('-').map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };
      const inMonth = month === 'all' ? null : db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(status != 'completed'), 0) AS open, COALESCE(SUM(status = 'completed'), 0) AS done,
                COALESCE(SUM(cost_pence), 0) AS cost
           FROM maintenance_jobs WHERE account_id = ? AND ${jobMonth} = ?`
      ).get(a, month);
      const olderOpen = month === 'all' ? 0 : db.prepare(
        `SELECT COUNT(*) AS n FROM maintenance_jobs WHERE account_id = ? AND status != 'completed' AND ${jobMonth} < ?`
      ).get(a, month).n;
      monthView = { month, thisMonth, prev: shift(-1), next: shift(1), inMonth, olderOpen,
        monthLabel: month === 'all' ? 'All months' : require('../statements').monthLabel(month) };
    }
    let rows = db.prepare(`SELECT * FROM ${def.table} WHERE ${where} ORDER BY ${def.order} LIMIT ${LIST_LIMIT + 1}`).all(...params);
    const truncated = rows.length > LIST_LIMIT;
    if (truncated) rows.pop();
    let totalsRow = null;
    const maps = refLabelMaps(def, a);
    let tenantFilter = null;
    if (def.key === 'properties') {
      // Who lives there now: tenants on an active (or upcoming) tenancy, one per line.
      const byProperty = new Map();
      for (const t of db.prepare(
        `SELECT ty.property_id, t.id, t.name FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id
          WHERE ty.account_id = ? AND ty.status IN ('active', 'pending')
          ORDER BY ty.status = 'active' DESC, t.name COLLATE NOCASE`
      ).all(a)) {
        if (!byProperty.has(t.property_id)) byProperty.set(t.property_id, []);
        byProperty.get(t.property_id).push(t);
      }
      for (const row of rows) {
        const list = byProperty.get(row.id) || [];
        row.cur_tenant = list.length === 1 ? { text: list[0].name, href: `/app/tenants/${list[0].id}` }
          : { text: list.length ? list.map((t) => t.name).join('\n') : '—' };
      }
    }
    if (def.key === 'tenants') {
      // Each tenant with their current tenancy (or their latest one if none is current).
      const latest = new Map();
      const lastEnded = new Map(); // each tenant's most recent ended tenancy
      const allOf = new Map(); // every tenancy of each tenant
      for (const t of db.prepare(
        `SELECT ty.id, ty.tenant_id, ty.status, ty.start_date, ty.end_date, ty.rent_pence, ty.rent_frequency,
                p.id AS property_id, p.address_line1, c.id AS council_id, c.name AS council_name
           FROM tenancies ty JOIN properties p ON p.id = ty.property_id LEFT JOIN councils c ON c.id = p.council_id
          WHERE ty.account_id = ?
          ORDER BY ty.status = 'active' DESC, ty.status = 'pending' DESC, ty.start_date DESC`
      ).all(a)) {
        if (!latest.has(t.tenant_id)) latest.set(t.tenant_id, t);
        if (!allOf.has(t.tenant_id)) allOf.set(t.tenant_id, []);
        allOf.get(t.tenant_id).push(t);
        if (t.status === 'ended' && (!lastEnded.has(t.tenant_id) || t.start_date > lastEnded.get(t.tenant_id).start_date)) lastEnded.set(t.tenant_id, t);
      }
      tenantFilter = ['current', 'past', 'all'].includes(req.query.show) ? req.query.show : 'current';
      // All: one line per tenancy, ended ones included (tenants with none get one line).
      if (tenantFilter === 'all') rows = rows.flatMap((r) => (allOf.get(r.id) || [null]).map((t) => ({ ...r, one_tenancy: t })));
      for (const row of rows) {
        // On Past tenants, show the tenancy that ended.
        const t = tenantFilter === 'all' ? row.one_tenancy : tenantFilter === 'past' && lastEnded.has(row.id) ? lastEnded.get(row.id) : latest.get(row.id);
        row.tenancy_status = t ? t.status : null;
        row.cur_property = t ? { text: t.address_line1, href: `/app/properties/${t.property_id}` } : { text: '' };
        row.cur_council = t && t.council_id ? { text: t.council_name, href: `/app/councils/${t.council_id}` } : { text: '' };
        row.cur_term = t ? { text: `${fmt.ukDate(t.start_date)} – ${t.end_date ? fmt.ukDate(t.end_date) : 'ongoing'}`, href: `/app/tenancies/${t.id}` } : { text: 'No tenancy yet' };
        row.cur_status = t ? { text: fmt.humanize(t.status), cls: `badge s-${t.status}` } : { text: '' };
      }
      if (tenantFilter === 'current') rows = rows.filter((r) => r.tenancy_status !== 'ended');
      // Past tenants: anyone with an ended tenancy (even if they now rent somewhere else too).
      if (tenantFilter === 'past') rows = rows.filter((r) => lastEnded.has(r.id));
    }
    if (def.key === 'contractors') {
      // Invoices and money paid to each contractor, all time.
      const stats = new Map(db.prepare(
        `SELECT contractor_id, COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_pence END), 0) AS paid,
                COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_pence END), 0) AS unpaid
           FROM invoices WHERE account_id = ? AND contractor_id IS NOT NULL GROUP BY contractor_id`
      ).all(a).map((s) => [s.contractor_id, s]));
      for (const row of rows) {
        const s = stats.get(row.id) || { n: 0, paid: 0, unpaid: 0 };
        row.invoice_count = { text: String(s.n) };
        row.total_paid = { text: fmt.money(s.paid) };
        row.unpaid = { text: s.unpaid ? fmt.money(s.unpaid) : '—' };
      }
      totalsRow = { label: 'Total', cells: {
        invoice_count: String([...stats.values()].reduce((t, s) => t + s.n, 0)),
        total_paid: fmt.money([...stats.values()].reduce((t, s) => t + s.paid, 0)),
        unpaid: fmt.money([...stats.values()].reduce((t, s) => t + s.unpaid, 0)),
      } };
    }
    if (def.key === 'councils') {
      // How many properties are in each council, and which ones.
      const byCouncil = new Map();
      for (const p of db.prepare("SELECT council_id, address_line1 FROM properties WHERE account_id = ? AND council_id IS NOT NULL ORDER BY address_line1 COLLATE NOCASE").all(a)) {
        if (!byCouncil.has(p.council_id)) byCouncil.set(p.council_id, []);
        byCouncil.get(p.council_id).push(p.address_line1);
      }
      const photos = new Map(db.prepare("SELECT council_id, strftime('%s', updated_at) AS v FROM council_photos WHERE account_id = ?").all(a).map((p) => [p.council_id, p.v]));
      for (const row of rows) {
        if (photos.has(row.id)) row.photo_v = photos.get(row.id);
        const list = byCouncil.get(row.id) || [];
        row.properties = { text: String(list.length), count: list.length };
        row.database = { text: 'Database', href: `/app/councils/${row.id}/database`, cls: 'btn small' };
      }
    }
    res.render('list', { title: def.plural, section: sectionOf(def), def, rows, maps, display, rowTitle, q, searchable: textFields.length > 0, truncated, totalsRow, tenantFilter, monthView });
  });

  router.get('/:entity/new', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const values = formDefaults(def, req.query);
    if (def.key === 'landlords' && !values.code) values.code = nextLandlordCode(req.user.id);
    for (const f of def.fields) if (f.type === 'person' && !values[f.name]) values[f.name] = req.user.person_id || req.user.id;
    renderForm(res, def, { row: null, values, errors: {}, accountId: req.user.id });
  });

  // The next landlord code: one more than the highest so far, keeping its letters and zero
  // padding (L101 → L102, LL009 → LL010); L0001 for the first.
  function nextLandlordCode(accountId) {
    let best = null;
    for (const { code } of db.prepare("SELECT code FROM landlords WHERE account_id = ? AND code IS NOT NULL AND code != ''").all(accountId)) {
      const m = /^(.*?)(\d+)$/.exec(String(code).trim());
      if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1], n: Number(m[2]), width: m[2].length };
    }
    if (!best) return 'L0001';
    let next = `${best.prefix}${String(best.n + 1).padStart(best.width, '0')}`;
    // Never hand out a code that's already in use.
    while (db.prepare('SELECT 1 FROM landlords WHERE account_id = ? AND code = ?').get(accountId, next)) {
      best.n += 1;
      next = `${best.prefix}${String(best.n + 1).padStart(best.width, '0')}`;
    }
    return next;
  }

  router.post('/:entity', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const a = req.user.id;
    // A landlord left without a code gets the next one.
    if (def.key === 'landlords' && !String(req.body.code || '').trim()) req.body.code = nextLandlordCode(a);
    // Certificates typed in while adding a property (any left blank are skipped).
    const newCerts = [];
    if (def.key === 'properties') {
      NEW_PROPERTY_CERTS.forEach((type, i) => {
        const issued = String(req.body[`cert_${i}_issued`] || '').trim();
        const expiry = String(req.body[`cert_${i}_expiry`] || '').trim();
        const file = req.certFile ? req.certFile(i) : null;
        if (!issued && !expiry && !file) return;
        newCerts.push({ type, issued, expiry, i, file });
      });
    }
    // "Added by" left out: the person signed in.
    for (const f of def.fields) if (f.type === 'person' && !String(req.body[f.name] || '').trim()) req.body[f.name] = String(req.user.person_id || a);
    const { values, errors } = parseForm(def, req.body, a);
    for (const cert of newCerts) {
      if (!fmt.isIsoDate(cert.expiry)) errors[`cert_${cert.i}_expiry`] = `Enter when the ${cert.type} expires.`;
      if (cert.issued && !fmt.isIsoDate(cert.issued)) errors[`cert_${cert.i}_issued`] = 'Enter a valid date.';
    }
    if (req.uploadError && def.key === 'properties') errors.cert_upload = req.uploadError;
    // Files can't be kept when the form comes back with a mistake, so ask for them again.
    if (Object.keys(errors).length && newCerts.some((x) => x.file)) errors.cert_upload = errors.cert_upload || 'Please choose the certificate files again.';
    if (Object.keys(errors).length) return renderForm(res, def, { row: null, values: { ...values, ...certValues(req.body) }, errors, accountId: a, status: 422 });
    prepareValues(def, a, values);
    // A new property counts as acquired today unless another date is given.
    if (def.key === 'properties' && !values.acquired_date) values.acquired_date = fmt.today();
    if (def.key === 'tenancies' && !('rent_pence' in values)) values.rent_pence = 0; // rent isn't entered any more
    const cols = Object.keys(values);
    const refusedCerts = [];
    const id = transaction(db, () => {
      const info = db.prepare(`INSERT INTO ${def.table} (account_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(a, ...cols.map((c) => values[c]));
      const newId = Number(info.lastInsertRowid);
      afterSave(def, a, newId, values);
      for (const cert of newCerts) {
        const item = db.prepare('INSERT INTO compliance_items (account_id, property_id, item_type, issued_date, expiry_date) VALUES (?, ?, ?, ?, ?)')
          .run(a, newId, cert.type, cert.issued || null, cert.expiry);
        if (cert.file) {
          const saved = req.saveCertFile(Number(item.lastInsertRowid), cert.file);
          if (!saved.ok) refusedCerts.push(saved.name);
        }
      }
      return newId;
    });
    if (refusedCerts.length) {
      return res.redirect(`/app/properties/${id}?error=${encodeURIComponent(`Property added, but these certificate files weren’t uploaded (use PDFs or photos): ${refusedCerts.join(', ')}.`)}#certificates`);
    }
    // Files chosen while adding a maintenance job.
    if (def.key === 'maintenance' && req.saveJobFiles) {
      const { saved, refused } = req.saveJobFiles(id);
      if (saved || refused.length || req.uploadError) {
        const msg = req.uploadError || (refused.length ? `Not uploaded (use photos, PDFs, iPhone HEIC files, or Word, Excel or PowerPoint files): ${refused.join(', ')}.` : `Added with ${saved} file${saved === 1 ? '' : 's'}.`);
        return res.redirect(`/app/maintenance/${id}?${req.uploadError || refused.length ? 'error' : 'flash'}=${encodeURIComponent(msg)}#files`);
      }
    }
    // A new certificate goes back to its property's certificate panel.
    if (def.key === 'compliance') return res.redirect(`/app/properties/${values.property_id}#certificates`);
    res.redirect(`/app/${def.key}/${id}`);
  });

  router.get('/:entity/:id', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    const a = req.user.id;
    const maps = refLabelMaps(def, a);
    const children = (def.children || []).map((c) => {
      const cdef = ENTITIES[c.entity];
      const crows = db.prepare(`SELECT * FROM ${cdef.table} WHERE account_id = ? AND ${c.fk} = ? ORDER BY ${cdef.order} LIMIT 100`).all(a, row.id);
      return { def: cdef, fk: c.fk, rows: crows, maps: refLabelMaps(cdef, a), title: null };
    });
    const certs = def.key === 'properties' ? keyCertificates(a, row.id) : null;
    let extra = null;
    if (def.key === 'tenancies') {
      const r = db.prepare(
        `SELECT COALESCE(SUM(CASE txn_type WHEN 'rent_charge' THEN amount_pence WHEN 'rent_received' THEN -amount_pence ELSE 0 END), 0) AS owed
           FROM transactions WHERE account_id = ? AND tenancy_id = ?`
      ).get(a, row.id);
      extra = { label: r.owed > 0 ? 'Arrears' : 'Balance', value: r.owed > 0 ? fmt.money(r.owed) : `${fmt.money(-r.owed)} in credit`, alert: r.owed > 0 };
    }
    if (def.key === 'landlords') {
      const r = db.prepare(`SELECT COALESCE(${ledger.landlordBalanceSql('tx')}, 0) AS bal FROM transactions tx WHERE account_id = ? AND landlord_id = ?`).get(a, row.id);
      extra = { label: 'Held for landlord', value: fmt.money(r.bal), alert: r.bal < 0 };
    }
    let invoices = null;
    if (def.key === 'maintenance' || def.key === 'properties' || def.key === 'contractors') {
      const fk = { maintenance: 'maintenance_job_id', properties: 'property_id', contractors: 'contractor_id' }[def.key];
      invoices = db.prepare(`${INVOICE_LIST_SQL} WHERE i.account_id = ? AND i.${fk} = ? ORDER BY COALESCE(i.invoice_date, i.created_at) DESC, i.id DESC`).all(a, row.id);
    }
    // A contractor's page: small boxes with what's been paid to them (a chosen month, and all time).
    let contractorStats = null;
    if (def.key === 'contractors') {
      const thisMonth = fmt.today().slice(0, 7);
      const month = statements.isMonth(req.query.month) ? String(req.query.month) : thisMonth;
      const sum = (rows, test) => rows.filter(test).reduce((t, i) => t + i.amount_pence, 0);
      const paid = invoices.filter((i) => i.status === 'paid');
      const inMonth = paid.filter((i) => String(i.paid_date || '').slice(0, 7) === month);
      const months = [...new Set([thisMonth, ...invoices.map((i) => String(i.paid_date || i.invoice_date || '').slice(0, 7)).filter(statements.isMonth)])].sort().reverse();
      contractorStats = {
        month, months: months.map((m) => ({ value: m, label: statements.monthLabel(m) })), monthLabel: statements.monthLabel(month),
        paidMonth: sum(inMonth, () => true), paidMonthN: inMonth.length,
        paidAll: sum(paid, () => true), paidAllN: paid.length,
        unpaid: sum(invoices, (i) => i.status === 'unpaid'), unpaidN: invoices.filter((i) => i.status === 'unpaid').length,
        invoicesN: invoices.length, last: paid.map((i) => i.paid_date).filter(Boolean).sort().pop() || null,
      };
    }
    // On a certificate: its scans and PDFs.
    const certFiles = def.key === 'compliance'
      ? db.prepare(`SELECT f.id, f.filename, f.mime, f.size, f.uploaded_at, u.name AS uploaded_by_name
                      FROM compliance_files f LEFT JOIN users u ON u.id = f.uploaded_by
                     WHERE f.account_id = ? AND f.item_id = ? ORDER BY f.id DESC`).all(a, row.id)
      : null;
    // On a maintenance job: its photos and files (without the file contents).
    const jobFiles = def.key === 'maintenance'
      ? db.prepare(`SELECT f.id, f.filename, f.mime, f.size, f.uploaded_at, u.name AS uploaded_by_name
                      FROM maintenance_files f LEFT JOIN users u ON u.id = f.uploaded_by
                     WHERE f.account_id = ? AND f.job_id = ? ORDER BY f.id DESC`).all(a, row.id)
      : null;
    // On a maintenance job: the landlord's invoice, once the job is completed.
    const jobInvoice = def.key === 'maintenance' ? db.prepare(
      `SELECT j.status, j.cost_pence, j.invoice_date, j.invoice_emailed_at, j.invoice_emailed_to, l.id AS landlord_id, l.name AS landlord_name, l.email AS landlord_email
         FROM maintenance_jobs j JOIN properties p ON p.id = j.property_id LEFT JOIN landlords l ON l.id = p.landlord_id AND l.account_id = j.account_id
        WHERE j.id = ? AND j.account_id = ?`
    ).get(row.id, a) : null;
    // On a tenant's page: their current tenancy (or tenancies), with its council, property and agreement.
    let tenantBoxes = null;
    if (def.key === 'tenants' || def.key === 'tenancies') {
      const all = db.prepare(
        `SELECT ty.*, p.address_line1, p.town, p.postcode, p.property_type, p.bedrooms, p.council_tax_account, p.council_tax_payer,
                l.id AS landlord_id, l.name AS landlord_name, c.id AS council_id, c.name AS council_name, c.council_tax_phone, c.council_tax_email,
                (SELECT strftime('%s', updated_at) FROM council_photos cp WHERE cp.council_id = c.id) AS council_photo_v,
                ag.filename AS agreement_name, ag.size AS agreement_size, ag.uploaded_at AS agreement_uploaded
           FROM tenancies ty JOIN properties p ON p.id = ty.property_id
           LEFT JOIN landlords l ON l.id = p.landlord_id
           LEFT JOIN councils c ON c.id = p.council_id
           LEFT JOIN tenancy_agreements ag ON ag.tenancy_id = ty.id
          WHERE ty.account_id = ? AND ${def.key === 'tenants' ? 'ty.tenant_id' : 'ty.id'} = ?
          ORDER BY ty.status = 'active' DESC, ty.start_date DESC`
      ).all(a, row.id);
      const active = all.filter((t) => t.status === 'active');
      tenantBoxes = active.length ? active : all.slice(0, 1);
    }
    const photo = def.key === 'councils'
      ? db.prepare("SELECT strftime('%s', updated_at) AS v FROM council_photos WHERE council_id = ? AND account_id = ?").get(row.id, a) || { v: null }
      : null;
    const bankChanges = def.key === 'landlords' ? require('../bankChanges').unchecked(db, a, row.id) : [];
    // A council's page also shows its database and its invoices.
    // A property's page has notes of tenants' calls, newest first.
    const callNotes = def.key === 'properties' ? {
      notes: db.prepare(
        `SELECT n.id, n.note_date, n.body, n.created_at, u.name AS added_by_name FROM property_notes n LEFT JOIN users u ON u.id = n.added_by
          WHERE n.account_id = ? AND n.property_id = ? ORDER BY n.note_date DESC, n.id DESC`
      ).all(a, row.id),
      people: peopleOptions(a), me: req.user.person_id || a,
    } : null;
    // A landlord's page lists their statements, newest first.
    const landlordStatements = def.key === 'landlords' ? db.prepare(
      `SELECT id, month, rent_pence, fees_pence, expenses_pence, closing_pence, emailed_at FROM monthly_statements
        WHERE account_id = ? AND landlord_id = ? ORDER BY month DESC`
    ).all(a, row.id).map((s) => ({ ...s, monthLabel: statements.monthLabel(s.month) })) : null;
    const councilBoxes = def.key === 'councils' ? {
      live: db.prepare('SELECT * FROM council_db_entries WHERE account_id = ? AND council_id = ? AND ended = 0 ORDER BY id').all(a, row.id),
      previous: db.prepare('SELECT COUNT(*) AS n FROM council_db_entries WHERE account_id = ? AND council_id = ? AND ended = 1').get(a, row.id).n,
      invoices: [],
    } : null;
    res.render('show', { title: rowTitle(def, row, maps), section: sectionOf(def), def, row, maps, display, rowTitle, children, extra, invoices, related: relatedLists(def, row, a), certs, photo, tenantBoxes, statementLink, jobFiles, jobInvoice, contractorStats, bankChanges, councilBoxes, landlordStatements, callNotes, certFiles, error: req.query.error ? String(req.query.error).slice(0, 200) : null, flash: req.query.flash ? String(req.query.flash).slice(0, 200) : null, fmt, today: fmt.today() });
  });

  router.get('/:entity/:id/edit', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    renderForm(res, def, { row, values: row, errors: {}, accountId: req.user.id });
  });

  // ---------- notes of tenants' calls about a property ----------
  function noteProperty(req, res) {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) && db.prepare('SELECT id FROM properties WHERE id = ? AND account_id = ?').get(id, req.user.id);
    if (!p) res.status(404).render('error', { title: 'Not found', message: 'That property was not found.' });
    return p;
  }
  router.post('/properties/:id(\\d+)/notes', (req, res) => {
    const p = noteProperty(req, res);
    if (!p) return;
    const a = req.user.id;
    const back = (key, msg) => res.redirect(`/app/properties/${p.id}?${key}=${encodeURIComponent(msg)}#call-notes`);
    const date = String(req.body.note_date || '').trim() || fmt.today();
    const body = String(req.body.body || '').trim().slice(0, 5000);
    const who = Number(req.body.added_by) || req.user.person_id || a;
    if (!fmt.isIsoDate(date)) return back('error', 'Enter a valid date for the note.');
    if (!body) return back('error', 'Write the note first.');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND (id = ? OR company_id = ?)').get(who, a, a)) return back('error', 'Choose who added the note.');
    db.prepare('INSERT INTO property_notes (account_id, property_id, note_date, added_by, body) VALUES (?, ?, ?, ?, ?)').run(a, p.id, date, who, body);
    back('flash', 'Note added.');
  });
  router.post('/properties/:id(\\d+)/notes/:nid(\\d+)/delete', (req, res) => {
    const p = noteProperty(req, res);
    if (!p) return;
    db.prepare('DELETE FROM property_notes WHERE id = ? AND property_id = ? AND account_id = ?').run(Number(req.params.nid), p.id, req.user.id);
    res.redirect(`/app/properties/${p.id}?flash=${encodeURIComponent('Note removed.')}#call-notes`);
  });

  router.post('/:entity/:id', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    const a = req.user.id;
    const autosave = req.get('X-Autosave') === '1';
    if (def.key === 'landlords' && !String(req.body.code || '').trim()) req.body.code = row.code || nextLandlordCode(a);
    const { values, errors } = parseForm(def, req.body, a);
    // A tenant's Edit form can change the council of the property they rent.
    let councilChange = null;
    if (def.key === 'tenants' && req.body.tenant_council_id !== undefined) {
      const tp = tenantProperty(a, row.id);
      const raw = String(req.body.tenant_council_id || '');
      const council = raw ? db.prepare('SELECT id FROM councils WHERE id = ? AND account_id = ?').get(Number(raw), a) : null;
      if (raw && !council) errors.tenant_council_id = 'Choose a valid council.';
      else if (tp) councilChange = { property_id: tp.property_id, council_id: council ? council.id : null };
    }
    if (Object.keys(errors).length) {
      if (autosave) return res.status(422).json({ ok: false, errors });
      return renderForm(res, def, { row, values, errors, accountId: a, status: 422 });
    }
    if (councilChange) db.prepare('UPDATE properties SET council_id = ? WHERE id = ? AND account_id = ?').run(councilChange.council_id, councilChange.property_id, a);
    prepareValues(def, a, values);
    const cols = Object.keys(values);
    // A landlord's bank details changing is recorded, and flagged until it's been checked.
    const bankChange = def.key === 'landlords' && bankDetailsChanged(row, values);
    transaction(db, () => {
      // Typing saves as you go, so edits within half an hour by the same person are one change.
      const recent = bankChange && db.prepare(
        `SELECT id FROM landlord_bank_changes WHERE account_id = ? AND landlord_id = ? AND changed_by IS ? AND checked_at IS NULL
           AND changed_at > datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 1`
      ).get(a, row.id, req.user.person_id || a);
      if (recent) {
        db.prepare("UPDATE landlord_bank_changes SET new_name = ?, new_sort_code = ?, new_account = ?, changed_at = datetime('now') WHERE id = ?")
          .run(values.bank_account_name, values.bank_sort_code, values.bank_account_number, recent.id);
      } else if (bankChange) {
        db.prepare(
          `INSERT INTO landlord_bank_changes (account_id, landlord_id, changed_by, old_name, old_sort_code, old_account, new_name, new_sort_code, new_account)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(a, row.id, req.user.person_id || a, row.bank_account_name, row.bank_sort_code, row.bank_account_number,
          values.bank_account_name, values.bank_sort_code, values.bank_account_number);
      }
      db.prepare(`UPDATE ${def.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND account_id = ?`)
        .run(...cols.map((c) => values[c]), row.id, a);
      afterSave(def, a, row.id, values);
    });
    if (autosave) return res.json({ ok: true, savedAt: new Date().toISOString() });
    res.redirect(`/app/${def.key}/${row.id}`);
  });

  router.post('/:entity/:id/delete', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    db.prepare(`DELETE FROM ${def.table} WHERE id = ? AND account_id = ?`).run(row.id, req.user.id);
    res.redirect(`/app/${def.key}`);
  });

  return router;
};
