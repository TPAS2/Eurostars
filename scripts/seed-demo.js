'use strict';

// Usage: npm run seed-demo
// Creates two demo agencies filled with realistic data, for trying the app out:
//   harbour  / demo-password-123   (Harbour Lettings, Bristol)
//   citylets / demo-password-456   (City Lets Bath)
// plus two lightly used agencies so the admin panel has more to show.
// Skips if the demo accounts already exist.

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
  console.log('Demo accounts already exist.');
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
    certs: [
      [0, 'Gas Safety (CP12)', -340, 25], [0, 'EICR', -700, 1125], [1, 'Gas Safety (CP12)', -380, -15],
      [2, 'EPC', -1500, 2150], [4, 'HMO licence', -1400, 40], [4, 'Fire risk assessment', -200, 165],
    ],
  },
  {
    username: 'citylets', password: 'demo-password-456', email: 'info@cityletsbath.example.com', name: 'Laura Mills', agency: 'City Lets Bath', logins: 12,
    landlords: [
      ['Margaret Ellis', 'm.ellis@example.com', '07700 900511', '9 Lansdown Crescent\nBath\nBA1 5EX'],
      ['Tom & Keira Doyle', 'doyles@example.com', '07700 900522', '41 Widcombe Hill\nBath\nBA2 6AA'],
      ['Avon Student Homes Ltd', 'lettings@avonstudent.example.com', '01225 496 100', '2 Kingsmead Square\nBath\nBA1 2AB'],
    ],
    properties: [
      [0, '5 Gay Street', 'Bath', 'BA1 2PH', 'Flat', 2, 12],
      [0, 'Flat 3, 18 Great Pulteney Street', 'Bath', 'BA2 4BR', 'Flat', 1, 12],
      [1, '27 Oldfield Road', 'Bath', 'BA2 3NQ', 'House', 3, 10],
      [2, '64 Wellsway', 'Bath', 'BA2 4SB', 'HMO', 5, 14],
    ],
    tenants: [
      ['Chloe Harris', 'chloe.h@example.com', '07700 900601'],
      ['Ben Foster', 'ben.foster@example.com', '07700 900602'],
      ['Nadia & Omar Rahman', 'rahmans@example.com', '07700 900603'],
      ['Bath Uni student group', 'wellsway64@example.com', '07700 900604'],
    ],
    tenancies: [
      [0, 0, 1395, `${month(-11)}-18`, `${month(-10)}-01`, day(30), 1600],
      [1, 1, 995, `${month(-4)}-02`, `${month(-3)}-15`, monthEnd(9), 1140],
      [2, 2, 1550, `${month(-20)}-10`, `${month(-19)}-01`, null, 1780],
      [3, 3, 2900, `${month(-6)}-01`, `${month(-2)}-01`, monthEnd(10), 3300],
    ],
    arrearsTenancy: 1,
    jobs: [
      [3, 'Shower pump replacement', 'Bath Plumbing & Heating', 'high', 'in progress', -5, null],
      [0, 'Sash window sticking', 'Georgian Joinery', 'low', 'open', -18, null],
      [2, 'Annual boiler service', 'Avon Gas Services', 'normal', 'completed', -50, 89],
    ],
    invoices: [
      [0, 'Bath Plumbing & Heating', 'BPH-7781', 312, -4, 10, false],
      [2, 'Avon Gas Services', 'AGS-5520', 89, -48, -34, true],
    ],
    certs: [
      [0, 'Gas Safety (CP12)', -300, 65], [2, 'Gas Safety (CP12)', -50, 315], [3, 'HMO licence', -1000, 20],
      [3, 'Fire risk assessment', -350, 15], [1, 'EICR', -1700, 125],
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
  const props = p.properties.map(([l, addr, town, pc, type, beds, fee]) => ins(
    "INSERT INTO properties (account_id, landlord_id, address_line1, town, postcode, property_type, bedrooms, management_fee_pct, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'vacant')",
    a, landlords[l], addr, town, pc, type, beds, fee));
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

  for (const [pi, type, issued, expiry] of p.certs) {
    ins('INSERT INTO compliance_items (account_id, property_id, item_type, issued_date, expiry_date) VALUES (?, ?, ?, ?, ?)', a, props[pi], type, day(issued), day(expiry));
  }
  db.prepare("INSERT INTO login_events (user_id, email, success, ip, user_agent, created_at) VALUES (?, ?, 1, '81.2.69.142', 'Mozilla/5.0', datetime('now', ?))")
    .run(a, p.username, `-${lastLoginHoursAgo} hours`);
  return a;
}

const ids = transaction(db, () => {
  const seeded = AGENCIES.map((p, i) => seedAgency(p, i === 0 ? 2 : 70));
  // Two lightly used agencies so the admin panel has more to show.
  for (const [username, email, name, agency, logins, daysAgo] of [
    ['severnhomes', null, 'Mark Evans', 'Severn Homes', 58, 0],
    ['clifton.rentals', 'hello@cliftonrentals.example.com', 'Aisha Khan', 'Clifton Rentals', 4, 20],
  ]) {
    const id = Number(db.prepare(`INSERT INTO users (username, email, name, agency_name, password_hash, created_at, last_login_at, login_count) VALUES (?, ?, ?, ?, ?, datetime('now', '-${daysAgo + 30} days'), datetime('now', '-${daysAgo} days'), ?)`)
      .run(username, email, name, agency, hashPassword(crypto.randomBytes(12).toString('hex')), logins).lastInsertRowid);
    for (let i = 0; i < 3; i++) {
      const l = Number(db.prepare('INSERT INTO landlords (account_id, name) VALUES (?, ?)').run(id, `Landlord ${i + 1}`).lastInsertRowid);
      db.prepare("INSERT INTO properties (account_id, landlord_id, address_line1, status) VALUES (?, ?, ?, 'let')").run(id, l, `${10 + i} Example Street`);
    }
    db.prepare("INSERT INTO login_events (user_id, email, success, ip, user_agent, created_at) VALUES (?, ?, 1, '81.2.69.160', 'Mozilla/5.0', datetime('now', ?))").run(id, username, `-${daysAgo} days`);
  }
  return seeded;
});

(async () => {
  for (const [i, p] of AGENCIES.entries()) {
    await generateForAccount(db, { accountId: ids[i], agencyName: p.agency, month: previousMonth(today), writer: null });
  }
  console.log('Demo agencies created. Sign in as:');
  for (const p of AGENCIES) console.log(`  ${p.username} / ${p.password}   (${p.agency})`);
})();
