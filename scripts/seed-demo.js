'use strict';

// Usage: npm run seed-demo
// Creates one demo agency filled with realistic data, for trying the app out:
//   harbour / demo-password-123   (Harbour Lettings, Bristol)
// Skips if the demo account already exists.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, transaction } = require('../src/db');
const { loadConfig, ensureAdmin } = require('../src/server');
const { hashPassword } = require('../src/auth');
const ledger = require('../src/ledger');
const fmt = require('../src/format');
const { generateForAccount, previousMonth } = require('../src/statements');

const config = loadConfig();
const db = openDatabase(config.dbFile);
ensureAdmin(db, config, () => {});
if (db.prepare("SELECT 1 FROM users WHERE username = 'harbour'").get()) {
  console.log('Demo account already exists.');
  process.exit(0);
}

const today = fmt.today();
const month = (offset) => {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
};
const day = (offset) => fmt.addDays(today, offset);
const pence = (pounds) => Math.round(pounds * 100);
const monthEnd = (offset) => fmt.addDays(`${month(offset)}-01`, -1);

const AGENCIES = [
  {
    username: 'harbour', password: 'demo-password-123', email: 'demo@nexus.test', name: 'Sam Carter', agency: 'Harbour Lettings', logins: 37,
    landlords: [
      ['Jane Smith', 'jane.smith@example.com', '07700 900111', '12 Clifton Park\nBristol\nBS8 3BP'],
      ['Robert & Ann Hughes', 'hughes.family@example.com', '07700 900222', '3 Mill Lane\nBath\nBA1 2AB'],
      ['Priya Patel', 'priya.patel@example.com', '07700 900333', 'Flat 2, 40 Queen Square\nBristol\nBS1 4QS'],
      ['Westbury Estates Ltd', 'accounts@westbury.example.com', '0117 496 0000', 'Unit 5, Harbourside\nBristol\nBS1 5DB'],
    ],
    properties: [
      [0, '14 Harbour View', 'Bristol', 'BS1 4RT', 'Flat', 2, 10],
      [0, '7 Redland Grove', 'Bristol', 'BS6 6PR', 'House', 3, 10],
      [1, '22 Pulteney Road', 'Bath', 'BA2 4EZ', 'House', 4, 12],
      [2, 'Flat 5, 18 Park Street', 'Bristol', 'BS1 5JA', 'Studio', 1, 11],
      [3, '101 Gloucester Road', 'Bristol', 'BS7 8AT', 'HMO', 6, 15],
      [3, '103 Gloucester Road', 'Bristol', 'BS7 8AT', 'Flat', 2, 15],
    ],
    tenants: [
      ['Tom Walker', 'tom.walker@example.com', '07700 900401'],
      ['Emily & James Clarke', 'clarkes@example.com', '07700 900402'],
      ['Oliver Bennett', 'ollie.b@example.com', '07700 900403'],
      ['Sophie Turner', 'sophie.t@example.com', '07700 900404'],
      ['Daniel Okafor', 'dan.okafor@example.com', '07700 900405'],
    ],
    // [property, tenant, rent, booking date, start date, end date, deposit]
    tenancies: [
      [0, 0, 1250, `${month(-8)}-10`, `${month(-7)}-01`, monthEnd(5), 1440],
      [1, 1, 1650, `${month(-14)}-02`, `${month(-13)}-15`, day(45), 1900],
      [2, 2, 2100, `${month(-5)}-20`, `${month(-4)}-01`, monthEnd(8), 2400],
      [3, 3, 875, `${month(-3)}-05`, `${month(-2)}-08`, fmt.addDays(`${month(10)}-08`, -1), 1000],
      [4, 4, 3300, `${month(-10)}-12`, `${month(-9)}-01`, null, 3800],
    ],
    arrearsTenancy: 3,
    jobs: [
      [0, 'Leaking kitchen tap', 'Bristol Plumbing Co', 'normal', 'completed', -40, 145],
      [2, 'Boiler not heating water', 'SW Heating Services', 'emergency', 'in progress', -3, null],
      [4, 'Replace fire door closer (room 3)', 'SafeHome Fire', 'high', 'open', -6, null],
      [1, 'Garden fence panel blown down', 'Redland Handyman', 'low', 'open', -12, null],
    ],
    // [job, supplier, number, amount, invoice day, due day, paid?]
    invoices: [
      [0, 'Bristol Plumbing Co', 'BP-1042', 145, -38, -24, true],
      [1, 'SW Heating Services', 'SWH-2231', 386.4, -2, 12, false],
      [2, 'SafeHome Fire', 'SF-0098', 92.5, -20, -6, false],
    ],
    // [property, certificate, issued day, expiry day]
    // [property, type, issued day, expiry day, provider, reference]
    certs: [
      [0, 'Gas Safety (CP12)', -1070, -705, 'Bristol Gas Services', 'GS-20931'],
      [0, 'Gas Safety (CP12)', -705, -340, 'Bristol Gas Services', 'GS-31177'],
      [0, 'Gas Safety (CP12)', -340, 25, 'Bristol Gas Services', 'GS-40512'],
      [0, 'EICR', -700, 1125, 'Avon Electrical', 'EICR-8812'],
      [0, 'Insurance', -120, 245, 'Homelet', 'HL-554201'],
      [1, 'Gas Safety (CP12)', -745, -380, 'Redland Heating', 'RH-1102'],
      [1, 'Gas Safety (CP12)', -380, -15, 'Redland Heating', 'RH-2240'],
      [1, 'EICR', -2100, -275, 'Avon Electrical', 'EICR-2019'],
      [1, 'Insurance', -300, 65, 'Direct Line for Business', 'DL-99120'],
      [2, 'Gas Safety (CP12)', -90, 275, 'SW Heating Services', 'SWH-771'],
      [2, 'EICR', -400, 1425, 'Bath Electrical', 'BE-3301'],
      [2, 'Insurance', -30, 335, 'Aviva', 'AV-220915'],
      [2, 'EPC', -1500, 2150, null, null],
      [3, 'EICR', -800, 1025, 'Avon Electrical', 'EICR-6602'],
      [4, 'Gas Safety (CP12)', -200, 165, 'SafeHome Gas', 'SH-4410'],
      [4, 'EICR', -1500, 325, 'Avon Electrical', 'EICR-4101'],
      [4, 'Insurance', -380, -15, 'Alan Boswell', 'AB-HMO-311'],
      [4, 'HMO licence', -1400, 40, null, null], [4, 'Fire risk assessment', -200, 165, null, null],
    ],
  },
];

function seedAgency(p, lastLoginHoursAgo) {
  const u = db.prepare(`INSERT INTO users (username, email, name, agency_name, password_hash, created_at, last_login_at, login_count)
                        VALUES (?, ?, ?, ?, ?, datetime('now', '-400 days'), datetime('now', ?), ?)`)
    .run(p.username, p.email, p.name, p.agency, hashPassword(p.password), `-${lastLoginHoursAgo} hours`, p.logins);
  const a = Number(u.lastInsertRowid);
  const ins = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);

  const landlords = p.landlords.map(([name, email, phone, address]) =>
    ins('INSERT INTO landlords (account_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)', a, name, email, phone, address));
  // Councils, matched to properties by town.
  const councils = {
    Bristol: ins(`INSERT INTO councils (account_id, name, council_tax_phone, council_tax_email, licensing_email, environmental_phone, website, address)
                  VALUES (?, 'Bristol City Council', '0117 922 2900', 'council.tax@bristol.example.gov.uk', 'private.housing@bristol.example.gov.uk', '0117 922 2500', 'www.bristol.gov.uk', 'City Hall\nCollege Green\nBristol\nBS1 5TR')`, a),
    Bath: ins(`INSERT INTO councils (account_id, name, council_tax_phone, council_tax_email, licensing_email, environmental_phone, website, address)
               VALUES (?, 'Bath & North East Somerset Council', '01225 477 000', 'council_tax@bathnes.example.gov.uk', 'hmo@bathnes.example.gov.uk', '01225 477 508', 'www.bathnes.gov.uk', 'Lewis House\nManvers Street\nBath\nBA1 1JG')`, a),
  };
  const bands = ['B', 'D', 'E', 'A', 'C', 'B'];
  const props = p.properties.map(([l, addr, town, pc, type, beds, fee], i) => ins(
    "INSERT INTO properties (account_id, landlord_id, address_line1, town, postcode, property_type, bedrooms, management_fee_pct, status, council_id, council_tax_band, council_tax_account, council_tax_payer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'vacant', ?, ?, ?, ?)",
    a, landlords[l], addr, town, pc, type, beds, fee, councils[town] || null, bands[i % bands.length], `CT-${40211 + i * 137}`, type === 'HMO' ? 'Landlord' : 'Tenant'));
  const tenants = p.tenants.map(([name, email, phone]) =>
    ins('INSERT INTO tenants (account_id, name, email, phone) VALUES (?, ?, ?, ?)', a, name, email, phone));
  const ty = p.tenancies.map(([pi, ti, rent, booking, start, end, dep]) => {
    const id = ins(
      "INSERT INTO tenancies (account_id, property_id, tenant_id, booking_date, start_date, end_date, rent_pence, rent_frequency, deposit_pence, deposit_scheme, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'monthly', ?, 'DPS', 'active')",
      a, props[pi], tenants[ti], booking, start, end, pence(rent), pence(dep));
    db.prepare("UPDATE properties SET status = 'let' WHERE id = ?").run(props[pi]);
    return id;
  });

  // Four months of rent: raise, receive (one tenant falls behind), pay landlords.
  const receive = (tenancyId, date, amount) => {
    const t = ledger.resolveLinks(db, a, { tenancy_id: tenancyId, property_id: null, landlord_id: null });
    const id = ins("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, tenancy_id, description, amount_pence) VALUES (?, ?, 'rent_received', ?, ?, ?, 'Rent received', ?)",
      a, date, t.landlord_id, t.property_id, tenancyId, amount);
    ledger.bookManagementFee(db, a, id);
  };
  for (const off of [-3, -2, -1, 0]) {
    const m = month(off);
    ledger.raiseMonthlyRent(db, a, m);
    for (const id of ty) {
      const t = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(id);
      if (t.start_date > `${m}-28`) continue;
      if (id === ty[p.arrearsTenancy] && off >= -1) {
        if (off === -1) receive(id, `${m}-12`, Math.round(t.rent_pence * 0.5));
        continue;
      }
      const d = Math.min(Number(t.start_date.slice(8, 10)) + 1, 28);
      const date = `${m}-${String(d).padStart(2, '0')}`;
      if (date <= today) receive(id, date, t.rent_pence);
    }
    if (off < 0) {
      for (const l of landlords) {
        const bal = db.prepare(`SELECT COALESCE(${ledger.landlordBalanceSql('tx')}, 0) AS b FROM transactions tx WHERE account_id = ? AND landlord_id = ? AND txn_date <= ?`).get(a, l, `${m}-28`).b;
        if (bal > 0) ins("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, description, amount_pence) VALUES (?, ?, 'landlord_payment', ?, ?, ?)", a, `${m}-28`, l, `Statement payment ${m}`, bal);
      }
    }
  }

  const jobs = p.jobs.map(([pi, title, contractor, priority, status, reported, cost]) => ins(
    'INSERT INTO maintenance_jobs (account_id, property_id, title, contractor, priority, status, reported_date, cost_pence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    a, props[pi], title, contractor, priority, status, day(reported), cost == null ? null : pence(cost)));

  const uploadDir = path.join(config.uploadDir, String(a));
  fs.mkdirSync(uploadDir, { recursive: true });
  for (const [ji, supplier, number, amount, invDay, dueDay, paid] of p.invoices) {
    const job = db.prepare('SELECT property_id FROM maintenance_jobs WHERE id = ?').get(jobs[ji]);
    const file = crypto.randomBytes(16).toString('hex') + '.pdf';
    fs.writeFileSync(path.join(uploadDir, file), `%PDF-1.4\n% Demo invoice ${number} from ${supplier}\n%%EOF\n`);
    const id = ins(
      "INSERT INTO invoices (account_id, maintenance_job_id, property_id, supplier, invoice_number, invoice_date, due_date, amount_pence, status, file_name, file_original, file_mime, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, 'application/pdf', 64)",
      a, jobs[ji], job.property_id, supplier, number, day(invDay), day(dueDay), pence(amount), file, `${number}.pdf`);
    if (paid) {
      const paidDate = `${month(-1)}-06`;
      const t = ledger.resolveLinks(db, a, { property_id: job.property_id, landlord_id: null });
      const txn = ins("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, description, amount_pence) VALUES (?, ?, 'expense', ?, ?, ?, ?)",
        a, paidDate, t.landlord_id, job.property_id, `Invoice ${number} — ${supplier}`, pence(amount));
      db.prepare("UPDATE invoices SET status = 'paid', paid_date = ?, payment_method = 'Bank transfer', payment_reference = ?, payment_txn_id = ? WHERE id = ?")
        .run(paidDate, `PAY-${number}`, txn, id);
    }
  }

  for (const [pi, type, issued, expiry, provider, reference] of p.certs) {
    ins(`INSERT INTO compliance_items (account_id, property_id, item_type, issued_date, expiry_date, provider, reference, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, a, props[pi], type, day(issued), day(expiry), provider || null, reference || null, `${day(issued + 2)} 10:00:00`);
  }
  db.prepare("INSERT INTO login_events (user_id, email, success, ip, user_agent, created_at) VALUES (?, ?, 1, '81.2.69.142', 'Mozilla/5.0', datetime('now', ?))")
    .run(a, p.username, `-${lastLoginHoursAgo} hours`);
  // A few days of typical activity for the admin panel's activity log.
  const act = db.prepare("INSERT INTO activity_log (user_id, action, summary, path, ip, created_at) VALUES (?, ?, ?, ?, '81.2.69.142', datetime('now', ?))");
  const addr = p.properties.map((x) => x[1]);
  [
    [4 * 24 + 6, 'signed in', 'Signed in', '/login'],
    [4 * 24 + 6, 'viewed', 'Viewed the dashboard', '/app'],
    [4 * 24 + 5, 'created', `Raised rent for ${month(0)}`, '/app/rent/raise'],
    [3 * 24 + 3, 'signed in', 'Signed in', '/login'],
    [3 * 24 + 3, 'viewed', `Viewed property: ${addr[0]}`, '/app/properties/1'],
    [3 * 24 + 2, 'created', 'Added certificate: Gas Safety (CP12)', '/app/compliance'],
    [2 * 24 + 4, 'signed in', 'Signed in', '/login'],
    [2 * 24 + 4, 'viewed', 'Viewed invoices', '/app/invoices'],
    [2 * 24 + 3, 'created', 'Uploaded invoice: SW Heating Services', '/app/invoices'],
    [2 * 24 + 1, 'updated', `Edited property: ${addr[2]}`, '/app/properties/3'],
    [26, 'signed in', 'Signed in', '/login'],
    [26, 'viewed', 'Viewed monthly statements', '/app/monthly'],
    [25, 'created', `Generated monthly statements for ${month(-1)}`, '/app/monthly/generate'],
    [24, 'downloaded', 'Downloaded all their data', '/app/export'],
    [3, 'signed in', 'Signed in', '/login'],
    [3, 'viewed', 'Viewed the dashboard', '/app'],
    [2.5, 'viewed', 'Viewed tenants', '/app/tenants'],
    [2.2, 'updated', 'Edited tenant: Sophie Turner', '/app/tenants/4'],
    [2, 'created', 'Added maintenance job: Garden fence panel blown down', '/app/maintenance'],
  ].forEach(([hoursAgo, action, summary, path]) => act.run(a, action, summary, path, `-${Math.round(hoursAgo * 60)} minutes`));
  return a;
}

const ids = transaction(db, () => {
  const seeded = AGENCIES.map((p, i) => seedAgency(p, i === 0 ? 2 : 70));
  return seeded;
});

(async () => {
  for (const [i, p] of AGENCIES.entries()) {
    await generateForAccount(db, { accountId: ids[i], agencyName: p.agency, month: previousMonth(today), writer: null });
  }
  console.log('Demo agency created. Sign in as:');
  for (const p of AGENCIES) console.log(`  ${p.username} / ${p.password}   (${p.agency})`);
})();
