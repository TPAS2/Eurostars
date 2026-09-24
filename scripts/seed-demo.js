'use strict';

// Usage: npm run seed-demo
// Creates a demo agency (demo@letwise.test / demo-password-123) filled with realistic data,
// for trying the app out. Refuses to run if the demo account already exists.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, transaction } = require('../src/db');
const { loadConfig, ensureAdmin } = require('../src/server');
const { hashPassword } = require('../src/auth');
const ledger = require('../src/ledger');
const fmt = require('../src/format');
const { generateForAccount, previousMonth } = require('../src/statements');

const EMAIL = 'demo@letwise.test';
const PASSWORD = 'demo-password-123';

const config = loadConfig();
const db = openDatabase(config.dbFile);
ensureAdmin(db, config, () => {});
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(EMAIL)) {
  console.log(`Demo account ${EMAIL} already exists.`);
  process.exit(0);
}

const today = fmt.today();
const month = (offset) => {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
};
const day = (offset) => fmt.addDays(today, offset);
const pence = (pounds) => Math.round(pounds * 100);

const accountId = transaction(db, () => {
  const u = db.prepare("INSERT INTO users (email, name, agency_name, password_hash, last_login_at, login_count) VALUES (?, 'Sam Carter', 'Harbour Lettings', ?, datetime('now', '-2 hours'), 37)")
    .run(EMAIL, hashPassword(PASSWORD));
  const a = Number(u.lastInsertRowid);
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const landlords = [
    ['Jane Smith', 'jane.smith@example.com', '07700 900111', '12 Clifton Park\nBristol\nBS8 3BP'],
    ['Robert & Ann Hughes', 'hughes.family@example.com', '07700 900222', '3 Mill Lane\nBath\nBA1 2AB'],
    ['Priya Patel', 'priya.patel@example.com', '07700 900333', 'Flat 2, 40 Queen Square\nBristol\nBS1 4QS'],
    ['Westbury Estates Ltd', 'accounts@westbury.example.com', '0117 496 0000', 'Unit 5, Harbourside\nBristol\nBS1 5DB'],
  ].map(([name, email, phone, address]) => ins('INSERT INTO landlords (account_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)', a, name, email, phone, address));

  const props = [
    [landlords[0], '14 Harbour View', 'Bristol', 'BS1 4RT', 'Flat', 2, 10],
    [landlords[0], '7 Redland Grove', 'Bristol', 'BS6 6PR', 'House', 3, 10],
    [landlords[1], '22 Pulteney Road', 'Bath', 'BA2 4EZ', 'House', 4, 12],
    [landlords[2], 'Flat 5, 18 Park Street', 'Bristol', 'BS1 5JA', 'Studio', 1, 11],
    [landlords[3], '101 Gloucester Road', 'Bristol', 'BS7 8AT', 'HMO', 6, 15],
    [landlords[3], '103 Gloucester Road', 'Bristol', 'BS7 8AT', 'Flat', 2, 15],
  ].map(([l, addr, town, pc, type, beds, fee]) => ins(
    "INSERT INTO properties (account_id, landlord_id, address_line1, town, postcode, property_type, bedrooms, management_fee_pct, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'vacant')",
    a, l, addr, town, pc, type, beds, fee));

  const tenants = [
    ['Tom Walker', 'tom.walker@example.com', '07700 900401'],
    ['Emily & James Clarke', 'clarkes@example.com', '07700 900402'],
    ['Oliver Bennett', 'ollie.b@example.com', '07700 900403'],
    ['Sophie Turner', 'sophie.t@example.com', '07700 900404'],
    ['Daniel Okafor', 'dan.okafor@example.com', '07700 900405'],
  ].map(([name, email, phone]) => ins('INSERT INTO tenants (account_id, name, email, phone) VALUES (?, ?, ?, ?)', a, name, email, phone));

  const tenancy = (p, t, rent, booking, start, end, dep) => {
    const id = ins(
      "INSERT INTO tenancies (account_id, property_id, tenant_id, booking_date, start_date, end_date, rent_pence, rent_frequency, deposit_pence, deposit_scheme, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'monthly', ?, 'DPS', 'active')",
      a, p, t, booking, start, end, pence(rent), pence(dep));
    db.prepare("UPDATE properties SET status = 'let' WHERE id = ?").run(p);
    return id;
  };
  const ty = [
    tenancy(props[0], tenants[0], 1250, `${month(-8)}-10`, `${month(-7)}-01`, fmt.addDays(`${month(5)}-01`, -1), 1440),
    tenancy(props[1], tenants[1], 1650, `${month(-14)}-02`, `${month(-13)}-15`, fmt.addDays(today, 45), 1900),
    tenancy(props[2], tenants[2], 2100, `${month(-5)}-20`, `${month(-4)}-01`, fmt.addDays(`${month(8)}-01`, -1), 2400),
    tenancy(props[3], tenants[3], 875, `${month(-3)}-05`, `${month(-2)}-08`, fmt.addDays(`${month(10)}-08`, -1), 1000),
    tenancy(props[4], tenants[4], 3300, `${month(-10)}-12`, `${month(-9)}-01`, null, 3800),
  ];

  // Three months of rent: raise, receive (one tenant falls behind), pay landlords.
  const receive = (tenancyId, date, amount) => {
    const t = ledger.resolveLinks(db, a, { tenancy_id: tenancyId, property_id: null, landlord_id: null });
    const id = ins("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, tenancy_id, description, amount_pence) VALUES (?, ?, 'rent_received', ?, ?, ?, 'Rent received', ?)",
      a, date, t.landlord_id, t.property_id, tenancyId, amount);
    ledger.bookManagementFee(db, a, id);
  };
  for (const off of [-3, -2, -1, 0]) {
    const m = month(off);
    ledger.raiseMonthlyRent(db, a, m);
    if (off === 0 && Number(today.slice(8, 10)) < 3) continue;
    for (const id of ty) {
      const t = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(id);
      if (t.start_date > `${m}-28`) continue;
      if (id === ty[3] && off >= -1) { if (off === -1) receive(id, `${m}-12`, pence(500)); continue; } // arrears
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

  // Maintenance and invoices.
  const job = (p, title, contractor, priority, status, reported, cost) => ins(
    'INSERT INTO maintenance_jobs (account_id, property_id, title, contractor, priority, status, reported_date, cost_pence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    a, p, title, contractor, priority, status, reported, cost == null ? null : pence(cost));
  const jobs = [
    job(props[0], 'Leaking kitchen tap', 'Bristol Plumbing Co', 'normal', 'completed', day(-40), 145),
    job(props[2], 'Boiler not heating water', 'SW Heating Services', 'emergency', 'in progress', day(-3), null),
    job(props[4], 'Replace fire door closer (room 3)', 'SafeHome Fire', 'high', 'open', day(-6), null),
    job(props[1], 'Garden fence panel blown down', 'Redland Handyman', 'low', 'open', day(-12), null),
  ];
  const uploadDir = path.join(config.uploadDir, String(a));
  fs.mkdirSync(uploadDir, { recursive: true });
  const invoice = (j, p, supplier, number, amount, invDate, due, paid) => {
    const file = crypto.randomBytes(16).toString('hex') + '.pdf';
    fs.writeFileSync(path.join(uploadDir, file), `%PDF-1.4\n% Demo invoice ${number} from ${supplier}\n%%EOF\n`);
    const id = ins(
      "INSERT INTO invoices (account_id, maintenance_job_id, property_id, supplier, invoice_number, invoice_date, due_date, amount_pence, status, file_name, file_original, file_mime, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, 'application/pdf', 64)",
      a, j, p, supplier, number, invDate, due, pence(amount), file, `${number}.pdf`);
    if (paid) {
      const t = ledger.resolveLinks(db, a, { property_id: p, landlord_id: null });
      const txn = ins("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, property_id, description, amount_pence) VALUES (?, ?, 'expense', ?, ?, ?, ?)",
        a, paid, t.landlord_id, p, `Invoice ${number} — ${supplier}`, pence(amount));
      db.prepare("UPDATE invoices SET status = 'paid', paid_date = ?, payment_method = 'Bank transfer', payment_reference = ?, payment_txn_id = ? WHERE id = ?").run(paid, `HL-${number}`, txn, id);
    }
  };
  invoice(jobs[0], props[0], 'Bristol Plumbing Co', 'BP-1042', 145, day(-38), day(-24), `${month(-1)}-06`);
  invoice(jobs[1], props[2], 'SW Heating Services', 'SWH-2231', 386.4, day(-2), day(12), null);
  invoice(jobs[2], props[4], 'SafeHome Fire', 'SF-0098', 92.5, day(-20), day(-6), null);

  // Compliance certificates, some due soon.
  const cert = (p, type, issued, expiry) => ins('INSERT INTO compliance_items (account_id, property_id, item_type, issued_date, expiry_date) VALUES (?, ?, ?, ?, ?)', a, p, type, issued, expiry);
  cert(props[0], 'Gas Safety (CP12)', day(-340), day(25));
  cert(props[0], 'EICR', day(-700), day(1125));
  cert(props[1], 'Gas Safety (CP12)', day(-380), day(-15));
  cert(props[2], 'EPC', day(-1500), day(2150));
  cert(props[4], 'HMO licence', day(-1400), day(40));
  cert(props[4], 'Fire risk assessment', day(-200), day(165));

  // A few other agencies so the admin panel has something to show.
  for (const [email, name, agency, logins, daysAgo] of [
    ['info@cityletsbath.example.com', 'Laura Mills', 'City Lets Bath', 12, 3],
    ['office@severnhomes.example.com', 'Mark Evans', 'Severn Homes', 58, 0],
    ['hello@cliftonrentals.example.com', 'Aisha Khan', 'Clifton Rentals', 4, 20],
  ]) {
    const id = ins(`INSERT INTO users (email, name, agency_name, password_hash, created_at, last_login_at, login_count) VALUES (?, ?, ?, ?, datetime('now', '-${daysAgo + 30} days'), datetime('now', '-${daysAgo} days'), ?)`,
      email, name, agency, hashPassword(crypto.randomBytes(12).toString('hex')), logins);
    for (let i = 0; i < 3; i++) {
      const l = ins('INSERT INTO landlords (account_id, name) VALUES (?, ?)', id, `Landlord ${i + 1}`);
      ins("INSERT INTO properties (account_id, landlord_id, address_line1, status) VALUES (?, ?, ?, 'let')", id, l, `${10 + i} Example Street`);
    }
    db.prepare("INSERT INTO login_events (user_id, email, success, ip, user_agent, created_at) VALUES (?, ?, 1, '81.2.69.160', 'Mozilla/5.0', datetime('now', ?))").run(id, email, `-${daysAgo} days`);
  }
  db.prepare("INSERT INTO login_events (user_id, email, success, ip, user_agent) VALUES (?, ?, 1, '81.2.69.142', 'Mozilla/5.0')").run(a, EMAIL);
  return a;
});

generateForAccount(db, { accountId, agencyName: 'Harbour Lettings', month: previousMonth(today), writer: null })
  .then((n) => console.log(`Demo agency created with ${n} monthly statements.\nSign in as ${EMAIL} / ${PASSWORD}`));
