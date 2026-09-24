'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createApp, loadConfig, ensureAdmin } = require('../src/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
const config = {
  ...loadConfig({}),
  dbFile: ':memory:',
  uploadDir: path.join(tmp, 'uploads'),
  backupDir: path.join(tmp, 'backups'),
  backupKeep: 3,
  registrationsPerHour: 1000,
  allowRegistration: true, // most tests create accounts through the sign-up page
  adminEmail: 'owner@example.com',
  adminPassword: 'owner-password-123',
};
const db = openDatabase(':memory:');
ensureAdmin(db, config, () => {});
let base;
// Stand-in for the Claude call, swapped per test.
let fakeWriter = async (facts) => ({ text: `${facts.landlord}: rent ${facts.rent_received}, net ${facts.net_for_month}.`, model: 'test-model' });
let server;

test.before(async () => {
  server = createApp(config, db, { writer: (facts) => fakeWriter(facts) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Minimal browser: keeps the session cookie and the CSRF token from the last page.
class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, { multipart } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (body && multipart) {
      payload = new FormData();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...body })) payload.append(k, v);
    } else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams({ _csrf: this.csrf, ...body }).toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, body, opts) { return this.req('POST', url, body, opts); }
  async login(login, password) {
    const r = await this.post('/login', { login, password });
    if (r.location) await this.get(r.location);
    return r;
  }
}

const usernameFor = (email) => email.split('@')[0].replace(/[^a-z0-9._-]/g, '');

async function registerAndLogin(email, agency) {
  const c = new Client();
  const r = await c.post('/register', { username: usernameFor(email), name: 'Test User', agency_name: agency, email, password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 302, r.text);
  assert.match(r.location, /^\/app/, 'new accounts are signed in straight away');
  await c.get(r.location);
  return c;
}

const idFrom = (location) => Number(location.split('/').pop());

test('public pages and protected areas', async () => {
  const c = new Client();
  const home = await c.get('/');
  assert.equal(home.location, '/login', 'the front page is the sign-in page');
  assert.equal((await c.get('/login')).status, 200);
  assert.match((await c.get('/login')).text, /rel="icon" href="\/static\/favicon\.svg"/);
  assert.equal((await c.get('/favicon.ico')).location, '/static/favicon-32.png');
  const icon = await fetch(base + '/static/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal((await c.get('/app')).location, '/login');
  assert.equal((await c.get('/admin')).location, '/login');
});

test('registration validates input and never grants admin', async () => {
  const c = new Client();
  let r = await c.post('/register', { name: '', agency_name: 'X', email: 'bad', password: 'short', password_confirm: 'x' });
  assert.equal(r.status, 422);
  r = await c.post('/register', { username: 'imposter', name: 'Imposter', agency_name: 'X', email: 'owner@example.com', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 422, 'the admin email is reserved');
  r = await c.post('/register', { username: 'admin', name: 'Imposter', agency_name: 'X', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 422, 'the admin username is reserved');
  assert.match(r.text, /username is taken/);
  const agent = await registerAndLogin('agent-reg@example.com', 'Reg Lettings');
  assert.equal((await agent.get('/admin')).status, 404, 'non-admins cannot see the admin panel');
  assert.doesNotMatch((await agent.get('/app')).text, /Admin panel/);
});

test('wrong password is rejected and logged', async () => {
  const c = new Client();
  const r = await c.post('/login', { login: 'admin', password: 'nope' });
  assert.equal(r.status, 401);
  const ev = db.prepare('SELECT * FROM login_events WHERE email = ? AND success = 0').get('admin');
  assert.ok(ev);
});

test('POST without CSRF token is refused', async () => {
  const c = await registerAndLogin('csrf@example.com', 'CSRF Lets');
  c.csrf = 'wrong';
  const r = await c.post('/app/landlords', { name: 'Should not save' });
  assert.equal(r.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM landlords WHERE name = 'Should not save'").get().n, 0);
});

test('full lettings workflow: landlord → property → tenant → rent → fee → statement', async () => {
  const c = await registerAndLogin('agent1@example.com', 'Agent One Lettings');

  let r = await c.post('/app/landlords', { name: 'Jane Landlord', email: 'jane@example.com', phone: '07700 900000' });
  assert.equal(r.status, 302, r.text);
  const landlordId = idFrom(r.location);

  // "Add property" from the landlord page pre-selects the landlord.
  r = await c.get(`/app/properties/new?landlord_id=${landlordId}`);
  assert.match(r.text, new RegExp(`<option value="${landlordId}" selected>`));
  r = await c.post('/app/properties', { address_line1: '1 High Street', town: 'Leeds', postcode: 'LS1 1AA', landlord_id: landlordId, status: 'vacant', management_fee_pct: '10' });
  assert.equal(r.status, 302, r.text);
  const propertyId = idFrom(r.location);

  r = await c.get(`/app/landlords/${landlordId}`);
  assert.match(r.text, /Properties owned/);
  assert.match(r.text, /1 High Street/);

  // Add a brand-new tenant to the property with a booking date.
  r = await c.get(`/app/properties/${propertyId}/add-tenant`);
  assert.equal(r.status, 200);
  r = await c.post(`/app/properties/${propertyId}/add-tenant`, {
    tenant_mode: 'new', name: 'Tom Tenant', email: 'tom@example.com', phone: '',
    booking_date: '2026-08-20', start_date: '2026-09-01', end_date: '2027-08-31',
    rent_pence: '1,000.00', rent_frequency: 'monthly', deposit_pence: '1150', deposit_scheme: 'DPS', status: 'active',
  });
  assert.equal(r.status, 302, r.text);
  const tenancyId = idFrom(r.location);
  const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId);
  assert.equal(tenancy.booking_date, '2026-08-20');
  assert.equal(tenancy.rent_pence, 100000);
  assert.equal(db.prepare('SELECT status FROM properties WHERE id = ?').get(propertyId).status, 'let');

  // Missing booking date is rejected.
  r = await c.post(`/app/properties/${propertyId}/add-tenant`, { tenant_mode: 'new', name: 'X', start_date: '2026-09-01', rent_pence: '1', rent_frequency: 'monthly', status: 'active', booking_date: '' });
  assert.equal(r.status, 422);

  // Existing-tenant mode.
  const tenantId = tenancy.tenant_id;
  r = await c.post(`/app/properties/${propertyId}/add-tenant`, { tenant_mode: 'existing', tenant_id: tenantId, booking_date: '2026-09-01', start_date: '2027-09-01', rent_pence: '1000', rent_frequency: 'monthly', status: 'pending' });
  assert.equal(r.status, 302, r.text);

  // Raise rent for September: one charge; running it again raises nothing.
  r = await c.post('/app/rent/raise', { month: '2026-09' });
  assert.match(decodeURIComponent(r.location), /Raised 1 rent charge/);
  r = await c.post('/app/rent/raise', { month: '2026-09' });
  assert.match(decodeURIComponent(r.location), /Raised 0 rent charges/);

  r = await c.get('/app');
  assert.match(r.text, /£1,000\.00/, 'arrears shown on dashboard');

  // Rent received: the landlord is inferred and a 10% fee is booked automatically.
  r = await c.post('/app/transactions', { txn_date: '2026-09-02', txn_type: 'rent_received', tenancy_id: tenancyId, amount_pence: '1000' });
  assert.equal(r.status, 302, r.text);
  const receipt = db.prepare("SELECT * FROM transactions WHERE txn_type = 'rent_received' AND tenancy_id = ?").get(tenancyId);
  assert.equal(receipt.landlord_id, landlordId);
  const fee = db.prepare("SELECT * FROM transactions WHERE source_txn_id = ?").get(receipt.id);
  assert.equal(fee.amount_pence, 10000);

  // Pay the landlord and check the statement balances.
  r = await c.post('/app/transactions', { txn_date: '2026-09-05', txn_type: 'landlord_payment', landlord_id: landlordId, amount_pence: '800' });
  assert.equal(r.status, 302, r.text);
  r = await c.get(`/app/statements?landlord_id=${landlordId}&from=2026-09-01&to=2026-09-30`);
  assert.match(r.text, /Closing balance[\s\S]*£100\.00/);

  r = await c.get(`/app/tenancies/${tenancyId}`);
  assert.match(r.text, /in credit/);
});

test('maintenance invoices: upload, list unpaid, pay, undo', async () => {
  const c = await registerAndLogin('agent-inv@example.com', 'Invoice Lets');
  let r = await c.post('/app/landlords', { name: 'Bob Owner' });
  const landlordId = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '9 Mill Lane', landlord_id: landlordId, status: 'let' });
  const propertyId = idFrom(r.location);
  r = await c.post('/app/maintenance', { property_id: propertyId, title: 'Boiler repair', contractor: 'Heat Ltd', priority: 'high', status: 'open', reported_date: '2026-09-01' });
  const jobId = idFrom(r.location);

  // Upload page pre-fills the job and contractor.
  r = await c.get(`/app/invoices/new?maintenance_job_id=${jobId}`);
  assert.match(r.text, /value="Heat Ltd"/);

  const pdf = new Blob([Buffer.from('%PDF-1.4\n%fake invoice\n')], { type: 'application/pdf' });
  r = await c.post('/app/invoices', { supplier: 'Heat Ltd', invoice_number: 'INV-42', amount: '240.00', due_date: '2026-01-01', maintenance_job_id: String(jobId), file: new File([pdf], 'inv-42.pdf') }, { multipart: true });
  assert.equal(r.status, 302, r.text);
  const invoiceId = idFrom(r.location);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  assert.equal(inv.property_id, propertyId, 'property taken from the job');
  assert.equal(inv.status, 'unpaid');

  // A non-PDF/image file is refused, even with a .pdf name.
  r = await c.post('/app/invoices', { supplier: 'Evil', amount: '1', file: new File([new Blob(['<script>alert(1)</script>'])], 'x.pdf') }, { multipart: true });
  assert.equal(r.status, 422);
  assert.match(r.text, /Upload a PDF/);

  // Unpaid/overdue list shows it with a Pay link; job page lists it.
  r = await c.get('/app/invoices?status=overdue');
  assert.match(r.text, /INV-42/);
  assert.match(r.text, new RegExp(`/app/invoices/${invoiceId}#pay`));
  assert.match((await c.get(`/app/maintenance/${jobId}`)).text, /INV-42/);

  // File can be viewed by its owner only, sandboxed.
  r = await c.get(`/app/invoices/${invoiceId}/file`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);

  // Pay it: marked paid, expense charged to landlord, job cost filled in.
  await c.get(`/app/invoices/${invoiceId}`);
  r = await c.post(`/app/invoices/${invoiceId}/pay`, { paid_date: '2026-09-10', payment_method: 'Bank transfer', payment_reference: 'REF1', charge_landlord: '1' });
  assert.equal(r.status, 302);
  const paid = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  assert.equal(paid.status, 'paid');
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(paid.payment_txn_id);
  assert.equal(txn.txn_type, 'expense');
  assert.equal(txn.landlord_id, landlordId);
  assert.equal(txn.amount_pence, 24000);
  assert.equal(db.prepare('SELECT cost_pence FROM maintenance_jobs WHERE id = ?').get(jobId).cost_pence, 24000);

  // Can't pay twice or delete a paid invoice.
  r = await c.post(`/app/invoices/${invoiceId}/pay`, { paid_date: '2026-09-10', payment_method: 'Card' });
  assert.match(decodeURIComponent(r.location), /already paid/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE txn_type = 'expense' AND account_id = ?").get(inv.account_id).n, 1);

  // Undo payment removes the charge.
  r = await c.post(`/app/invoices/${invoiceId}/unpay`, {});
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceId).status, 'unpaid');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id = ?').get(txn.id).n, 0);
});

test('agencies cannot see or touch each other\'s data', async () => {
  const a = await registerAndLogin('iso-a@example.com', 'Agency A');
  const b = await registerAndLogin('iso-b@example.com', 'Agency B');
  let r = await a.post('/app/landlords', { name: 'Secret Landlord' });
  const landlordId = idFrom(r.location);
  r = await a.post('/app/properties', { address_line1: 'A Street', status: 'vacant' });
  const propertyId = idFrom(r.location);
  const pdf = new File([new Blob([Buffer.from('%PDF-1.4 x')])], 'a.pdf');
  r = await a.post('/app/invoices', { supplier: 'S', amount: '5', property_id: String(propertyId), file: pdf }, { multipart: true });
  const invoiceId = idFrom(r.location);

  assert.equal((await b.get(`/app/landlords/${landlordId}`)).status, 404);
  assert.doesNotMatch((await b.get('/app/landlords')).text, /Secret Landlord/);
  assert.equal((await b.get(`/app/invoices/${invoiceId}`)).status, 404);
  assert.equal((await b.get(`/app/invoices/${invoiceId}/file`)).status, 404);
  await b.get('/app');
  assert.equal((await b.post(`/app/landlords/${landlordId}/delete`, {})).status, 404);
  assert.equal((await b.post(`/app/invoices/${invoiceId}/pay`, { paid_date: '2026-09-10', payment_method: 'Card' })).status, 404);
  // B can't link its records to A's property.
  r = await b.post('/app/maintenance', { property_id: propertyId, title: 'x', priority: 'low', status: 'open' });
  assert.equal(r.status, 422);
  assert.ok(db.prepare('SELECT 1 FROM landlords WHERE id = ?').get(landlordId));
});

test('admin panel: lists all users, suspend, reactivate, delete', async () => {
  const victim = await registerAndLogin('suspend-me@example.com', 'Suspended Lets');
  const admin = new Client();
  const l = await admin.login('admin', 'owner-password-123');
  assert.equal(l.location, '/admin');

  let r = await admin.get('/admin');
  assert.equal(r.status, 200);
  // The admin's menu only has the owner pages.
  const rail = r.text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(rail, /aria-label="Dashboard"/, 'the logo button is the dashboard link');
  assert.match(r.text, /class="rail-btn brand-btn[^"]*" href="\/app"[^>]*aria-label="Dashboard"/);
  assert.match(rail, /aria-label="Admin panel"/);
  assert.match(rail, /aria-label="Backups"/);
  assert.doesNotMatch(rail, /aria-label="Landlords"|aria-label="Invoices"|aria-label="Transactions"/);
  for (const email of ['agent1@example.com', 'agent-inv@example.com', 'suspend-me@example.com']) assert.match(r.text, new RegExp(email));

  const u = db.prepare('SELECT id FROM users WHERE email = ?').get('suspend-me@example.com');
  await admin.get(`/admin/users/${u.id}`);
  await admin.post(`/admin/users/${u.id}/suspend`, {});
  assert.equal((await victim.get('/app')).location, '/login', 'suspended user is signed out');
  assert.equal((await victim.post('/login', { login: 'suspend-me', password: 'password-1234' })).status, 403);

  await admin.post(`/admin/users/${u.id}/activate`, {});
  assert.equal((await victim.login('suspend-me', 'password-1234')).location, '/app');

  const csv = await admin.get('/admin/users.csv');
  assert.match(csv.text, /suspend-me@example.com/);

  // Admin can't delete themselves; deleting another user needs their username typed.
  const me = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@example.com');
  await admin.post(`/admin/users/${me.id}/delete`, { confirm_username: 'admin' });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(me.id));
  await admin.post(`/admin/users/${u.id}/delete`, { confirm_username: 'wrong' });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id));
  await admin.post(`/admin/users/${u.id}/delete`, { confirm_username: 'suspend-me' });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id), undefined);
});

test('only ADMIN_EMAIL keeps admin rights on restart', () => {
  db.prepare("UPDATE users SET is_admin = 1 WHERE email = 'agent1@example.com'").run();
  ensureAdmin(db, config, () => {});
  const admins = db.prepare('SELECT email FROM users WHERE is_admin = 1').all().map((r) => r.email);
  assert.deepEqual(admins, ['owner@example.com']);
});

test('edits autosave: background save returns JSON, invalid values are reported', async () => {
  const c = await registerAndLogin('autosave@example.com', 'Autosave Lets');
  let r = await c.post('/app/landlords', { name: 'Before' });
  const id = idFrom(r.location);
  await c.get(`/app/landlords/${id}/edit`);
  const post = (body) => fetch(`${base}/app/landlords/${id}`, {
    method: 'POST',
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, ...body }).toString(),
  });
  r = await post({ name: 'After', email: '' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(db.prepare('SELECT name FROM landlords WHERE id = ?').get(id).name, 'After');
  r = await post({ name: 'After', email: 'not-an-email' });
  assert.equal(r.status, 422);
  assert.ok((await r.json()).errors.email);
  assert.equal(db.prepare('SELECT email FROM landlords WHERE id = ?').get(id).email, null);
});

async function monthlySetup(email) {
  const c = await registerAndLogin(email, 'Monthly Lets');
  let r = await c.post('/app/landlords', { name: 'Mary Owner' });
  const landlordId = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '5 Oak Road', landlord_id: landlordId, status: 'vacant', management_fee_pct: '12' });
  const propertyId = idFrom(r.location);
  r = await c.post(`/app/properties/${propertyId}/add-tenant`, { tenant_mode: 'new', name: 'Tia', booking_date: '2026-07-20', start_date: '2026-08-01', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const tenancyId = idFrom(r.location);
  await c.get('/app');
  await c.post('/app/rent/raise', { month: '2026-08' });
  await c.post('/app/transactions', { txn_date: '2026-08-03', txn_type: 'rent_received', tenancy_id: tenancyId, amount_pence: '900' });
  await c.post('/app/transactions', { txn_date: '2026-08-15', txn_type: 'expense', property_id: propertyId, description: 'Locksmith', amount_pence: '60' });
  return { c, landlordId };
}

test('monthly statements: figures, AI summary, fabricated-number guard, fallback', async () => {
  const { c, landlordId } = await monthlySetup('monthly@example.com');
  await c.get('/app/monthly?month=2026-08');

  let r = await c.post('/app/monthly/generate', { month: '2026-08', landlord_id: String(landlordId) });
  assert.equal(r.status, 302);
  let s = db.prepare('SELECT * FROM monthly_statements WHERE landlord_id = ?').get(landlordId);
  assert.equal(s.rent_pence, 90000);
  assert.equal(s.fees_pence, 10800); // 12% of £900
  assert.equal(s.expenses_pence, 6000);
  assert.equal(s.net_pence, 90000 - 10800 - 6000);
  assert.equal(s.summary_source, 'ai');
  assert.match(s.summary, /£900\.00/);
  r = await c.get(r.location);
  assert.match(r.text, /Mary Owner/);
  assert.match(r.text, /Locksmith/);
  assert.match(r.text, /£732\.00/);

  // An AI summary quoting a number that isn't on the statement is thrown away.
  fakeWriter = async () => ({ text: 'You earned £5,000.00 this month.', model: 'test-model' });
  await c.post('/app/monthly/generate', { month: '2026-08', landlord_id: String(landlordId) });
  s = db.prepare('SELECT * FROM monthly_statements WHERE landlord_id = ?').get(landlordId);
  assert.equal(s.summary_source, 'template');
  assert.match(s.note, /£5,000\.00/);
  assert.match(s.summary, /£900\.00/);

  // AI failure falls back to the standard summary rather than erroring.
  fakeWriter = async () => { throw new Error('API down'); };
  r = await c.post('/app/monthly/generate', { month: '2026-08' });
  assert.match(decodeURIComponent(r.location), /Generated 1 statement/);
  s = db.prepare('SELECT * FROM monthly_statements WHERE landlord_id = ?').get(landlordId);
  assert.equal(s.summary_source, 'template');
  fakeWriter = async (facts) => ({ text: `Net ${facts.net_for_month}.`, model: 'test-model' });
});

test('monthly job fills in last month only where missing', async () => {
  const { runMonthlyJob } = require('../src/statements');
  const { landlordId } = await monthlySetup('monthly-job@example.com');
  const n = await runMonthlyJob(db, async (f) => ({ text: `Net ${f.net_for_month}.`, model: 'm' }), { today: '2026-09-02', log: () => {} });
  assert.ok(n >= 1);
  assert.ok(db.prepare("SELECT 1 FROM monthly_statements WHERE landlord_id = ? AND month = '2026-08'").get(landlordId));
  assert.equal(await runMonthlyJob(db, null, { today: '2026-09-02', log: () => {} }), 0, 'second run has nothing to do');
});

test('agency data export', async () => {
  const c = await registerAndLogin('export@example.com', 'Export Lets');
  await c.post('/app/landlords', { name: 'Exported Landlord' });
  const r = await c.get('/app/export');
  const data = JSON.parse(r.text);
  assert.equal(data.account.email, 'export@example.com');
  assert.equal(data.landlords.length, 1);
  assert.equal(data.account.password_hash, undefined);
});

test('backups: admin creates, downloads, prunes; archive restores', async () => {
  const { execFileSync } = require('node:child_process');
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const agent = await registerAndLogin('no-backups@example.com', 'Nope Lets');
  assert.equal((await agent.get('/admin/backups')).status, 404);

  await admin.get('/admin/backups');
  for (let i = 0; i < 4; i++) {
    const r = await admin.post('/admin/backups', {});
    assert.match(decodeURIComponent(r.location), /Backup created/);
  }
  const page = await admin.get('/admin/backups');
  const names = [...page.text.matchAll(/<code>(nexus-backup-[^<]+)<\/code>/g)].map((m) => m[1]);
  assert.equal(names.length, 3, 'old backups pruned to BACKUP_KEEP');

  const dl = await fetch(`${base}/admin/backups/${names[0]}`, { headers: { cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  assert.equal((await fetch(`${base}/admin/backups/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie: admin.cookie } })).status, 404);

  // The archive opens with standard tar and contains the database and uploaded invoices.
  const file = path.join(config.backupDir, names[0]);
  const listing = execFileSync('tar', ['-tzf', file]).toString();
  assert.match(listing, /manifest\.json/);
  assert.match(listing, /nexus\.db/);
  assert.match(listing, /uploads\/\d+\/[0-9a-f]{32}\.pdf/);

  // Restore into a fresh data directory and check the data is there.
  const target = path.join(tmp, 'restored');
  const env = { ...process.env, DATABASE_FILE: path.join(target, 'letwise.db'), UPLOAD_DIR: path.join(target, 'uploads') };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore-backup.js', file], { env, cwd: path.join(__dirname, '..') });
  const restored = openDatabase(path.join(target, 'letwise.db'));
  assert.ok(restored.prepare("SELECT 1 FROM users WHERE email = 'agent1@example.com'").get());
  assert.ok(restored.prepare("SELECT 1 FROM landlords WHERE name = 'Jane Landlord'").get());
  const inv = restored.prepare('SELECT * FROM invoices WHERE file_name IS NOT NULL LIMIT 1').get();
  assert.ok(fs.existsSync(path.join(target, 'uploads', String(inv.account_id), inv.file_name)));
  restored.close();
});

test('create account with a username and password (email optional)', async () => {
  const c = new Client();
  let r = await c.get('/register');
  assert.match(r.text, /name="username"/);

  r = await c.post('/register', { username: 'harbour.lets', name: 'Sam', agency_name: 'Harbour', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 302, r.text);
  assert.match(r.location, /^\/app/, 'signed in straight away');
  r = await c.get(r.location);
  assert.match(r.text, /Welcome to Nexus/);
  assert.match(r.text, /@harbour\.lets/);
  const u = db.prepare("SELECT * FROM users WHERE username = 'harbour.lets'").get();
  assert.equal(u.email, null);
  assert.equal(u.is_admin, 0);

  // Same username (any capitalisation) can't be taken twice; bad usernames are rejected.
  const other = new Client();
  r = await other.post('/register', { username: 'Harbour.Lets', name: 'X', agency_name: 'X', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 422);
  r = await other.post('/register', { username: 'a b', name: 'X', agency_name: 'X', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal(r.status, 422);

  // Sign in by username (case-insensitive); admin can also sign in by username.
  const again = new Client();
  assert.equal((await again.login('HARBOUR.LETS', 'password-1234')).location, '/app');
  assert.equal((await new Client().login('admin', 'owner-password-123')).location, '/admin');
  assert.equal((await new Client().post('/login', { login: 'harbour.lets', password: 'wrong-password' })).status, 401);
  // Email addresses aren't accepted as a login, only usernames.
  const withEmail = new Client();
  await withEmail.post('/register', { username: 'mailtest', name: 'M', agency_name: 'M', email: 'mail@test.com', password: 'password-1234', password_confirm: 'password-1234' });
  assert.equal((await new Client().post('/login', { login: 'mail@test.com', password: 'password-1234' })).status, 401);
  assert.equal((await new Client().login('mailtest', 'password-1234')).location, '/app');
  assert.match((await new Client().get('/login')).text, />Username <input/);
});

test('older databases get usernames when upgraded', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(tmp, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    agency_name TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT, login_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE landlords (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
    email TEXT, phone TEXT, address TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (email, name, agency_name, password_hash, is_admin) VALUES ('boss@x.com', 'B', 'X', 'h', 1), ('jo@a.com', 'J', 'A', 'h', 0), ('jo@b.com', 'J2', 'B', 'h', 0);
    INSERT INTO landlords (account_id, name) VALUES (2, 'Kept landlord');`);
  old.close();
  const db2 = openDatabase(file);
  const users = db2.prepare('SELECT id, username, email FROM users ORDER BY id').all();
  assert.deepEqual(users.map((u) => u.username), ['admin', 'jouser', 'jouser2'], 'short names padded to the 3-character minimum, clashes numbered');
  assert.equal(db2.prepare('SELECT account_id FROM landlords').get().account_id, 2, 'linked data kept');
  db2.close();
});

test('sign-up is closed by default: only the admin adds accounts', async () => {
  assert.equal(loadConfig({}).allowRegistration, false);
  const closedDb = openDatabase(':memory:');
  const closed = createApp({ ...config, allowRegistration: false }, closedDb).listen(0);
  await new Promise((r) => closed.once('listening', r));
  const url = `http://127.0.0.1:${closed.address().port}`;
  try {
    const page = await (await fetch(`${url}/login`)).text();
    assert.doesNotMatch(page, /Create an account/);
    const r = await fetch(`${url}/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'sneaky', name: 'S', agency_name: 'S', password: 'password-1234', password_confirm: 'password-1234' }).toString() });
    assert.equal(r.status, 403);
    assert.equal(closedDb.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally { closed.close(); }
});

test('admin adds an account and resets passwords', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  let r = await admin.get('/admin/users/new');
  assert.equal(r.status, 200);
  r = await admin.post('/admin/users', { agency_name: 'Coastal Homes', name: 'Pat Lee', username: 'coastal', password: 'short' });
  assert.equal(r.status, 422);
  r = await admin.post('/admin/users', { agency_name: 'Coastal Homes', name: 'Pat Lee', username: 'Coastal', password: 'sea-view-2026' });
  assert.equal(r.status, 302);
  assert.match(r.location, /\/admin\/users\/\d+\?created=1/);
  const id = Number(r.location.match(/users\/(\d+)/)[1]);
  const coastal = new Client();
  assert.equal((await coastal.login('coastal', 'sea-view-2026')).location, '/app');
  assert.match((await coastal.get('/app')).text, /Coastal Homes/);

  // Non-admins can't add accounts.
  assert.equal((await coastal.post('/admin/users', { agency_name: 'X', name: 'X', username: 'xx1', password: 'password-1234' })).status, 404);

  // Reset: old password stops working, they're signed out, new one works.
  await admin.get(`/admin/users/${id}`);
  r = await admin.post(`/admin/users/${id}/password`, { password: 'new-pass-2027' });
  assert.match(decodeURIComponent(r.location), /Password changed/);
  assert.equal((await coastal.get('/app')).location, '/login');
  assert.equal((await new Client().post('/login', { login: 'coastal', password: 'sea-view-2026' })).status, 401);
  assert.equal((await new Client().login('coastal', 'new-pass-2027')).location, '/app');
});

test('admin account is set by username, and its password can be reset on restart', async () => {
  const db3 = openDatabase(':memory:');
  const cfg = { ...config, adminEmail: '', adminUsername: 'tpas2', adminPassword: 'Sample-6x' };
  ensureAdmin(db3, cfg, () => {});
  const row = db3.prepare('SELECT * FROM users WHERE is_admin = 1').get();
  assert.equal(row.username, 'tpas2');
  const { verifyPassword } = require('../src/auth');
  assert.ok(verifyPassword('Sample-6x', row.password_hash));
  // Restarting with a different password changes nothing unless a reset is asked for.
  ensureAdmin(db3, { ...cfg, adminPassword: 'Changed99' }, () => {});
  assert.ok(verifyPassword('Sample-6x', db3.prepare('SELECT password_hash FROM users WHERE id = ?').get(row.id).password_hash));
  ensureAdmin(db3, { ...cfg, adminPassword: 'Changed99', adminPasswordReset: true }, () => {});
  assert.ok(verifyPassword('Changed99', db3.prepare('SELECT password_hash FROM users WHERE id = ?').get(row.id).password_hash));
  assert.throws(() => ensureAdmin(openDatabase(':memory:'), { ...cfg, adminPassword: 'abc' }, () => {}), /at least 6/);
});
