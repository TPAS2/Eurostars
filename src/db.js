'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT UNIQUE COLLATE NOCASE,          -- optional contact address
  name            TEXT NOT NULL,
  agency_name     TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT,
  login_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- Password checked, waiting for the two-step code.
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  success     INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What each signed-in person viewed and changed, for the admin panel.
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,          -- viewed | created | updated | deleted | downloaded | signed in | signed out
  summary     TEXT NOT NULL,
  path        TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at);

CREATE TABLE IF NOT EXISTS landlords (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id                  INTEGER PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id         INTEGER REFERENCES landlords(id) ON DELETE SET NULL,
  address_line1       TEXT NOT NULL,
  town                TEXT,
  postcode            TEXT,
  property_type       TEXT,
  bedrooms            INTEGER,
  management_fee_pct  REAL,
  status              TEXT NOT NULL DEFAULT 'vacant',
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Local authorities: council tax, licensing (HMO / selective) and environmental health contacts.
CREATE TABLE IF NOT EXISTS councils (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  council_tax_phone    TEXT,
  council_tax_email    TEXT,
  licensing_email      TEXT,
  environmental_phone  TEXT,
  website              TEXT,
  address              TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The signed tenancy agreement for a tenancy (PDF or image), kept in the database so backups include it.
CREATE TABLE IF NOT EXISTS tenancy_agreements (
  tenancy_id   INTEGER PRIMARY KEY REFERENCES tenancies(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each company's payment instruction template (e.g. the Metro Bank form), as uploaded.
CREATE TABLE IF NOT EXISTS payment_templates (
  account_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A filled-in payment instruction for a month's rent run (JSON of the form's contents).
CREATE TABLE IF NOT EXISTS payment_instructions (
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, month)
);

-- Notes on each council's reconciliation, one per council per month, plus any amounts typed in
-- on the page (which replace the calculated money owed / money in when set).
CREATE TABLE IF NOT EXISTS council_rec_notes (
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  council_id  INTEGER NOT NULL REFERENCES councils(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  notes       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, council_id, month)
);

-- One picture per council (e.g. its logo), kept in the database so backups include it.
CREATE TABLE IF NOT EXISTS council_photos (
  council_id  INTEGER PRIMARY KEY REFERENCES councils(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenancies (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_date    TEXT,
  start_date      TEXT NOT NULL,
  end_date        TEXT,
  rent_pence      INTEGER NOT NULL,
  rent_frequency  TEXT NOT NULL DEFAULT 'monthly',
  deposit_pence   INTEGER,
  deposit_scheme  TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  contractor     TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal',
  status         TEXT NOT NULL DEFAULT 'open',
  reported_date  TEXT,
  cost_pence     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compliance_items (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  item_type    TEXT NOT NULL,
  issued_date  TEXT,
  expiry_date  TEXT NOT NULL,
  reference    TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Client-account ledger. Amounts are always positive; the type gives the direction.
--   rent_charge       tenant owes rent (increases arrears)
--   rent_received     tenant paid (reduces arrears, money in for the landlord)
--   fee               agency management fee taken from landlord funds
--   expense           paid out on the landlord's behalf (repairs, certificates...)
--   landlord_payment  paid out to the landlord
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  txn_date     TEXT NOT NULL,
  txn_type     TEXT NOT NULL,
  landlord_id  INTEGER REFERENCES landlords(id) ON DELETE SET NULL,
  property_id  INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  tenancy_id   INTEGER REFERENCES tenancies(id) ON DELETE SET NULL,
  description  TEXT,
  amount_pence INTEGER NOT NULL,
  source_txn_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supplier/contractor invoices, usually for a maintenance job, with the uploaded document.
CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  maintenance_job_id  INTEGER REFERENCES maintenance_jobs(id) ON DELETE SET NULL,
  property_id         INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  supplier            TEXT NOT NULL,
  invoice_number      TEXT,
  invoice_date        TEXT,
  due_date            TEXT,
  amount_pence        INTEGER NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | paid
  paid_date           TEXT,
  payment_method      TEXT,
  payment_reference   TEXT,
  payment_txn_id      INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  file_name           TEXT,          -- random name on disk
  file_original       TEXT,          -- name as uploaded
  file_mime           TEXT,
  file_size           INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One statement per landlord per month. Figures are a snapshot taken when generated.
CREATE TABLE IF NOT EXISTS monthly_statements (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id        INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  month              TEXT NOT NULL,          -- YYYY-MM
  opening_pence      INTEGER NOT NULL,
  rent_pence         INTEGER NOT NULL,
  fees_pence         INTEGER NOT NULL,
  expenses_pence     INTEGER NOT NULL,
  net_pence          INTEGER NOT NULL,
  payments_pence     INTEGER NOT NULL,
  closing_pence      INTEGER NOT NULL,
  outstanding_pence  INTEGER NOT NULL,
  detail_json        TEXT NOT NULL,
  summary            TEXT NOT NULL,
  summary_source     TEXT NOT NULL,          -- ai | template
  ai_model           TEXT,
  note               TEXT,
  generated_at       TEXT NOT NULL,
  UNIQUE (account_id, landlord_id, month)
);

CREATE INDEX IF NOT EXISTS idx_invoices_account   ON invoices(account_id, status);
CREATE INDEX IF NOT EXISTS idx_landlords_account  ON landlords(account_id);
CREATE INDEX IF NOT EXISTS idx_properties_account  ON properties(account_id);
CREATE INDEX IF NOT EXISTS idx_councils_account    ON councils(account_id);
CREATE INDEX IF NOT EXISTS idx_tenants_account     ON tenants(account_id);
CREATE INDEX IF NOT EXISTS idx_tenancies_account   ON tenancies(account_id);
CREATE INDEX IF NOT EXISTS idx_maint_account       ON maintenance_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_compliance_account  ON compliance_items(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_account         ON transactions(account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_login_events_user   ON login_events(user_id, created_at);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  migrateUsersToUsernames(db);
  db.exec(SCHEMA);
  // Columns added after the first release.
  addColumnIfMissing(db, 'compliance_items', 'provider', 'TEXT');
  // People inside a company: company_id points at the company's main login row, and
  // login_name is the person's short name they type when signing in.
  addColumnIfMissing(db, 'users', 'company_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumnIfMissing(db, 'users', 'login_name', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)');
  // Every login needs a name, including each company's main login: their own first name.
  const unnamed = db.prepare("SELECT id, name FROM users WHERE company_id IS NULL AND is_admin = 0 AND (login_name IS NULL OR login_name = 'main')").all();
  for (const u of unnamed) db.prepare('UPDATE users SET login_name = ? WHERE id = ?').run(signInNameFrom(u.name), u.id);
  // Two-step login (authenticator app codes).
  addColumnIfMissing(db, 'users', 'totp_secret', 'TEXT');
  addColumnIfMissing(db, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT -1');
  addColumnIfMissing(db, 'users', 'totp_recovery', 'TEXT');
  addColumnIfMissing(db, 'users', 'phone', 'TEXT');
  addColumnIfMissing(db, 'users', 'address', 'TEXT');
  addColumnIfMissing(db, 'properties', 'council_id', 'INTEGER REFERENCES councils(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'properties', 'council_tax_band', 'TEXT');
  addColumnIfMissing(db, 'properties', 'council_tax_account', 'TEXT');
  addColumnIfMissing(db, 'properties', 'council_tax_payer', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'code', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'statement_type', "TEXT NOT NULL DEFAULT 'Email'");
  addColumnIfMissing(db, 'sessions', 'last_seen_at', 'TEXT');
  addColumnIfMissing(db, 'users', 'hidden_tabs', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_account_name', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_sort_code', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_account_number', 'TEXT');
  addColumnIfMissing(db, 'council_rec_notes', 'owed_pence', 'INTEGER');
  addColumnIfMissing(db, 'council_rec_notes', 'received_pence', 'INTEGER');
  addColumnIfMissing(db, 'monthly_statements', 'emailed_at', 'TEXT');
  addColumnIfMissing(db, 'monthly_statements', 'emailed_to', 'TEXT');
  addColumnIfMissing(db, 'login_challenges', 'next_url', 'TEXT');
  return db;
}

function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// A person's short name within their company (no dots, so it can't clash with usernames).
const LOGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;

// Case is kept and must be typed exactly at sign-in; uniqueness ignores case.
// A sign-in name made from someone's name: their first name, letters and digits only.
function signInNameFrom(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30);
  return LOGIN_NAME_RE.test(first) ? first : 'User';
}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/;

// Turn any string into a valid username that `isTaken` says is free.
function uniqueUsername(seed, isTaken) {
  let base = String(seed || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 24);
  if (base.length < 3) base = (base + 'user').slice(0, 24);
  const exists = (u) => !!isTaken(u);
  let name = base;
  for (let i = 2; exists(name); i++) name = `${base}${i}`;
  return name;
}

// Databases created before usernames existed: rebuild the users table with a username
// column (generated from each email address) and email made optional.
function migrateUsersToUsernames(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (!cols.length || cols.includes('username')) return;
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const taken = new Set();
  db.exec('PRAGMA foreign_keys = OFF');
  transaction(db, () => {
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, agency_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT, login_count INTEGER NOT NULL DEFAULT 0)`);
    const ins = db.prepare(`INSERT INTO users_new (id, username, email, name, agency_name, password_hash, is_admin, status, created_at, last_login_at, login_count)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const u of users) {
      const username = u.is_admin ? 'admin' : String(u.email).split('@')[0];
      const unique = uniqueUsername(username, (n) => taken.has(n));
      taken.add(unique);
      ins.run(u.id, unique, u.email, u.name, u.agency_name,
        u.password_hash, u.is_admin, u.status, u.created_at, u.last_login_at, u.login_count);
    }
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  });
  db.exec('PRAGMA foreign_keys = ON');
}

// Run fn inside a transaction, rolling back if it throws.
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction, uniqueUsername, signInNameFrom, USERNAME_RE, LOGIN_NAME_RE };
