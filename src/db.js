'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT COLLATE NOCASE,                 -- optional contact address (several accounts may share one)
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
-- Site-wide settings the admin can change (e.g. how often backups run).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Ready-made details for the Metro form (rent run step 5): fill the boxes in one click.
CREATE TABLE IF NOT EXISTS metro_presets (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every change to a landlord's bank details (a common fraud: redirecting their rent). Shown as a
-- warning until someone confirms the new details with the landlord.
CREATE TABLE IF NOT EXISTS landlord_bank_changes (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id   INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  old_name      TEXT, old_sort_code TEXT, old_account TEXT,
  new_name      TEXT, new_sort_code TEXT, new_account TEXT,
  checked_at    TEXT,
  checked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_changes ON landlord_bank_changes(account_id, landlord_id, checked_at);

-- Each Metro payment instruction created in the rent run (step 5), kept to look back at.
CREATE TABLE IF NOT EXISTS metro_documents (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  filename    TEXT NOT NULL,
  total_pence INTEGER,
  payments    INTEGER,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  data        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metro_documents ON metro_documents(account_id, created_at);

-- Entries on a council's database (Councils → Database): Live until ended, then Previous tenant.
CREATE TABLE IF NOT EXISTS council_db_entries (
  id                  INTEGER PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  council_id          INTEGER NOT NULL REFERENCES councils(id) ON DELETE CASCADE,
  our_ref             TEXT,
  property_address    TEXT,
  scheme              TEXT,
  property_size       TEXT,
  property_reference  TEXT,
  reservation_date    TEXT,
  booking_date        TEXT,
  cancellation_date   TEXT,
  price_pence         INTEGER,
  client_name         TEXT,
  contact_number      TEXT,
  people              TEXT,
  email               TEXT,
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_council_db_entries ON council_db_entries(account_id, council_id, ended);

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

-- Contractors and suppliers. Invoices link to one, so the total paid to each is known.
CREATE TABLE IF NOT EXISTS contractors (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  trade       TEXT,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contractors_account ON contractors(account_id, name);

-- Invoices the agency raises to its landlords (fees, inspections, work arranged...). Settled either
-- by the landlord paying, or by deducting it from their rent (txn_id: the fee on their statement).
CREATE TABLE IF NOT EXISTS landlord_invoices (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id     INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id     INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  due_date        TEXT,
  description     TEXT NOT NULL,
  amount_pence    INTEGER NOT NULL,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | paid
  paid_date       TEXT,
  paid_how        TEXT,                              -- Deducted from rent | Paid by landlord
  txn_id          INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  emailed_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_landlord_invoices ON landlord_invoices(account_id, invoice_date);

-- Photos and documents on a maintenance job, kept in the database so backups include them.
CREATE TABLE IF NOT EXISTS maintenance_files (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id       INTEGER NOT NULL REFERENCES maintenance_jobs(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_files ON maintenance_files(account_id, job_id);

-- Photos of a property, kept in the database so backups include them.
CREATE TABLE IF NOT EXISTS property_photos (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_photos ON property_photos(account_id, property_id);

-- Signatures on a maintenance job sheet: the tenant's (with whether they were satisfied) and the
-- maintenance person's or contractor's, drawn on screen and kept as PNG pictures.
CREATE TABLE IF NOT EXISTS job_signatures (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id       INTEGER NOT NULL REFERENCES maintenance_jobs(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('tenant', 'contractor')),
  signer_name  TEXT,
  satisfied    TEXT,
  png          BLOB NOT NULL,
  signed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, role)
);

-- Property inspections (routine, check-in, check-out...), each with its own photos.
CREATE TABLE IF NOT EXISTS inspections (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  inspection_date  TEXT NOT NULL,
  inspection_type  TEXT NOT NULL DEFAULT 'Routine',
  condition        TEXT,
  inspected_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inspections ON inspections(account_id, property_id, inspection_date);
CREATE TABLE IF NOT EXISTS inspection_photos (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inspection_id  INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  data           BLOB NOT NULL,
  uploaded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inspection_photos ON inspection_photos(account_id, inspection_id);
-- The tenant's signature on an inspection sheet, drawn on screen.
CREATE TABLE IF NOT EXISTS inspection_signatures (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inspection_id  INTEGER NOT NULL UNIQUE REFERENCES inspections(id) ON DELETE CASCADE,
  signer_name    TEXT,
  png            BLOB NOT NULL,
  signed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scans or PDFs of a certificate (gas, EICR, EPC, insurance...), kept in the database for backups.
CREATE TABLE IF NOT EXISTS compliance_files (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_compliance_files ON compliance_files(account_id, item_id);

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
  // Who rent run emails come from, set per company on the Rent run page (blank = the defaults).
  addColumnIfMissing(db, 'users', 'statement_from_email', 'TEXT');
  addColumnIfMissing(db, 'users', 'statement_from_name', 'TEXT');
  addColumnIfMissing(db, 'users', 'statement_reply_to', 'TEXT');
  // 'light' or 'dark' from the dashboard switch; empty follows the computer's setting.
  addColumnIfMissing(db, 'users', 'theme', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_account_name', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_sort_code', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_account_number', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'bank_name', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'payment_note', 'TEXT');
  addColumnIfMissing(db, 'landlords', 'overseas', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'completed_date', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'added_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // When a landlord started with the agency. Existing landlords start from when they were added.
  const hadDateStarted = db.prepare("SELECT 1 FROM pragma_table_info('landlords') WHERE name = 'date_started'").get();
  addColumnIfMissing(db, 'landlords', 'date_started', 'TEXT');
  // When a property was taken on, and when it was handed back to the landlord (for the dashboard).
  const hadAcquired = db.prepare("SELECT 1 FROM pragma_table_info('properties') WHERE name = 'acquired_date'").get();
  addColumnIfMissing(db, 'properties', 'acquired_date', 'TEXT');
  addColumnIfMissing(db, 'properties', 'handed_back_date', 'TEXT');
  addColumnIfMissing(db, 'properties', 'lease_start_date', 'TEXT');
  addColumnIfMissing(db, 'properties', 'code', 'TEXT');
  addColumnIfMissing(db, 'properties', 'bathrooms', 'INTEGER');
  addColumnIfMissing(db, 'properties', 'parking', 'TEXT');
  addColumnIfMissing(db, 'properties', 'rent_pence', 'INTEGER');
  addColumnIfMissing(db, 'properties', 'price_per_night_pence', 'INTEGER');
  addColumnIfMissing(db, 'properties', 'landlord_rent_pence', 'INTEGER');
  addColumnIfMissing(db, 'properties', 'tenant_rent_pence', 'INTEGER');
  addColumnIfMissing(db, 'tenancies', 'paid_by', "TEXT NOT NULL DEFAULT 'Council'");
  // What the maintenance job sheet needs: the contractor's details, and a few job details.
  for (const col of ['code', 'address', 'mobile', 'fax']) addColumnIfMissing(db, 'contractors', col, 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'estimate_required', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'preferred_start_date', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'go_ahead', 'TEXT');
  // As typed on the job sheet (filled in from the contractor and landlord, but can be changed).
  for (const col of ['contractor_code', 'contractor_phone', 'contractor_mobile', 'contractor_fax', 'contractor_email', 'billing_name']) addColumnIfMissing(db, 'maintenance_jobs', col, 'TEXT');
  // An inspection's safety tick sheet (JSON of each requirement's Yes / No / N/A).
  addColumnIfMissing(db, 'inspections', 'checklist', 'TEXT');
  // On street and Off street became one parking option, Street.
  db.prepare("UPDATE properties SET parking = 'Street' WHERE parking IN ('On street', 'Off street', 'On / off street')").run();
  // Tenants: the council's reference. Tenancies: the term as booked (rent is no longer entered).
  addColumnIfMissing(db, 'tenants', 'council_ref', 'TEXT');
  addColumnIfMissing(db, 'tenancies', 'term_booked', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS property_notes (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    note_date   TEXT NOT NULL,
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_property_notes ON property_notes(account_id, property_id, note_date)');
  // Dated notes on a tenant, like a property's notes of tenant calls.
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_notes (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    note_date   TEXT NOT NULL,
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tenant_notes ON tenant_notes(account_id, tenant_id, note_date)');
  if (!hadAcquired) db.exec('UPDATE properties SET acquired_date = date(created_at) WHERE acquired_date IS NULL');
  if (!hadDateStarted) db.exec('UPDATE landlords SET date_started = date(created_at) WHERE date_started IS NULL');
  addColumnIfMissing(db, 'council_rec_notes', 'owed_pence', 'INTEGER');
  addColumnIfMissing(db, 'council_rec_notes', 'received_pence', 'INTEGER');
  addColumnIfMissing(db, 'monthly_statements', 'emailed_at', 'TEXT');
  addColumnIfMissing(db, 'monthly_statements', 'emailed_to', 'TEXT');
  addColumnIfMissing(db, 'login_challenges', 'next_url', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'added_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'invoices', 'contractor_id', 'INTEGER REFERENCES contractors(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'council_rec_notes', 'received_date', 'TEXT');
  addColumnIfMissing(db, 'council_rec_notes', 'email_sent_date', 'TEXT');
  // The landlord's maintenance invoice for a finished job: its date (set the first time it's
  // made) and when it was last emailed.
  // Contractor invoices: what the landlord is charged (blank = the same as the price to us).
  addColumnIfMissing(db, 'invoices', 'landlord_price_pence', 'INTEGER');
  // Landlord invoices paid over several months: how many, and the deductions after the first.
  addColumnIfMissing(db, 'landlord_invoices', 'months', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'landlord_invoices', 'instalment_txn_ids', 'TEXT');
  addColumnIfMissing(db, 'landlord_invoices', 'contractor_invoice_id', 'INTEGER REFERENCES invoices(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'invoices', 'charge_landlord', 'INTEGER NOT NULL DEFAULT 1');
  // The landlord it's charged to (blank: the property's landlord) and what the work is.
  addColumnIfMissing(db, 'invoices', 'landlord_id', 'INTEGER REFERENCES landlords(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'invoices', 'work_required', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'invoice_date', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'invoice_emailed_at', 'TEXT');
  addColumnIfMissing(db, 'maintenance_jobs', 'invoice_emailed_to', 'TEXT');
  // Contact for access on the job sheet, as typed (filled in from the property and its tenants).
  addColumnIfMissing(db, 'maintenance_jobs', 'access_contact', 'TEXT');
  // Every invoice supplier becomes a contractor (once), so the Contractors tab starts complete.
  for (const inv of db.prepare('SELECT id, account_id, supplier FROM invoices WHERE contractor_id IS NULL AND trim(supplier) != \'\'').all()) {
    db.prepare('UPDATE invoices SET contractor_id = ? WHERE id = ?').run(contractorFor(db, inv.account_id, inv.supplier), inv.id);
  }
  allowSharedEmails(db);
  fourDigitLandlordCodes(db);
  codeExistingProperties(db);
  addColumnIfMissing(db, 'tenancies', 'tenancy_no', 'TEXT');
  numberTenancies(db);
  addColumnIfMissing(db, 'monthly_statements', 'statement_no', 'INTEGER');
  addColumnIfMissing(db, 'users', 'last_statement_no', 'INTEGER');
  // Emails sent from the Rent run (step 5.2): who to, the subject and the files' names (not the files).
  db.exec(`CREATE TABLE IF NOT EXISTS rentrun_emails (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month      TEXT NOT NULL,
    from_addr  TEXT, to_addr TEXT NOT NULL, cc TEXT, bcc TEXT, subject TEXT NOT NULL, files TEXT,
    sent_by    INTEGER,
    sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  addColumnIfMissing(db, 'rentrun_emails', 'page', "TEXT NOT NULL DEFAULT 'rent-run'"); // or 'council-invoices'
  // Saved email boxes (From, To, Cc, Bcc, Subject, Message) to fill the email in one click.
  db.exec(`CREATE TABLE IF NOT EXISTS email_presets (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page       TEXT NOT NULL,
    name       TEXT NOT NULL,
    data_json  TEXT NOT NULL,
    UNIQUE (account_id, page, name)
  )`);
  // Months the automatic statement job has already done for each company, so statements deleted
  // afterwards aren't made again. Companies already using statements count last month as done.
  db.exec(`CREATE TABLE IF NOT EXISTS statement_auto_runs (
    account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month      TEXT NOT NULL,
    ran_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, month)
  )`);
  if (!db.prepare('SELECT 1 FROM statement_auto_runs LIMIT 1').get()) {
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    db.prepare('INSERT OR IGNORE INTO statement_auto_runs (account_id, month) SELECT DISTINCT account_id, ? FROM monthly_statements').run(last);
  }
  numberStatements(db);
  return db;
}

// The contractor with this name (ignoring capitals and spaces at the ends), added if new.
function contractorFor(db, accountId, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const found = db.prepare('SELECT id FROM contractors WHERE account_id = ? AND lower(name) = lower(?)').get(accountId, clean);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO contractors (account_id, name) VALUES (?, ?)').run(accountId, clean).lastInsertRowid);
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

// Any characters (spaces included), up to 60, not starting or ending with a space.
const USERNAME_RE = /^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]{0,58}[^\s\x00-\x1f\x7f])?$/;

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

// Emails used to be unique per account; now several accounts may share one. SQLite can't
// drop a column constraint, so the users table is rebuilt (same columns and rows) once.
function allowSharedEmails(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || !/\bemail\s+TEXT\s+UNIQUE\b/i.test(row.sql)) return;
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys = OFF');
  transaction(db, () => {
    db.exec(row.sql.replace(/CREATE TABLE\s+("?users"?)/i, 'CREATE TABLE users_new').replace(/\bemail\s+TEXT\s+UNIQUE\b/i, 'email TEXT'));
    db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    for (const ix of indexes) db.exec(ix.sql);
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

// One-off (runs once, then is remembered): landlord codes written as the letter L and up to three
// digits (L1, L001, l12) become L0001, L0001... in four-digit style. Any other style of code, and
// any code whose new form is already taken, is left exactly as it is.
function fourDigitLandlordCodes(db) {
  const KEY = 'landlord_codes_four_digits';
  if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(KEY)) return;
  const taken = new Set(db.prepare("SELECT account_id || ':' || code AS k FROM landlords WHERE code IS NOT NULL").all().map((r) => r.k));
  let changed = 0;
  transaction(db, () => {
    for (const l of db.prepare("SELECT id, account_id, code FROM landlords WHERE code IS NOT NULL ORDER BY id").all()) {
      const m = /^[Ll](\d{1,3})$/.exec(String(l.code).trim());
      if (!m) continue;
      const next = `L${String(Number(m[1])).padStart(4, '0')}`;
      if (next === l.code || taken.has(`${l.account_id}:${next}`)) continue;
      db.prepare('UPDATE landlords SET code = ? WHERE id = ?').run(next, l.id);
      taken.delete(`${l.account_id}:${l.code}`);
      taken.add(`${l.account_id}:${next}`);
      changed += 1;
    }
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(KEY, new Date().toISOString());
  });
  if (changed) console.log(`Landlord codes: ${changed} changed to the four-digit style.`);
}

// One-off (runs once, then is remembered): properties added before property codes existed are
// given one, P0001 onwards in the order they were added, carrying on after any code already used.
function codeExistingProperties(db) {
  const KEY = 'property_codes_filled';
  if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(KEY)) return;
  let filled = 0;
  transaction(db, () => {
    const accounts = db.prepare("SELECT DISTINCT account_id FROM properties WHERE code IS NULL OR trim(code) = ''").all();
    for (const { account_id: a } of accounts) {
      const used = new Set(db.prepare("SELECT code FROM properties WHERE account_id = ? AND code IS NOT NULL AND trim(code) != ''").all(a).map((r) => r.code));
      let n = 0;
      for (const code of used) { const m = /^P(\d+)$/.exec(code); if (m) n = Math.max(n, Number(m[1])); }
      for (const p of db.prepare("SELECT id FROM properties WHERE account_id = ? AND (code IS NULL OR trim(code) = '') ORDER BY id").all(a)) {
        let code;
        do { n += 1; code = `P${String(n).padStart(4, '0')}`; } while (used.has(code));
        used.add(code);
        db.prepare('UPDATE properties SET code = ? WHERE id = ?').run(code, p.id);
        filled += 1;
      }
    }
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
  });
  if (filled) console.log(`Property codes: ${filled} existing propert${filled === 1 ? 'y' : 'ies'} given a code.`);
}

// Tenancy numbers (T0001, T0002...), per company, in the order the tenancies were added. Any
// tenancy without one gets the next number after the company's highest.
// Statement numbers 1, 2, 3… per company, in the order statements were first made. A
// regenerated statement keeps its number.
function numberStatements(db, accountId = null) {
  const accounts = accountId ? [{ account_id: accountId }]
    : db.prepare('SELECT DISTINCT account_id FROM monthly_statements WHERE statement_no IS NULL').all();
  for (const { account_id: a } of accounts) {
    // Carries on from the highest number ever given, so a deleted statement's number isn't reused.
    let n = Math.max(db.prepare('SELECT COALESCE(MAX(statement_no), 0) AS n FROM monthly_statements WHERE account_id = ?').get(a).n,
      (db.prepare('SELECT last_statement_no AS n FROM users WHERE id = ?').get(a) || {}).n || 0);
    const set = db.prepare('UPDATE monthly_statements SET statement_no = ? WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM monthly_statements WHERE account_id = ? AND statement_no IS NULL ORDER BY id').all(a)) set.run(++n, id);
    db.prepare('UPDATE users SET last_statement_no = ? WHERE id = ?').run(n, a);
  }
}

function numberTenancies(db, accountId = null) {
  const accounts = accountId ? [{ account_id: accountId }]
    : db.prepare("SELECT DISTINCT account_id FROM tenancies WHERE tenancy_no IS NULL OR trim(tenancy_no) = ''").all();
  for (const { account_id: a } of accounts) {
    const missing = db.prepare("SELECT id FROM tenancies WHERE account_id = ? AND (tenancy_no IS NULL OR trim(tenancy_no) = '') ORDER BY id").all(a);
    if (!missing.length) continue;
    let n = 0;
    for (const { tenancy_no: t } of db.prepare("SELECT tenancy_no FROM tenancies WHERE account_id = ? AND tenancy_no IS NOT NULL").all(a)) {
      const m = /^T(\d+)$/.exec(String(t || '').trim());
      if (m) n = Math.max(n, Number(m[1]));
    }
    const set = db.prepare('UPDATE tenancies SET tenancy_no = ? WHERE id = ?');
    for (const { id } of missing) { n += 1; set.run(`T${String(n).padStart(4, '0')}`, id); }
  }
}

module.exports = { numberStatements, numberTenancies, contractorFor, openDatabase, transaction, uniqueUsername, signInNameFrom, USERNAME_RE, LOGIN_NAME_RE };
