'use strict';

const express = require('express');
const { ENTITIES, REF_LABELS } = require('../entities');
const { transaction } = require('../db');
const ledger = require('../ledger');
const fmt = require('../format');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_LIMIT = 500;

module.exports = function appRoutes(db) {
  const router = express.Router();

  // ---------- helpers ----------

  function refOptions(refKey, accountId) {
    const r = REF_LABELS[refKey];
    return db.prepare(`SELECT ${r.alias}.id AS id, ${r.label} AS label FROM ${r.from} WHERE ${r.alias}.account_id = ? ORDER BY label COLLATE NOCASE`).all(accountId);
  }

  function refLabelMaps(def, accountId) {
    const maps = {};
    for (const f of def.fields) {
      if (f.type === 'ref' && !maps[f.ref]) {
        maps[f.ref] = new Map(refOptions(f.ref, accountId).map((o) => [o.id, o.label]));
      }
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
      raw = raw === undefined || raw === null ? '' : String(raw).trim();
      if (raw === '') {
        if (f.required) errors[f.name] = `${f.label} is required.`;
        values[f.name] = null;
        continue;
      }
      const max = f.type === 'textarea' ? 10000 : 500;
      if (raw.length > max) { errors[f.name] = `${f.label} is too long.`; continue; }
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
      }
    }
    if (def.key === 'tenancies' && values.start_date && values.end_date && values.end_date < values.start_date) {
      errors.end_date = 'End date must be after the start date.';
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

  function renderForm(res, def, { row, values, errors, accountId, status = 200 }) {
    const options = {};
    for (const f of def.fields) if (f.type === 'ref') options[f.name] = refOptions(f.ref, accountId);
    res.status(status).render('form', { title: row ? `Edit ${def.singular.toLowerCase()}` : `New ${def.singular.toLowerCase()}`, def, row, values, errors, options, fmt, section: def.key });
  }

  // Keep derived data consistent after a record is saved.
  function afterSave(def, accountId, id, values) {
    if (def.key === 'transactions') ledger.bookManagementFee(db, accountId, id);
    if (def.key === 'tenancies' && values.status === 'active') {
      db.prepare("UPDATE properties SET status = 'let' WHERE id = ? AND account_id = ?").run(values.property_id, accountId);
    }
  }

  function prepareValues(def, accountId, values) {
    if (def.key === 'transactions') ledger.resolveLinks(db, accountId, values);
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
      return { ...k, current: current || null, previous, status: current ? certStatus(current.expiry_date, today) : { key: 'missing', label: 'Missing' } };
    });
  }

  // Council links that run through properties: the councils a landlord or tenant is connected to.
  function relatedLists(def, row, a) {
    const link = (entity, id, text) => ({ text, href: `/app/${entity}/${id}` });
    // A council's page lists just its properties (as a child list), nothing else.
    if (def.key === 'councils') return [];
    const councilsVia = (sql, ...params) => db.prepare(sql).all(...params);
    if (def.key === 'landlords') {
      const rows = councilsVia(
        `SELECT c.id, c.name, COUNT(p.id) AS n FROM properties p JOIN councils c ON c.id = p.council_id
          WHERE p.account_id = ? AND p.landlord_id = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`, a, row.id);
      return [{ title: 'Councils', empty: 'None of this landlord\'s properties has a council set yet.', headers: ['Council', 'Properties'],
        rows: rows.map((c) => [link('councils', c.id, c.name), { text: String(c.n), num: true }]) }];
    }
    if (def.key === 'tenants') {
      const rows = councilsVia(
        `SELECT DISTINCT c.id, c.name, c.council_tax_phone, p.id AS property_id, p.address_line1, p.council_tax_account
           FROM tenancies ty JOIN properties p ON p.id = ty.property_id JOIN councils c ON c.id = p.council_id
          WHERE ty.account_id = ? AND ty.tenant_id = ? ORDER BY c.name COLLATE NOCASE`, a, row.id);
      return [{ title: 'Councils', empty: 'None of this tenant\'s properties has a council set yet.', headers: ['Council', 'Council tax phone', 'Property', 'Account no.'],
        rows: rows.map((c) => [link('councils', c.id, c.name), { text: c.council_tax_phone || '' }, link('properties', c.property_id, c.address_line1),
          { text: c.council_tax_account || '' }]) }];
    }
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
      rentThisMonth: db.prepare(
        "SELECT COALESCE(SUM(amount_pence),0) n FROM transactions WHERE account_id = ? AND txn_type = 'rent_received' AND substr(txn_date,1,7) = ?"
      ).get(a, today.slice(0, 7)).n,
    };
    const arrears = ledger.arrears(db, a);
    stats.arrearsTotal = arrears.reduce((s, r) => s + r.owed, 0);
    const compliance = db.prepare(
      `SELECT c.id, c.item_type, c.expiry_date, p.address_line1, p.id AS property_id
         FROM compliance_items c JOIN properties p ON p.id = c.property_id
        WHERE c.account_id = ? AND c.expiry_date <= ?
          AND NOT EXISTS (SELECT 1 FROM compliance_items c2 WHERE c2.property_id = c.property_id
                          AND c2.item_type = c.item_type AND c2.expiry_date > c.expiry_date)
        ORDER BY c.expiry_date LIMIT 20`
    ).all(a, soon);
    // Notifications: certificates expired or expiring within a month. The 60-day list
    // below then only shows what's coming up after that.
    const monthAhead = fmt.addDays(today, 30);
    const certName = { 'Gas Safety (CP12)': 'Gas certificate', EICR: 'Electrical certificate (EICR)' };
    const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
    const notifications = compliance.filter((c) => c.expiry_date <= monthAhead).map((c) => {
      const days = daysBetween(today, c.expiry_date);
      return {
        ...c, name: certName[c.item_type] || c.item_type, expired: days < 0,
        when: days < 0 ? `expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`,
      };
    });
    const comingUp = compliance.filter((c) => c.expiry_date > monthAhead);
    const endingTenancies = db.prepare(
      `SELECT ty.id, ty.end_date, p.address_line1, t.name AS tenant_name
         FROM tenancies ty JOIN properties p ON p.id = ty.property_id JOIN tenants t ON t.id = ty.tenant_id
        WHERE ty.account_id = ? AND ty.status = 'active' AND ty.end_date IS NOT NULL AND ty.end_date <= ?
        ORDER BY ty.end_date LIMIT 20`
    ).all(a, soon);
    const jobs = db.prepare(
      `SELECT m.id, m.title, m.priority, m.status, m.reported_date, p.address_line1
         FROM maintenance_jobs m JOIN properties p ON p.id = m.property_id
        WHERE m.account_id = ? AND m.status != 'completed'
        ORDER BY CASE m.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.reported_date
        LIMIT 10`
    ).all(a);
    res.render('dashboard', {
      title: 'Dashboard', section: 'dashboard', stats, arrears: arrears.slice(0, 10), compliance: comingUp, notifications, endingTenancies, jobs,
      today, month: today.slice(0, 7), fmt, flash: req.query.flash || '',
    });
  });

  router.post('/rent/raise', (req, res) => {
    const month = String(req.body.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.redirect('/app?flash=' + encodeURIComponent('Choose a valid month.'));
    const n = transaction(db, () => ledger.raiseMonthlyRent(db, req.user.id, month));
    res.redirect('/app?flash=' + encodeURIComponent(`Raised ${n} rent charge${n === 1 ? '' : 's'} for ${month}.`));
  });

  // ---------- landlord statements ----------

  router.get('/statements', (req, res) => {
    const a = req.user.id;
    const landlords = refOptions('landlords', a);
    const today = fmt.today();
    const from = fmt.isIsoDate(String(req.query.from || '')) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = fmt.isIsoDate(String(req.query.to || '')) ? req.query.to : today;
    const landlordId = Number(req.query.landlord_id);
    const landlord = Number.isInteger(landlordId) ? db.prepare('SELECT * FROM landlords WHERE id = ? AND account_id = ?').get(landlordId, a) : null;
    const statement = landlord ? ledger.landlordStatement(db, a, landlord.id, from, to) : null;
    const balances = db.prepare(
      `SELECT l.id, l.name, COALESCE(${ledger.landlordBalanceSql('tx')}, 0) AS balance
         FROM landlords l LEFT JOIN transactions tx ON tx.landlord_id = l.id AND tx.account_id = l.account_id
        WHERE l.account_id = ? GROUP BY l.id ORDER BY l.name COLLATE NOCASE`
    ).all(a);
    res.render('statement', { title: 'Landlord statements', section: 'statements', landlords, landlord, statement, balances, from, to, fmt, print: req.query.print === '1' });
  });

  // ---------- my account: read-only; only the admin edits account details ----------

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
        const info = db.prepare('INSERT INTO tenants (account_id, name, email, phone, notes) VALUES (?, ?, ?, ?, ?)')
          .run(a, t.name, t.email, t.phone, t.notes);
        tv.tenant_id = Number(info.lastInsertRowid);
      }
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
    const rows = db.prepare(`SELECT * FROM ${def.table} WHERE ${where} ORDER BY ${def.order} LIMIT ${LIST_LIMIT + 1}`).all(...params);
    const truncated = rows.length > LIST_LIMIT;
    if (truncated) rows.pop();
    const maps = refLabelMaps(def, a);
    if (def.key === 'councils') {
      // How many properties are in each council, and which ones.
      const byCouncil = new Map();
      for (const p of db.prepare("SELECT council_id, address_line1 FROM properties WHERE account_id = ? AND council_id IS NOT NULL ORDER BY address_line1 COLLATE NOCASE").all(a)) {
        if (!byCouncil.has(p.council_id)) byCouncil.set(p.council_id, []);
        byCouncil.get(p.council_id).push(p.address_line1);
      }
      for (const row of rows) {
        const list = byCouncil.get(row.id) || [];
        const shown = list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '');
        row.properties = { text: list.length ? `${list.length} · ${shown}` : 'None yet', count: list.length };
      }
    }
    res.render('list', { title: def.plural, section: def.key, def, rows, maps, display, rowTitle, q, searchable: textFields.length > 0, truncated });
  });

  router.get('/:entity/new', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    renderForm(res, def, { row: null, values: formDefaults(def, req.query), errors: {}, accountId: req.user.id });
  });

  router.post('/:entity', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const a = req.user.id;
    const { values, errors } = parseForm(def, req.body, a);
    if (Object.keys(errors).length) return renderForm(res, def, { row: null, values, errors, accountId: a, status: 422 });
    prepareValues(def, a, values);
    const cols = Object.keys(values);
    const id = transaction(db, () => {
      const info = db.prepare(`INSERT INTO ${def.table} (account_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(a, ...cols.map((c) => values[c]));
      const newId = Number(info.lastInsertRowid);
      afterSave(def, a, newId, values);
      return newId;
    });
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
      let crows = db.prepare(`SELECT * FROM ${cdef.table} WHERE account_id = ? AND ${c.fk} = ? ORDER BY ${cdef.order} LIMIT 100`).all(a, row.id);
      // On a property, gas, electrical and insurance have their own panel.
      if (def.key === 'properties' && c.entity === 'compliance') crows = crows.filter((r) => !KEY_CERTS.some((k) => k.type === r.item_type));
      return { def: cdef, fk: c.fk, rows: crows, maps: refLabelMaps(cdef, a), title: def.key === 'properties' && c.entity === 'compliance' ? 'Other compliance' : null };
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
    if (def.key === 'maintenance' || def.key === 'properties') {
      const fk = def.key === 'maintenance' ? 'maintenance_job_id' : 'property_id';
      invoices = db.prepare(`SELECT * FROM invoices WHERE account_id = ? AND ${fk} = ? ORDER BY status = 'paid', due_date`).all(a, row.id);
    }
    res.render('show', { title: rowTitle(def, row, maps), section: def.key, def, row, maps, display, rowTitle, children, extra, invoices, related: relatedLists(def, row, a), certs, fmt, today: fmt.today() });
  });

  router.get('/:entity/:id/edit', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    renderForm(res, def, { row, values: row, errors: {}, accountId: req.user.id });
  });

  router.post('/:entity/:id', (req, res) => {
    const def = getEntity(req, res);
    if (!def) return;
    const row = getOwnedRow(def, req, res);
    if (!row) return;
    const a = req.user.id;
    const autosave = req.get('X-Autosave') === '1';
    const { values, errors } = parseForm(def, req.body, a);
    if (Object.keys(errors).length) {
      if (autosave) return res.status(422).json({ ok: false, errors });
      return renderForm(res, def, { row, values, errors, accountId: a, status: 422 });
    }
    prepareValues(def, a, values);
    const cols = Object.keys(values);
    transaction(db, () => {
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
