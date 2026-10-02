'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createApp, loadConfig, ensureAdmin } = require('../src/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-test-'));
const config = {
  ...loadConfig({}),
  dbFile: ':memory:',
  uploadDir: path.join(tmp, 'uploads'),
  backupDir: path.join(tmp, 'backups'),
  backupKeep: 3,
  registrationsPerHour: 1000,
  loginAttemptsPer15Min: 1000,
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
// Stand-in for sending email: records messages; addresses containing "bounce" fail.
const sentMail = [];
let mailEnabled = true;
const fakeMailer = {
  get enabled() { return mailEnabled; },
  async send(msg) {
    if (msg.to.includes('bounce')) throw new Error('Mailbox unavailable');
    sentMail.push(msg);
  },
};

test.before(async () => {
  server = createApp(config, db, { writer: (facts) => fakeWriter(facts), mailer: fakeMailer }).listen(0);
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
      // Lists are sent as repeated fields, the way a browser sends ticked checkboxes.
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...body })) [].concat(v).forEach((x) => params.append(k, x));
      payload = params.toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    // Keep a small cookie jar: a response can set or clear several cookies.
    this.jar = this.jar || {};
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (!value || attrs.some((a) => /max-age=0/i.test(a))) delete this.jar[name];
      else this.jar[name] = value;
    }
    this.cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, buf, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, body, opts) { return this.req('POST', url, body, opts); }
  // Every sign-in needs a name: 'Theo' for the admin; companies created in these tests have a
  // contact called "Test User", so they sign in as 'Test' (their first name).
  async login(login, password, member = login === 'admin' ? 'Theo' : 'Test') {
    const r = await this.post('/login', { login, member, password });
    if (r.location) await this.get(r.location);
    return r;
  }
}

const usernameFor = (email) => email.split('@')[0].replace(/[^a-z0-9._-]/g, '');

async function registerAndLogin(email, agency) {
  const c = new Client();
  const r = await c.post('/register', { username: usernameFor(email), name: 'Test User', agency_name: agency, email, password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 302, r.text);
  assert.match(r.location, /^\/app/, 'new accounts are signed in straight away');
  await c.get(r.location);
  return c;
}

const idFrom = (location) => Number(location.split('/').pop());

// Contractor invoices need every field; tests fill in what they don't care about
// (a note, a date, and a maintenance job on the given property, or on a new one).
let jobHouse = 0;
async function invoiceBody(client, fields) {
  const f = { invoice_date: '2026-08-01', description: 'Test invoice', charge_landlord: 'yes', landlord_amount: fields.amount, ...fields };
  if (!f.maintenance_job_id) {
    const pid = f.property_id || String(idFrom((await client.post('/app/properties', { address_line1: `Job house ${++jobHouse}`, status: 'vacant' })).location));
    f.maintenance_job_id = String(idFrom((await client.post('/app/maintenance', { property_id: pid, title: 'Repair', priority: 'normal', status: 'open' })).location));
    f.property_id = pid;
  }
  return f;
}

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
  r = await c.post('/register', { username: 'imposter', name: 'Imposter', agency_name: 'X', email: 'owner@example.com', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 422, 'the admin email is reserved');
  r = await c.post('/register', { username: 'admin', name: 'Imposter', agency_name: 'X', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 422, 'the admin username is reserved');
  assert.match(r.text, /username is taken/);
  const agent = await registerAndLogin('agent-reg@example.com', 'Reg Lettings');
  assert.equal((await agent.get('/admin')).status, 404, 'non-admins cannot see the admin panel');
  assert.doesNotMatch((await agent.get('/app')).text, /Admin panel/);
});

test('wrong password is rejected and logged', async () => {
  const c = new Client();
  const r = await c.post('/login', { login: 'admin', member: 'Theo', password: 'nope' });
  assert.equal(r.status, 401);
  const ev = db.prepare('SELECT * FROM login_events WHERE email = ? AND success = 0').get('admin / Theo');
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
    rent_pence: '1,000.00', rent_frequency: 'monthly', status: 'active',
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
  assert.doesNotMatch(r.text, /Arrears|Rent arrears/, 'no arrears on the dashboard');

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
  await c.get('/app/monthly?month=2026-09');
  await c.post('/app/monthly/generate', { month: '2026-09', landlord_id: String(landlordId) });
  assert.equal(db.prepare("SELECT closing_pence FROM monthly_statements WHERE landlord_id = ? AND month = '2026-09'").get(landlordId).closing_pence, 10000);
  assert.equal((await c.get('/app/statements')).status, 404, 'statement by date range is gone');

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
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Heat Ltd', invoice_number: 'INV-42', amount: '240.00', due_date: '2026-01-01', maintenance_job_id: String(jobId), file: new File([pdf], 'inv-42.pdf') }), { multipart: true });
  assert.equal(r.status, 302, r.text);
  const invoiceId = idFrom(r.location);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  assert.equal(inv.property_id, propertyId, 'property taken from the job');
  assert.equal(inv.status, 'unpaid');

  // A non-PDF/image file is refused, even with a .pdf name.
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Evil', amount: '1', file: new File([new Blob(['<script>alert(1)</script>'])], 'x.pdf') }), { multipart: true });
  assert.equal(r.status, 422);
  assert.match(r.text, /Upload a PDF/);

  // Unpaid/overdue list shows it with a Pay link; job page lists it.
  r = await c.get('/app/invoices?status=overdue');
  assert.match(r.text, /Heat Ltd/);
  assert.match(r.text, new RegExp(`/app/invoices/${invoiceId}#pay`));
  assert.match((await c.get(`/app/maintenance/${jobId}`)).text, /Heat Ltd/);

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
  r = await a.post('/app/invoices', await invoiceBody(a, { supplier: 'S', amount: '5', property_id: String(propertyId), file: pdf }), { multipart: true });
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
  // For the admin, the logo button is the admin panel and there's no dashboard.
  assert.match(r.text, /class="rail-btn brand-btn[^"]*" href="\/admin"[^>]*aria-label="Admin panel"/);
  assert.doesNotMatch(rail, /aria-label="Dashboard"|aria-label="Admin panel"/);
  assert.equal((await admin.get('/app')).location, '/admin');
  assert.match(rail, /href="\/admin\/accounts"[^>]*aria-label="Account details"/, 'Account details has its own menu button');
  const details = (await admin.get('/admin/accounts')).text.match(/id="account-details"[\s\S]*?<\/section>/)[0];
  assert.match(details, /<code>suspend-me<\/code><\/td>\s*<td><code>Test<\/code>/, 'username and sign-in name listed');
  assert.doesNotMatch(details, /kettle-harbour-58|scrypt\$/, 'no passwords or hashes shown');
  assert.match(rail, /aria-label="Backups"/);
  assert.doesNotMatch(rail, /aria-label="Landlords"|aria-label="Invoices"|aria-label="Transactions"/);
  for (const email of ['agent1@example.com', 'agent-inv@example.com', 'suspend-me@example.com']) assert.match(r.text, new RegExp(email));

  const u = db.prepare('SELECT id FROM users WHERE email = ?').get('suspend-me@example.com');
  await admin.get(`/admin/users/${u.id}`);
  await admin.post(`/admin/users/${u.id}/suspend`, {});
  assert.equal((await victim.get('/app')).location, '/login', 'suspended user is signed out');
  assert.equal((await victim.post('/login', { login: 'suspend-me', member: 'Test', password: 'kettle-harbour-58' })).status, 403);

  await admin.post(`/admin/users/${u.id}/activate`, {});
  assert.equal((await victim.login('suspend-me', 'kettle-harbour-58')).location, '/app');

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

test('agency data export: only the admin can download it', async () => {
  const c = await registerAndLogin('export@example.com', 'Export Lets');
  await c.post('/app/landlords', { name: 'Exported Landlord' });
  assert.equal((await c.get('/app/export')).status, 404, 'companies have no export');
  assert.doesNotMatch((await c.get('/app')).text, /Download my data/);
  const id = db.prepare("SELECT id FROM users WHERE username = 'export'").get().id;
  assert.equal((await c.get(`/admin/users/${id}/export`)).status, 404);
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  assert.match((await admin.get(`/admin/users/${id}`)).text, /href="\/admin\/users\/\d+\/export">Download data/);
  const r = await admin.get(`/admin/users/${id}/export`);
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
  const names = [...page.text.matchAll(/<code>(rift-backup-[^<]+)<\/code>/g)].map((m) => m[1]);
  assert.equal(names.length, 3, 'old backups pruned to BACKUP_KEEP');

  const dl = await fetch(`${base}/admin/backups/${names[0]}`, { headers: { cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  assert.equal((await fetch(`${base}/admin/backups/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie: admin.cookie } })).status, 404);

  // The archive opens with standard tar and contains the database and uploaded invoices.
  const file = path.join(config.backupDir, names[0]);
  const listing = execFileSync('tar', ['-tzf', file]).toString();
  assert.match(listing, /manifest\.json/);
  assert.match(listing, /rift\.db/);
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

  r = await c.post('/register', { username: 'harbour.lets', name: 'Sam', agency_name: 'Harbour', password: 'maple-cove-47', password_confirm: 'maple-cove-47' });
  assert.equal(r.status, 302, r.text);
  assert.match(r.location, /^\/app/, 'signed in straight away');
  r = await c.get(r.location);
  assert.match(r.text, /Welcome to Rift/);
  assert.match((await c.get('/app/account')).text, /<code>harbour\.lets<\/code>/);
  const u = db.prepare("SELECT * FROM users WHERE username = 'harbour.lets'").get();
  assert.equal(u.email, null);
  assert.equal(u.is_admin, 0);

  // Same username (any capitalisation) can't be taken twice; bad usernames are rejected.
  const other = new Client();
  r = await other.post('/register', { username: 'Harbour.Lets', name: 'X', agency_name: 'X', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 422);
  r = await other.post('/register', { username: ' ', name: 'X', agency_name: 'X', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 422, 'a blank username is refused');
  // Spaces are fine: the username can match the company name.
  const spaced = new Client();
  r = await spaced.post('/register', { username: 'Atlantic Lodge Housing 2', name: 'Al Lodge', agency_name: 'Atlantic Lodge Housing 2', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 302, r.text);
  const signIn = new Client();
  r = await signIn.post('/login', { login: 'Atlantic Lodge Housing 2', member: 'Al', password: 'kettle-harbour-58' });
  assert.match(r.location, /^\/app/);

  // Sign in by username (case-insensitive); admin can also sign in by username.
  const again = new Client();
  // Capitals count: the username and name must be typed exactly.
  assert.equal((await new Client().post('/login', { login: 'HARBOUR.LETS', member: 'Sam', password: 'maple-cove-47' })).status, 401);
  assert.equal((await new Client().post('/login', { login: 'harbour.lets', member: 'sam', password: 'maple-cove-47' })).status, 401);
  assert.equal((await again.login('harbour.lets', 'maple-cove-47', 'Sam')).location, '/app');
  assert.equal((await new Client().login('admin', 'owner-password-123')).location, '/admin');
  assert.equal((await new Client().post('/login', { login: 'harbour.lets', member: 'Sam', password: 'wrong-password' })).status, 401);
  // Email addresses aren't accepted as a login, only usernames.
  const withEmail = new Client();
  await withEmail.post('/register', { username: 'mailtest', name: 'M', agency_name: 'M', email: 'mail@test.com', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal((await new Client().post('/login', { login: 'mail@test.com', member: 'main', password: 'kettle-harbour-58' })).status, 401);
  assert.equal((await new Client().login('mailtest', 'kettle-harbour-58', 'M')).location, '/app');
  assert.match((await new Client().get('/login')).text, />Agency <input/);
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
      body: new URLSearchParams({ username: 'sneaky', name: 'S', agency_name: 'S', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' }).toString() });
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
  r = await admin.post('/admin/users', { agency_name: 'Coastal Homes', name: 'Pat Lee', username: 'coastal', password: 'sea-view-2026' });
  assert.equal(r.status, 302);
  assert.match(r.location, /\/admin\/users\/\d+\?created=1/);
  const id = Number(r.location.match(/users\/(\d+)/)[1]);
  const coastal = new Client();
  assert.equal((await coastal.login('coastal', 'sea-view-2026', 'Pat')).location, '/app');
  assert.match((await coastal.get('/app')).text, /Coastal Homes/);

  // Non-admins can't add accounts.
  assert.equal((await coastal.post('/admin/users', { agency_name: 'X', name: 'X', username: 'xx1', password: 'kettle-harbour-58' })).status, 404);

  // Reset: old password stops working, they're signed out, new one works.
  await admin.get(`/admin/users/${id}`);
  r = await admin.post(`/admin/users/${id}/password`, { password: 'new-pass-2027' });
  assert.match(decodeURIComponent(r.location), /Password changed/);
  assert.equal((await coastal.get('/app')).location, '/login');
  assert.equal((await new Client().post('/login', { login: 'coastal', member: 'Pat', password: 'sea-view-2026' })).status, 401);
  assert.equal((await new Client().login('coastal', 'new-pass-2027', 'Pat')).location, '/app');
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
  // Capitals in ADMIN_USERNAME are kept, so the admin must type them.
  ensureAdmin(db3, { ...cfg, adminUsername: 'TPAS2', adminLoginName: 'Theo' }, () => {});
  const upper = db3.prepare('SELECT username, login_name FROM users WHERE id = ?').get(row.id);
  assert.deepEqual({ ...upper }, { username: 'TPAS2', login_name: 'Theo' });
});

test('councils link to properties, and through them to landlords and tenants', async () => {
  const c = await registerAndLogin('councils@example.com', 'Council Lets');
  let r = await c.post('/app/councils', { name: 'Bristol City Council', council_tax_phone: '0117 922 2900', licensing_email: 'private.housing@bristol.gov.uk' });
  assert.equal(r.status, 302, r.text);
  const councilId = idFrom(r.location);
  r = await c.post('/app/landlords', { name: 'Olive Grant' });
  const landlordId = idFrom(r.location);

  // "+ Add property in this council" pre-selects the council.
  r = await c.get(`/app/properties/new?council_id=${councilId}`);
  assert.match(r.text, new RegExp(`<option value="${councilId}" selected>Bristol City Council`));
  r = await c.post('/app/properties', { address_line1: '9 Cotham Hill', landlord_id: landlordId, council_id: councilId, council_tax_account: 'CT-55501', council_tax_payer: 'Tenant', status: 'vacant' });
  const propertyId = idFrom(r.location);
  r = await c.post(`/app/properties/${propertyId}/add-tenant`, { tenant_mode: 'new', name: 'Iris Moss', booking_date: '2026-09-01', start_date: '2026-09-10', rent_pence: '1100', rent_frequency: 'monthly', status: 'active' });
  const tenantId = db.prepare('SELECT tenant_id FROM tenancies WHERE id = ?').get(idFrom(r.location)).tenant_id;

  const council = await c.get(`/app/councils/${councilId}`);
  assert.match(council.text, /Properties in this council/);
  assert.match(council.text, /9 Cotham Hill/);
  assert.doesNotMatch(council.text, /Landlords in this council/);
  assert.doesNotMatch(council.text, /Current tenants in this council/);
  assert.match(council.text, /<dt>Phone number<\/dt>[\s\S]*?0117 922 2900/, 'Council tax phone is now called Phone number');
  assert.match(council.text, /<dt>Email<\/dt>/);
  assert.doesNotMatch(council.text, /<dt>Address<\/dt>|Council tax phone|Council tax email/);
  assert.doesNotMatch((await c.get(`/app/properties/${propertyId}`)).text, /Council tax band/);
  assert.match((await c.get(`/app/landlords/${landlordId}`)).text, /Councils[\s\S]*Bristol City Council/);
  assert.match((await c.get(`/app/tenants/${tenantId}`)).text, /<dt>Council<\/dt>\s*<dd><a[^>]*>Bristol City Council/);
  assert.match((await c.get(`/app/properties/${propertyId}`)).text, /href="\/app\/councils\/\d+">Bristol City Council/);
  const details = (await c.get(`/app/properties/${propertyId}`)).text.match(/<dl class="details">[\s\S]*?<\/dt>/)[0];
  assert.match(details, /<dt>Council<\/dt>$/, 'Council is the first detail on the property page');
  const list = (await c.get('/app/properties')).text;
  assert.match(list, /<th[^>]*>Council<\/th>\s*<th[^>]*>Landlord<\/th>/, 'Council sits left of Landlord');
  assert.doesNotMatch(list, /<th[^>]*>Postcode<\/th>/, 'Council replaces Postcode in the list');
  assert.match(list, /<th[^>]*>Property name<\/th>/);
  assert.doesNotMatch(list, /<th[^>]*>Address<\/th>/, 'Property name replaces Address');
  assert.match(list, /Bristol City Council/);
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  // [0] is the menu's own label ("Main"); the first button follows it.
  assert.equal(rail.match(/aria-label="([^"]+)"/g)[1], 'aria-label="Councils"', 'Councils is the first menu button');
  assert.ok(rail.indexOf('aria-label="Properties"') < rail.indexOf('aria-label="Landlords"'), 'Properties is above Landlords');

  // Another company can't see or link to this council.
  const other = await registerAndLogin('councils-other@example.com', 'Other Lets');
  assert.equal((await other.get(`/app/councils/${councilId}`)).status, 404);
  r = await other.post('/app/properties', { address_line1: 'X', council_id: councilId, status: 'vacant' });
  assert.equal(r.status, 422);
});

test('account details: companies can only view them; the admin edits them', async () => {
  const c = await registerAndLogin('myaccount@example.com', 'Before Lets');
  let r = await c.get('/app');
  assert.match(r.text, /class="rail-btn avatar[^"]*" href="\/app\/account"/);
  r = await c.get('/app/account');
  assert.equal(r.status, 200);
  assert.match(r.text, /<code>myaccount<\/code>/);
  assert.match(r.text, /contact your Rift administrator/);
  assert.doesNotMatch(r.text, /<form method="post" action="\/app\/account"/);

  // The company can't change its own details.
  r = await c.post('/app/account', { name: 'Sneaky', agency_name: 'Sneaky Lets' });
  assert.equal(r.status, 404);
  const u = db.prepare("SELECT * FROM users WHERE username = 'myaccount'").get();
  assert.equal(u.agency_name, 'Before Lets');
  assert.equal((await c.post(`/admin/users/${u.id}/details`, { name: 'X', agency_name: 'X' })).status, 404);

  // The admin can, but not the username; a blank password keeps the current one.
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  r = await admin.get(`/admin/users/${u.id}`);
  assert.match(r.text, /Account details/);
  r = await admin.post(`/admin/users/${u.id}/details`, { name: 'Robin Hart', agency_name: 'After Lets', email: 'robin@after.example.com', phone: '0117 000 1111', address: '1 Quay St', password: '' });
  assert.match(decodeURIComponent(r.location), /Account details saved/);
  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  assert.equal(after.agency_name, 'After Lets');
  assert.equal(after.phone, '0117 000 1111');
  assert.equal(after.username, 'myaccount');
  assert.ok(require('../src/auth').verifyPassword('kettle-harbour-58', after.password_hash));
  assert.match((await c.get('/app/account')).text, /After Lets[\s\S]*0117 000 1111/);
  assert.doesNotMatch((await c.get('/app/account')).text, /Company address/);

  r = await admin.post(`/admin/users/${u.id}/details`, { name: '', agency_name: 'After Lets' });
  assert.match(decodeURIComponent(r.location), /Enter the contact name/);

  // The Password box resets it: too short is refused; a good one is saved and signs them out.
  r = await admin.post(`/admin/users/${u.id}/details`, { name: 'Robin Hart', agency_name: 'After Lets', password: 'short' });
  assert.match(decodeURIComponent(r.location), /at least 8 characters/);
  assert.ok(require('../src/auth').verifyPassword('kettle-harbour-58', db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id).password_hash));
  r = await admin.post(`/admin/users/${u.id}/details`, { name: 'Robin Hart', agency_name: 'After Lets', password: 'brand-new-pass-1' });
  assert.match(decodeURIComponent(r.location), /password saved/);
  assert.ok(require('../src/auth').verifyPassword('brand-new-pass-1', db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id).password_hash));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id).n, 0);
});

test('property certificates: gas, electrical and insurance with current, previous and status', async () => {
  const c = await registerAndLogin('certs@example.com', 'Cert Lets');
  let r = await c.post('/app/properties', { address_line1: '4 Canal Walk', status: 'let' });
  const propertyId = idFrom(r.location);

  r = await c.get(`/app/properties/${propertyId}`);
  assert.match(r.text, /Certificates &amp; insurance/);
  for (const title of ['Gas certificate', 'Electrical certificate \\(EICR\\)', 'Insurance']) assert.match(r.text, new RegExp(title));
  assert.equal((r.text.match(/cert-badge-missing/g) || []).length, 3, 'all three missing to start');

  // "+ Add" pre-fills the property and type, and returns to the panel.
  r = await c.get(`/app/compliance/new?property_id=${propertyId}&item_type=${encodeURIComponent('Gas Safety (CP12)')}`);
  assert.match(r.text, /<option value="Gas Safety \(CP12\)" selected>/);
  const add = (body) => c.post('/app/compliance', { property_id: String(propertyId), ...body });
  r = await add({ item_type: 'Gas Safety (CP12)', issued_date: '2024-05-01', expiry_date: '2025-05-01', provider: 'Old Gas Co', reference: 'GS-1' });
  assert.equal(r.location, `/app/properties/${propertyId}#certificates`);
  await add({ item_type: 'Gas Safety (CP12)', issued_date: '2025-05-01', expiry_date: '2099-05-01', provider: 'New Gas Co', reference: 'GS-2' });
  await add({ item_type: 'EICR', issued_date: '2020-01-01', expiry_date: '2021-01-01', provider: 'Sparks Ltd' });
  await add({ item_type: 'Insurance', issued_date: '2026-01-01', expiry_date: require('../src/format').addDays(require('../src/format').today(), 10), provider: 'Homelet', reference: 'POL-77' });

  r = await c.get(`/app/properties/${propertyId}`);
  const panel = r.text.match(/id="certificates"[\s\S]*?<\/section>/)[0];
  const box = (title) => panel.split('<div class="cert ').find((b) => b.includes(title));
  assert.match(box('Gas certificate'), /cert-badge-valid[\s\S]*01\/05\/2099[\s\S]*New Gas Co[\s\S]*Previous \(1\)[\s\S]*Old Gas Co/);
  assert.match(box('Electrical certificate'), /cert-badge-expired[\s\S]*Sparks Ltd/);
  assert.match(box('Insurance'), /cert-badge-expiring[\s\S]*Homelet[\s\S]*POL-77/);
  assert.match(box('Insurance'), /Added<\/dt><dd>\d{2}\/\d{2}\/\d{4}/);
  // There's no separate "Other compliance" list on a property any more.
  assert.doesNotMatch(r.text, /Other compliance/);
});

test('dashboard notifications list certificates expiring within two months, urgent ones first', async () => {
  const fmt = require('../src/format');
  const c = await registerAndLogin('notify@example.com', 'Notify Lets');
  let r = await c.get('/app');
  assert.match(r.text, /Notifications/);
  assert.match(r.text, /Nothing needs attention/);

  r = await c.post('/app/properties', { address_line1: '2 Dock Lane', status: 'let' });
  const pid = String(idFrom(r.location));
  const add = (item_type, days) => c.post('/app/compliance', { property_id: pid, item_type, expiry_date: fmt.addDays(fmt.today(), days) });
  await add('Gas Safety (CP12)', 12);   // due in 12 days -> notify
  await add('EICR', -3);                // expired -> notify
  await add('Insurance', 45);           // 45 days -> listed, not urgent
  await add('EPC', 400);                // far off -> neither

  r = await c.get('/app');
  const notes = r.text.match(/id="notifications"[\s\S]*?<\/section>/)[0];
  assert.match(notes, /Gas certificate<\/strong> for <a[^>]*>2 Dock Lane[\s\S]*expires in 12 days/);
  assert.match(notes, /Electrical certificate \(EICR\)[\s\S]*expired 3 days ago/);
  assert.match(notes, /class="is-upcoming">[\s\S]*?Insurance<\/strong>[\s\S]*?expires in 45 days/);
  assert.doesNotMatch(notes, /EPC/);
  assert.match(notes, /Electrical[\s\S]*Gas certificate[\s\S]*Insurance/, 'soonest first');
  assert.match(notes, /class="count alert-count">3</);
  assert.doesNotMatch(r.text, /Coming up in 1–2 months/);

  // Renewing the gas certificate clears its notification.
  await add('Gas Safety (CP12)', 365);
  r = await c.get('/app');
  assert.doesNotMatch(r.text.match(/id="notifications"[\s\S]*?<\/section>/)[0], /Gas certificate/);
});

test('activity log: the admin sees each user\'s sign-ins, page views and changes', async () => {
  const c = await registerAndLogin('tracked@example.com', 'Tracked Lets');
  const uid = db.prepare("SELECT id FROM users WHERE username = 'tracked'").get().id;
  await c.login('tracked', 'kettle-harbour-58');
  await c.get('/app/landlords');
  let r = await c.post('/app/landlords', { name: 'Martha Quinn' });
  const lid = idFrom(r.location);
  await c.get(`/app/landlords/${lid}`);
  // Autosave while typing: several saves, one "Edited" entry.
  await c.get(`/app/landlords/${lid}/edit`);
  for (const phone of ['0', '01', '011']) {
    await fetch(`${base}/app/landlords/${lid}`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-autosave': '1' },
      body: new URLSearchParams({ _csrf: c.csrf, name: 'Martha Quinn', phone }).toString() });
  }
  await c.post(`/app/landlords/${lid}/delete`, {});
  await c.post('/app/landlords', { name: '' }); // failed attempt: not logged

  const rows = db.prepare('SELECT action, summary FROM activity_log WHERE user_id = ? ORDER BY id').all(uid).map((x) => `${x.action}: ${x.summary}`);
  for (const expected of ['signed in: Signed in', 'viewed: Viewed landlords', 'created: Added landlord: Martha Quinn',
    'viewed: Viewed landlord: Martha Quinn', 'updated: Edited landlord: Martha Quinn', 'deleted: Deleted landlord: Martha Quinn']) {
    assert.ok(rows.includes(expected), `missing "${expected}" in ${JSON.stringify(rows)}`);
  }
  assert.equal(rows.filter((x) => x.startsWith('updated:')).length, 1, 'autosave keystrokes collapse into one entry');
  assert.ok(!rows.some((x) => x === 'created: Added landlord'), 'failed saves are not logged');

  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  r = await admin.get('/admin');
  assert.match(r.text, /<th>Last active<\/th>/);
  assert.match(r.text, /Recent activity[\s\S]*<code>tracked<\/code>[\s\S]*Deleted landlord: Martha Quinn/);
  r = await admin.get(`/admin/users/${uid}`);
  assert.match(r.text, /id="activity"[\s\S]*Added landlord: Martha Quinn/);
  r = await admin.get(`/admin/users/${uid}?activity=changes`);
  const changes = r.text.match(/id="activity"[\s\S]*?<\/section>/)[0];
  assert.match(changes, /Deleted landlord/);
  assert.doesNotMatch(changes, /Viewed landlords/);

  // Companies can't see anyone's activity.
  assert.equal((await c.get(`/admin/users/${uid}`)).status, 404);
});

test('several people at one company share its username, each with their own name and password', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  await admin.get('/admin/users/new');
  let r = await admin.post('/admin/users', { agency_name: 'Eurostars Lettings', name: 'Theo Owner', username: 'eurostars', login_name: 'main', password: 'harbour-gate-19' });
  const companyId = Number(r.location.match(/users\/(\d+)/)[1]);
  await admin.get(`/admin/users/${companyId}`);
  r = await admin.post(`/admin/users/${companyId}/people`, { name: 'John Price', login_name: 'john', password: 'river-stone-81' });
  assert.match(decodeURIComponent(r.location), /Added John Price/);
  await admin.post(`/admin/users/${companyId}/people`, { name: 'Amy Hall', login_name: 'amy', password: 'amys-pass-22' });
  r = await admin.post(`/admin/users/${companyId}/people`, { name: 'Dupe', login_name: 'John', password: 'whatever-123' });
  assert.match(decodeURIComponent(r.location), /already has someone called "John"/, 'names are unique ignoring capitals');

  // Each person signs in with the company username + their name + their own password.
  const john = new Client();
  assert.equal((await john.post('/login', { login: 'eurostars', member: 'amy', password: 'river-stone-81' })).status, 401, "John's password doesn't open Amy");
  for (const blank of [{ login: '', member: 'john', password: 'river-stone-81' }, { login: 'eurostars', member: '', password: 'river-stone-81' }, { login: 'eurostars', member: 'john', password: '' }]) {
    assert.equal((await john.post('/login', blank)).status, 422, `blank box refused: ${JSON.stringify(blank)}`);
  }
  // The admin needs their name too, typed exactly.
  assert.equal((await new Client().post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' })).location, '/admin');
  assert.equal((await new Client().post('/login', { login: 'admin', member: '', password: 'owner-password-123' })).status, 422);
  assert.equal((await new Client().post('/login', { login: 'admin', member: 'theo', password: 'owner-password-123' })).status, 401, 'capitals count');
  assert.equal((await john.post('/login', { login: 'EUROSTARS', member: 'JOHN', password: 'river-stone-81' })).status, 401, 'capitals count');
  assert.equal((await john.post('/login', { login: 'eurostars', member: 'main', password: 'river-stone-81' })).status, 401, "John's password doesn't open the main login");
  r = await john.post('/login', { login: 'eurostars', member: 'john', password: 'river-stone-81' });
  assert.equal(r.location, '/app');
  await john.get('/app');
  const amy = new Client();
  await amy.post('/login', { login: 'eurostars', member: 'amy', password: 'amys-pass-22' });
  await amy.get('/app');
  const main = new Client();
  assert.equal((await main.login('eurostars', 'harbour-gate-19', 'main')).location, '/app');

  // They all work on the same company's data.
  r = await john.post('/app/landlords', { name: 'Shared Landlord' });
  const lid = idFrom(r.location);
  assert.match((await amy.get(`/app/landlords/${lid}`)).text, /Shared Landlord/);
  assert.match((await main.get('/app/landlords')).text, /Shared Landlord/);
  assert.equal(db.prepare('SELECT account_id FROM landlords WHERE id = ?').get(lid).account_id, companyId);
  assert.match((await amy.get('/app')).text, /Welcome back, Amy Hall/);
  assert.match((await amy.get('/app/account')).text, /<code>eurostars<\/code>[\s\S]*<code>amy<\/code>/);

  // The admin sees who did what, and the company is listed once.
  r = await admin.get(`/admin/users/${companyId}`);
  assert.match(r.text, /id="people"[\s\S]*John Price[\s\S]*<code>john<\/code>/);
  assert.match(r.text, /id="activity"[\s\S]*John Price[\s\S]*Added landlord: Shared Landlord/);
  r = await admin.get('/admin');
  assert.equal((r.text.match(/<code>eurostars<\/code><\/td>/g) || []).length, 1, 'company listed once in the users table');
  const details = (await admin.get('/admin/accounts')).text.match(/id="account-details"[\s\S]*?<\/section>/)[0];
  for (const n of ['main', 'john', 'amy']) assert.match(details, new RegExp(`<code>eurostars</code></td>\\s*<td><code>${n}</code>`), `login ${n} listed`);

  // Suspending one person only blocks them; suspending the company blocks everyone.
  const johnId = db.prepare("SELECT id FROM users WHERE company_id = ? AND login_name = 'john'").get(companyId).id;
  await admin.get(`/admin/users/${companyId}`);
  await admin.post(`/admin/people/${johnId}/suspend`, {});
  assert.equal((await john.get('/app')).location, '/login');
  assert.equal((await amy.get('/app')).status, 200);
  await admin.post(`/admin/people/${johnId}/activate`, {});
  await admin.post(`/admin/users/${companyId}/suspend`, {});
  assert.equal((await amy.get('/app')).location, '/login');
  assert.equal((await new Client().post('/login', { login: 'eurostars', member: 'john', password: 'river-stone-81' })).status, 403);
  await admin.post(`/admin/users/${companyId}/activate`, {});

  // Password reset for one person; removing a person keeps the company's data.
  await admin.post(`/admin/people/${johnId}/password`, { password: 'cedar-lane-204' });
  assert.equal((await new Client().post('/login', { login: 'eurostars', member: 'john', password: 'cedar-lane-204' })).location, '/app');
  await admin.post(`/admin/people/${johnId}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(johnId).n, 0);
  assert.ok(db.prepare('SELECT 1 FROM landlords WHERE id = ?').get(lid));

  // Companies can't add people themselves (the main login was signed out by the suspension above).
  await main.login('eurostars', 'harbour-gate-19', 'main');
  await main.get('/app');
  assert.equal((await main.post(`/admin/users/${companyId}/people`, { name: 'X', login_name: 'x', password: 'password-123' })).status, 404);
});

test('existing "main" logins switch to the contact\'s first name', () => {
  const file = path.join(tmp, 'names.db');
  const d1 = openDatabase(file);
  d1.prepare("INSERT INTO users (username, login_name, name, agency_name, password_hash) VALUES ('acme', 'main', 'Olivia Stone', 'Acme', 'h')").run();
  d1.prepare("INSERT INTO users (username, login_name, name, agency_name, password_hash) VALUES ('odd', 'main', '!!', 'Odd', 'h')").run();
  d1.close();
  const d2 = openDatabase(file);
  assert.equal(d2.prepare("SELECT login_name FROM users WHERE username = 'acme'").get().login_name, 'Olivia');
  assert.equal(d2.prepare("SELECT login_name FROM users WHERE username = 'odd'").get().login_name, 'User');
  d2.close();
});


test('two-step login for the admin: set up, sign in with a code, recovery codes, reset', async () => {
  const totp = require('../src/totp');
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  let r = await admin.get('/admin/security');
  assert.match(r.text, /Two-step login[\s\S]*Off/);
  r = await admin.post('/admin/security/setup', {});
  r = await admin.get('/admin/security');
  assert.match(r.text, /<img src="data:image\/svg\+xml;base64,/);
  const secret = db.prepare("SELECT totp_secret FROM users WHERE username = 'admin'").get().totp_secret;
  r = await admin.post('/admin/security/enable', { code: '000000' });
  assert.match(decodeURIComponent(r.location), /didn't match/);
  r = await admin.post('/admin/security/enable', { code: totp.codeAt(secret, totp.currentStep()) });
  assert.match(r.text, /Two-step login is on/);
  const recovery = [...r.text.matchAll(/<li><code>([a-z2-7]{4}-[a-z2-7]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(recovery.length, 8);
  assert.match((await admin.get('/admin')).text, /Admin panel/, 'this browser stays signed in');

  // Password alone is no longer enough.
  const c = new Client();
  r = await c.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  assert.equal(r.location, '/login/code');
  assert.equal((await c.get('/admin')).location, '/login', 'not signed in yet');
  assert.match((await c.get('/login/code')).text, /Enter your code/);
  r = await c.post('/login/code', { code: '123456' });
  assert.equal(r.status, 401);
  // The code that was used to switch it on can't be reused; the next one works.
  const nextStep = totp.currentStep() + 1;
  r = await c.post('/login/code', { code: totp.codeAt(secret, nextStep) });
  assert.equal(r.location, '/admin');
  assert.equal((await c.get('/admin')).status, 200);
  const replay = new Client();
  await replay.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  assert.equal((await replay.post('/login/code', { code: totp.codeAt(secret, nextStep) })).status, 401, 'a code only works once');

  // A recovery code works once.
  const rc = new Client();
  await rc.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  assert.equal((await rc.post('/login/code', { code: recovery[0] })).location, '/admin');
  const rc2 = new Client();
  await rc2.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  assert.equal((await rc2.post('/login/code', { code: recovery[0] })).status, 401);

  // Five wrong codes and they have to start again.
  const guesser = new Client();
  await guesser.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  for (let i = 0; i < 4; i++) assert.equal((await guesser.post('/login/code', { code: '000001' })).status, 401);
  r = await guesser.post('/login/code', { code: '000001' });
  assert.match(r.text, /Too many wrong codes/);
  assert.equal((await guesser.post('/login/code', { code: totp.codeAt(secret, totp.currentStep()) })).location, '/login');

  // Lost everything: ADMIN_2FA_RESET switches it off on restart.
  ensureAdmin(db, { ...config, admin2faReset: true }, () => {});
  const after = new Client();
  assert.equal((await after.login('admin', 'owner-password-123')).location, '/admin');
});

test('encrypted backups: unreadable without the password, restorable with it', async () => {
  const { execFileSync } = require('node:child_process');
  const { createBackup, decryptFile, isEncrypted } = require('../src/backup');
  const encConfig = { ...config, backupDir: path.join(tmp, 'enc-backups'), backupPassword: 'correct horse battery staple' };
  const b = await createBackup(db, encConfig, { reason: 'test' });
  assert.match(b.name, /\.tar\.gz\.enc$/);
  assert.ok(isEncrypted(b.file));
  const head = fs.readFileSync(b.file).subarray(0, 64);
  assert.ok(!head.includes(Buffer.from([0x1f, 0x8b])), 'not a readable gzip');
  assert.ok(!fs.readFileSync(b.file).includes(Buffer.from('SQLite format 3')), 'database not visible inside');

  await assert.rejects(decryptFile(b.file, path.join(tmp, 'nope.tar.gz'), 'wrong password'), /Wrong backup password/);
  assert.ok(!fs.existsSync(path.join(tmp, 'nope.tar.gz')));
  const plain = path.join(tmp, 'ok.tar.gz');
  await decryptFile(b.file, plain, 'correct horse battery staple');
  assert.match(execFileSync('tar', ['-tzf', plain]).toString(), /rift\.db/);

  // The restore script decrypts with BACKUP_PASSWORD.
  const target = path.join(tmp, 'restored-enc');
  const env = { ...process.env, DATABASE_FILE: path.join(target, 'nexus.db'), UPLOAD_DIR: path.join(target, 'uploads'), BACKUP_PASSWORD: 'correct horse battery staple' };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore-backup.js', b.file], { env, cwd: path.join(__dirname, '..') });
  const restored = openDatabase(path.join(target, 'nexus.db'));
  assert.ok(restored.prepare("SELECT 1 FROM users WHERE username = 'admin'").get());
  restored.close();
});

test('admin can fix a company username\'s capitals; people follow', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  await admin.get('/admin/users/new');
  let r = await admin.post('/admin/users', { agency_name: 'Capital Lets', name: 'Theo Grey', username: 'capitallets', login_name: 'Theo', password: 'Sample-Pass-9!' });
  const id = Number(r.location.match(/users\/(\d+)/)[1]);
  await admin.get(`/admin/users/${id}`);
  await admin.post(`/admin/users/${id}/people`, { name: 'Ann', login_name: 'Ann', password: 'anns-pass-1' });
  assert.equal((await new Client().post('/login', { login: 'CapitalLets', member: 'Theo', password: 'Sample-Pass-9!' })).status, 401);

  await admin.get(`/admin/users/${id}`);
  r = await admin.post(`/admin/users/${id}/details`, { username: 'CapitalLets', login_name: 'Theo', name: 'Theo Grey', agency_name: 'Capital Lets' });
  assert.match(decodeURIComponent(r.location), /Account details saved/);
  assert.equal((await new Client().post('/login', { login: 'CapitalLets', member: 'Theo', password: 'Sample-Pass-9!' })).location, '/app');
  assert.equal((await new Client().post('/login', { login: 'CapitalLets', member: 'Ann', password: 'anns-pass-1' })).location, '/app');
  assert.equal((await new Client().post('/login', { login: 'capitallets', member: 'Theo', password: 'Sample-Pass-9!' })).status, 401);

  // Can't take another company's username.
  r = await admin.post(`/admin/users/${id}/details`, { username: 'eurostars', login_name: 'Theo', name: 'Theo Grey', agency_name: 'Capital Lets' });
  assert.match(decodeURIComponent(r.location), /That username is taken/);
});

test('councils list shows how many properties each has, and which', async () => {
  const c = await registerAndLogin('council-list@example.com', 'List Lets');
  let r = await c.post('/app/councils', { name: 'Leeds City Council', council_tax_phone: '0113 222 4404' });
  const leeds = String(idFrom(r.location));
  await c.post('/app/councils', { name: 'Empty Council' });
  for (const a of ['1 A Street', '2 B Street', '3 C Street', '4 D Street']) await c.post('/app/properties', { address_line1: a, council_id: leeds, status: 'let' });
  r = await c.get('/app/councils');
  assert.match(r.text, /<th[^>]*>Properties With This Council<\/th>/);
  assert.match(r.text, /<th[^>]*>Council<\/th>\s*<th[^>]*>Properties With This Council<\/th>\s*<th[^>]*>Email<\/th>\s*<th[^>]*>Phone number<\/th>/, 'name, property amount, email, phone');
  const page = (await c.get(`/app/councils/${leeds}`)).text + (await c.get(`/app/councils/${leeds}/edit`)).text;
  assert.doesNotMatch(page, /Licensing email|Environmental health phone/, 'those two fields are gone');
  assert.match(r.text, /Leeds City Council<\/a>\s*<\/td>\s*<td class="">\s*4\s*<\/td>[\s\S]*?0113 222 4404/);
  assert.match(r.text, /Empty Council<\/a>\s*<\/td>\s*<td class="">\s*0\s*<\/td>/);
});

test('councils, landlords and properties have a search bar that also matches linked names', async () => {
  const c = await registerAndLogin('search-bar@example.com', 'Search Lets');
  let r = await c.post('/app/councils', { name: 'Leeds City Council' });
  const leeds = String(idFrom(r.location));
  await c.post('/app/councils', { name: 'York Council' });
  r = await c.post('/app/landlords', { name: 'Olive Grant' });
  const olive = String(idFrom(r.location));
  await c.post('/app/landlords', { name: 'Ben Hart' });
  await c.post('/app/properties', { address_line1: 'Rose Cottage', council_id: leeds, landlord_id: olive, status: 'let' });
  await c.post('/app/properties', { address_line1: 'Mill House', status: 'vacant' });

  for (const section of ['councils', 'landlords', 'properties']) {
    assert.match((await c.get(`/app/${section}`)).text, /<form method="get" class="search-bar"/, `${section} has a search bar`);
  }
  r = await c.get('/app/councils?q=york');
  assert.match(r.text, /York Council/);
  assert.doesNotMatch(r.text, /Leeds City Council/);
  assert.match(r.text, /1 result for/);
  r = await c.get('/app/landlords?q=olive');
  assert.match(r.text, /Olive Grant/);
  assert.doesNotMatch(r.text, /Ben Hart/);
  r = await c.get('/app/properties?q=mill');
  assert.match(r.text, /Mill House/);
  assert.doesNotMatch(r.text, /Rose Cottage/);
  // Searching a council or landlord name finds their properties.
  r = await c.get('/app/properties?q=leeds');
  assert.match(r.text, /Rose Cottage/);
  assert.doesNotMatch(r.text, /Mill House/);
  r = await c.get('/app/properties?q=Olive');
  assert.match(r.text, /Rose Cottage/);
  assert.doesNotMatch(r.text, /Mill House/);
  r = await c.get('/app/properties?q=nothing-here');
  assert.match(r.text, /No matches/);
});

test('councils can have a picture, shown left of the council details and in the list', async () => {
  const c = await registerAndLogin('council-photo@example.com', 'Photo Lets');
  let r = await c.post('/app/councils', { name: 'Leeds City Council' });
  const id = idFrom(r.location);
  r = await c.get(`/app/councils/${id}`);
  assert.match(r.text, /class="council-photo"[\s\S]*?Add picture/);
  assert.match(r.text, /class="with-photo">\s*<div class="council-photo">[\s\S]*<dl class="details">\s*<div class="">\s*<dt>Council<\/dt>/, 'picture comes before (left of) Council');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  r = await c.post(`/app/councils/${id}/photo`, { photo: new File([png], 'logo.png') }, { multipart: true });
  assert.equal(r.location, `/app/councils/${id}`);
  r = await c.get(`/app/councils/${id}`);
  assert.match(r.text, new RegExp(`<img src="/app/councils/${id}/photo\\?v=\\d+" alt="Picture of Leeds City Council">`));
  assert.match(r.text, /Change picture/);
  assert.match(r.text, new RegExp(`<h1 class=with-thumb><img class="title-thumb" src="/app/councils/${id}/photo\\?v=\\d+" alt="">Leeds City Council</h1>`), 'picture left of the council name at the top');
  r = await c.get(`/app/councils/${id}/photo`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match((await c.get('/app/councils')).text, new RegExp(`<img class="thumb" src="/app/councils/${id}/photo`));

  // Not an image: refused, and the old picture stays.
  r = await c.post(`/app/councils/${id}/photo`, { photo: new File(['<svg onload=alert(1)>'], 'x.png') }, { multipart: true });
  assert.match(decodeURIComponent(r.location), /Upload a PNG, JPG, WebP or GIF picture/);
  assert.equal((await c.get(`/app/councils/${id}/photo`)).headers.get('content-type'), 'image/png');

  // Other companies can't see or change it.
  const other = await registerAndLogin('council-photo-2@example.com', 'Other Lets');
  assert.equal((await other.get(`/app/councils/${id}/photo`)).status, 404);
  assert.equal((await other.post(`/app/councils/${id}/photo`, { photo: new File([png], 'a.png') }, { multipart: true })).status, 404);
  assert.equal((await other.post(`/app/councils/${id}/photo/delete`, {})).status, 404);

  r = await c.post(`/app/councils/${id}/photo/delete`, {});
  assert.equal(r.location, `/app/councils/${id}`);
  assert.equal((await c.get(`/app/councils/${id}/photo`)).status, 404);

  // Deleting the council removes its picture too.
  await c.post(`/app/councils/${id}/photo`, { photo: new File([png], 'logo.png') }, { multipart: true });
  await c.post(`/app/councils/${id}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM council_photos WHERE council_id = ?').get(id).n, 0);
});

test('landlords have a code, shown right of the name in the list and on their page', async () => {
  const c = await registerAndLogin('landlord-code@example.com', 'Code Lets');
  let r = await c.post('/app/landlords', { name: 'Olive Grant', code: 'LL001', email: 'olive@example.com' });
  const id = idFrom(r.location);
  r = await c.get('/app/landlords');
  assert.match(r.text, /<th[^>]*>Name<\/th>\s*<th[^>]*>Landlord code<\/th>/, 'code column sits right of Name');
  assert.match(r.text, /Olive Grant<\/a>[\s\S]*?<td[^>]*>\s*LL001\s*<\/td>/);
  r = await c.get(`/app/landlords/${id}`);
  assert.match(r.text, /<h1>Olive Grant <span class="code-chip" title="Landlord code">LL001<\/span><\/h1>/);
  assert.match(r.text, /<dt>Name<\/dt>[\s\S]*?<dt>Landlord code<\/dt>/);
  assert.match((await c.get('/app/landlords?q=LL001')).text, /Olive Grant/, 'searchable by code');
});

test('any invoice can be deleted, from its page or from a list', async () => {
  const c = await registerAndLogin('invoice-delete@example.com', 'Delete Lets');
  let r = await c.post('/app/landlords', { name: 'Dee Owner' });
  const landlordId = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '3 Quay Street', landlord_id: landlordId, status: 'let' });
  const propertyId = idFrom(r.location);
  const upload = async (supplier) => {
    const pdf = new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
    const res = await c.post('/app/invoices', await invoiceBody(c, { supplier, amount: '50.00', property_id: String(propertyId), file: pdf }), { multipart: true });
    return idFrom(res.location);
  };

  // A paid invoice: deleting it also removes the charge to the landlord and the stored file.
  const paidId = await upload('Paid Plumbing');
  await c.post(`/app/invoices/${paidId}/pay`, { paid_date: '2026-09-10', payment_method: 'Card', charge_landlord: '1' });
  const paid = db.prepare('SELECT * FROM invoices WHERE id = ?').get(paidId);
  assert.ok(paid.payment_txn_id);
  const file = path.join(config.uploadDir, String(paid.account_id), paid.file_name);
  assert.ok(fs.existsSync(file));
  r = await c.get(`/app/invoices/${paidId}`);
  assert.match(r.text, /The charge to the landlord will be removed too[\s\S]*?>Delete<\/button>/, 'paid invoices have a Delete button');
  r = await c.post(`/app/invoices/${paidId}/delete`, {});
  assert.equal(r.location, '/app/invoices?flash=' + encodeURIComponent('Deleted invoice from Paid Plumbing.'));
  assert.match((await c.get(r.location)).text, /Deleted invoice from Paid Plumbing/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE id = ?').get(paidId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id = ?').get(paid.payment_txn_id).n, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(file), 'the uploaded file is removed');

  // From the property page's list: back to the property afterwards.
  const unpaidId = await upload('Roof Repairs');
  r = await c.get(`/app/properties/${propertyId}`);
  assert.match(r.text, new RegExp(`action="/app/invoices/${unpaidId}/delete"[\\s\\S]*?name="back" value="/app/properties/${propertyId}"`));
  assert.match((await c.get('/app/invoices?month=all')).text, new RegExp(`action="/app/invoices/${unpaidId}/delete"`), 'the invoices list has Delete too');
  r = await c.post(`/app/invoices/${unpaidId}/delete`, { back: `/app/properties/${propertyId}` });
  assert.match(r.location, new RegExp(`^/app/properties/${propertyId}\\?flash=`));
  assert.match((await c.get(r.location)).text, /Deleted invoice from Roof Repairs/);

  // "back" can't send people elsewhere.
  const otherId = await upload('Gutter Co');
  r = await c.post(`/app/invoices/${otherId}/delete`, { back: 'https://evil.example/' });
  assert.match(r.location, /^\/app\/invoices\?/);

  // Another company can't delete it.
  const keepId = await upload('Keep Ltd');
  const other = await registerAndLogin('invoice-delete-2@example.com', 'Other Lets');
  assert.equal((await other.post(`/app/invoices/${keepId}/delete`, {})).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE id = ?').get(keepId).n, 1);
});


test('signed out after an hour without use, then back to the same page', async () => {
  const c = await registerAndLogin('idle@example.com', 'Idle Lets');
  const person = db.prepare("SELECT id FROM users WHERE username = 'idle'").get().id;
  const ageSession = (mins) => db.prepare("UPDATE sessions SET last_seen_at = datetime('now', ?) WHERE user_id = ?").run(`-${mins} minutes`, person);
  let r = await c.post('/app/landlords', { name: 'Ivy Idle' });
  const landlordId = idFrom(r.location);

  // Pages carry the time limit for the browser's timer.
  assert.match((await c.get('/app')).text, /<body[^>]*data-idle-minutes="60"/);
  // The ping keeps the session alive while someone is typing.
  r = await c.get('/session/ping');
  assert.equal(r.status, 200);

  // 30 minutes idle: still signed in, and using the site resets the clock.
  ageSession(30);
  assert.equal((await c.get('/app/landlords')).status, 200);
  const seen = db.prepare("SELECT last_seen_at > datetime('now', '-1 minute') AS fresh FROM sessions WHERE user_id = ?").get(person);
  assert.equal(seen.fresh, 1, 'activity refreshes the session');

  // Over an hour idle: signed out, sent to sign in, and brought back to the same page after.
  ageSession(63);
  r = await c.get(`/app/landlords/${landlordId}`);
  assert.equal(r.location, `/login?timeout=1&next=${encodeURIComponent(`/app/landlords/${landlordId}`)}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(person).n, 0, 'session ended on the server');
  r = await c.get(r.location);
  assert.match(r.text, /signed out after 1 hour without activity/);
  assert.match(r.text, new RegExp(`name="next" value="/app/landlords/${landlordId}"`));
  r = await c.post('/login', { login: 'idle', member: 'Test', password: 'kettle-harbour-58', next: `/app/landlords/${landlordId}` });
  assert.equal(r.location, `/app/landlords/${landlordId}`);
  await c.get(r.location);

  // Autosave after the session ended gets a 401 (so the page keeps the typing), not a redirect.
  ageSession(63);
  r = await c.req('POST', `/app/landlords/${landlordId}`, { name: 'Ivy Idle' });
  assert.equal(r.status, 302, 'a normal form post goes to sign in');
  await c.login('idle', 'kettle-harbour-58');
  await c.get('/app/landlords');
  ageSession(63);
  const res = await fetch(`${base}/app/landlords/${landlordId}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, name: 'Ivy Changed' }).toString(),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, signedOut: true });
  assert.equal(db.prepare('SELECT name FROM landlords WHERE id = ?').get(landlordId).name, 'Ivy Idle', 'nothing saved without a session');
  assert.equal((await c.get('/session/ping')).status, 401);

  // "next" only ever returns to a page inside the app.
  for (const bad of ['https://evil.example/', '//evil.example', '/app//evil', '/admin', '/app/../admin', '/app\\evil']) {
    r = await new Client().post('/login', { login: 'idle', member: 'Test', password: 'kettle-harbour-58', next: bad });
    assert.equal(r.location, '/app', `ignores ${bad}`);
  }

  // Signing out for inactivity from the page.
  const d = new Client();
  await d.login('idle', 'kettle-harbour-58');
  await d.get('/app/rent-run');
  r = await d.post('/logout', { reason: 'idle', next: '/app/rent-run?month=2026-08' });
  assert.equal(r.location, `/login?timeout=1&next=${encodeURIComponent('/app/rent-run?month=2026-08')}`);
  assert.equal((await d.get('/app')).location, '/login');
});

test('month end: calculate rents, email landlords, Rift report (Excel) with preview, email the report', async () => {
  const c = await registerAndLogin('month-end@example.com', 'Month End Lets');
  const accountId = db.prepare("SELECT id FROM users WHERE username = 'month-end'").get().id;
  db.prepare("UPDATE users SET email = 'office@monthend.example' WHERE id = ?").run(accountId);
  let r = await c.post('/app/landlords', { name: 'Ann Able', code: 'AA1', email: 'ann@example.com' });
  const ann = idFrom(r.location);
  r = await c.post('/app/landlords', { name: '=Bad Formula', email: 'bounce@example.com' });
  r = await c.post('/app/landlords', { name: 'Cy NoEmail' });
  r = await c.post('/app/properties', { address_line1: '1 First Street', landlord_id: ann, status: 'vacant', management_fee_pct: '10' });
  const prop = idFrom(r.location);
  r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Tess', booking_date: '2026-07-01', start_date: '2026-08-01', rent_pence: '1000', rent_frequency: 'monthly', status: 'active' });
  const tenancy = idFrom(r.location);

  assert.match((await c.get('/app')).text, /aria-label="Rent run"/, 'Rent run is in the menu');
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /<h1>Rent run<\/h1>/);
  for (const b of ['Calculate all rents', 'Email all landlords', 'Preview report', 'Download Excel', 'Email report']) assert.match(r.text, new RegExp(b), `has the ${b} button`);
  assert.match(r.text, /name="to" value="office@monthend.example"/, 'report goes to the agency by default');

  // 1. Calculate: raises the month's rent and works out every statement.
  r = await c.post('/app/monthly/calculate', { month: '2026-08' });
  assert.match(r.location, /^\/app\/rent-run\?month=2026-08&flash=/);
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Raised 1 new rent charge and calculated 3 statements for August 2026/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE tenancy_id = ? AND txn_type = 'rent_charge'").get(tenancy).n, 1);
  await c.post('/app/transactions', { txn_date: '2026-08-02', txn_type: 'rent_received', tenancy_id: tenancy, amount_pence: '1000' });
  await c.get('/app/rent-run?month=2026-08');
  r = await c.post('/app/monthly/calculate', { month: '2026-08' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Raised 0 new rent charges/, 'running it again does not double-charge');
  assert.equal(db.prepare('SELECT net_pence FROM monthly_statements WHERE landlord_id = ?').get(ann).net_pence, 90000);

  // 2. Email every landlord: sent, no address, and a failure are all reported.
  await c.get('/app/rent-run?month=2026-08');
  sentMail.length = 0;
  r = await c.post('/app/monthly/email', { month: '2026-08' });
  const msg = decodeURIComponent(r.location.replace(/\+/g, ' '));
  assert.match(msg, /Emailed 1 landlord their August 2026 statement/);
  assert.match(msg, /No email address for: Cy NoEmail/);
  assert.match(msg, /error=Couldn’t email: =Bad Formula \(Mailbox unavailable\)/);
  assert.equal(sentMail.length, 1);
  const mail = sentMail[0];
  assert.equal(mail.to, 'ann@example.com');
  assert.equal(mail.fromName, 'Month End Lets');
  assert.equal(mail.replyTo, 'office@monthend.example');
  assert.match(mail.subject, /Your statement for August 2026 from Month End Lets/);
  assert.match(mail.text, /Rent received: +£1,000\.00/);
  assert.match(mail.text, /Management fees: +−£100\.00/);
  assert.match(mail.text, /Net for the month: +£900\.00/);
  assert.match(mail.html, /1 First Street/);
  assert.ok(db.prepare('SELECT emailed_at FROM monthly_statements WHERE landlord_id = ?').get(ann).emailed_at, 'marked as emailed');
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /Ann Able[\s\S]*?badge s-active">sent/);
  assert.match(r.text, /Skip those already emailed/);
  // Sending again skips anyone already emailed; a single landlord can be emailed again.
  sentMail.length = 0;
  await c.post('/app/monthly/email', { month: '2026-08', skip_sent: '1' });
  assert.equal(sentMail.length, 0);
  await c.post('/app/monthly/email', { month: '2026-08', landlord_id: String(ann) });
  assert.equal(sentMail.length, 1);

  // 3. The Rift report: preview and Excel download, laid out like the agency's own workbook.
  await c.post('/app/rent-run/instruction', { month: '2026-08', payment_date: '2026-09-17', p_include: [], p_landlord: [], p_name: [], p_sort: [], p_account: [], p_amount: [], p_ref: [] });
  r = await c.get('/app/monthly/report?month=2026-08');
  assert.match(r.text, /Month End Lets Aug 2026 Rift Report/);
  assert.match(r.text, /MONTH END LETS AUG 2026 RIFT REPORT/);
  assert.match(r.text, /17\/09\/2026<\/td><td><a[^>]*>Ann Able<\/a><\/td><td class="num">£900\.00<\/td><td>AA1<\/td>/);
  assert.match(r.text, /Download Excel/);
  r = await c.get('/app/monthly/report.xlsx?month=2026-08');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  assert.match(r.headers.get('content-disposition'), /Month_End_Lets_Aug_2026_Rift_Report\.xlsx/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Month End Lets Aug 2026 Rift Re');
  assert.equal(ws.getCell('A1').value, 'MONTH END LETS AUG 2026 RIFT REPORT');
  assert.deepEqual([1, 2, 3, 4].map((i) => ws.getRow(3).getCell(i).value), ['Date', 'Name', 'Debit', 'LCODE']);
  assert.equal(ws.getCell('B4').value, 'Ann Able');
  assert.equal(ws.getCell('C4').value, 900);
  assert.equal(ws.getCell('D4').value, 'AA1');
  assert.equal(new Date(ws.getCell('A4').value).toISOString().slice(0, 10), '2026-09-17');
  assert.equal(ws.getCell('C6').value.formula, 'SUM(C4:C5)');
  assert.equal(ws.getCell('C6').value.result, 900);

  // 4. Preview, then email the same report with the workbook attached.
  r = await c.get('/app/monthly/report?month=2026-08&step=4');
  assert.match(r.text, /Email this report to[\s\S]*?Email report/);
  sentMail.length = 0;
  r = await c.post('/app/monthly/report/email', { month: '2026-08', to: 'boss@example.com', back: 'report' });
  assert.match(r.location, /^\/app\/monthly\/report\?month=2026-08&step=4&flash=/);
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'boss@example.com');
  assert.equal(sentMail[0].subject, 'Month End Lets Aug 2026 Rift Report');
  assert.equal(sentMail[0].attachments[0].filename, 'Month_End_Lets_Aug_2026_Rift_Report.xlsx');
  const attached = new ExcelJS.Workbook();
  await attached.xlsx.load(sentMail[0].attachments[0].content);
  assert.equal(attached.worksheets[0].getCell('B4').value, 'Ann Able');
  r = await c.post('/app/monthly/report/email', { month: '2026-08', to: 'not-an-email' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Enter the email address/);

  // Without email set up, nothing is sent and the page says why.
  mailEnabled = false;
  try {
    r = await c.get('/app/rent-run?month=2026-08');
    assert.match(r.text, /Email isn't set up yet/);
    sentMail.length = 0;
    r = await c.post('/app/monthly/email', { month: '2026-08' });
    assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Email isn’t set up yet/);
    assert.equal(sentMail.length, 0);
  } finally { mailEnabled = true; }

  // Another company can't see this report.
  const other = await registerAndLogin('month-end-2@example.com', 'Other End');
  r = await other.get('/app/monthly/report?month=2026-08');
  assert.doesNotMatch(r.text, /Ann Able/);
});

test('mailer: needs a sender and a provider, and refuses bad addresses', async () => {
  const { createMailer, isEmail } = require('../src/mailer');
  assert.equal(createMailer({}).enabled, false);
  assert.equal(createMailer({ resendApiKey: 'k' }).enabled, false, 'no EMAIL_FROM');
  assert.equal(createMailer({ resendApiKey: 'k', emailFrom: 'Rift <statements@example.com>' }).provider, 'Resend');
  assert.equal(createMailer({ smtpHost: 'smtp.example.com', emailFrom: 'statements@example.com' }).provider, 'SMTP');
  assert.ok(isEmail('a@b.co'));
  for (const bad of ['', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', 'x@y.com\r\nBcc: z@z.com']) assert.ok(!isEmail(bad), bad);
  await assert.rejects(createMailer({ smtpHost: 'h', emailFrom: 's@example.com' }).send({ to: 'bad', subject: 's', text: 't' }), /Not a valid email/);
});

test('landlords have a statement type (Email or Cheque); cheque landlords are left out of the email run', async () => {
  const c = await registerAndLogin('statement-type@example.com', 'Type Lets');
  let r = await c.get('/app/landlords/new');
  assert.match(r.text, /<label for="f-statement_type">Statement type[\s\S]*?<option value="Email" selected>Email<\/option><option value="Cheque" >Cheque<\/option>/);
  assert.match(r.text, /class="field  row-start">\s*<label for="f-address">Correspondence address[\s\S]*?class="field  ">\s*<label for="f-notes">Notes/, 'Notes sits beside the address');
  r = await c.post('/app/landlords', { name: 'Eve Email', email: 'eve@example.com' });
  const eve = idFrom(r.location);
  assert.equal(db.prepare('SELECT statement_type FROM landlords WHERE id = ?').get(eve).statement_type, 'Email', 'Email by default');
  r = await c.post('/app/landlords', { name: 'Chad Cheque', email: 'chad@example.com', statement_type: 'Cheque' });
  const chad = idFrom(r.location);
  r = await c.post('/app/landlords', { name: 'X', statement_type: 'Carrier pigeon' });
  assert.equal(r.status, 422);
  assert.match(r.text, /Choose a valid statement type/);

  r = await c.get('/app/landlords');
  assert.match(r.text, /<th[^>]*>Statement type<\/th>/);
  assert.match(r.text, /Chad Cheque[\s\S]*?Cheque/);
  r = await c.get(`/app/landlords/${chad}`);
  assert.match(r.text, /<dt>Statement type<\/dt>[\s\S]*?Cheque/);

  await c.get('/app/rent-run?month=2026-08');
  await c.post('/app/monthly/calculate', { month: '2026-08' });
  await c.get('/app/rent-run?month=2026-08');
  sentMail.length = 0;
  r = await c.post('/app/monthly/email', { month: '2026-08' });
  assert.deepEqual(sentMail.map((m) => m.to), ['eve@example.com'], 'only Email landlords are emailed');
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Left out 1 landlord paid by cheque \(print their statements\): Chad Cheque/);
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /<th>Statement type<\/th>/);
  assert.match(r.text, /Chad Cheque[\s\S]*?badge warn">Cheque[\s\S]*?Print statement/);
  assert.match(r.text, /1 paid by cheque is left out/);
});


test('the admin chooses which tabs each person sees; hidden tabs are blocked', async () => {
  const boss = await registerAndLogin('tabs-co@example.com', 'Tabs Lets');
  const companyId = db.prepare("SELECT id FROM users WHERE username = 'tabs-co'").get().id;
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  await admin.get(`/admin/users/${companyId}`);
  await admin.post(`/admin/users/${companyId}/people`, { name: 'Ada Assistant', login_name: 'ada', password: 'adas-pass-123' });
  const ada = db.prepare("SELECT id FROM users WHERE company_id = ? AND login_name = 'ada'").get(companyId).id;

  let r = await admin.get(`/admin/users/${companyId}`);
  assert.match(r.text, /Ada Assistant[\s\S]*?All tabs/);
  assert.match(r.text, new RegExp(`action="/admin/users/${companyId}/tabs/${ada}"`));
  // Ada only gets Properties, Tenants and Repairs.
  r = await admin.post(`/admin/users/${companyId}/tabs/${ada}`, { tabs: ['properties', 'tenants', 'maintenance'] });
  assert.match(decodeURIComponent(r.location), /Ada Assistant now sees 3 of 11 tabs/);
  assert.match((await admin.get(`/admin/users/${companyId}`)).text, /3 of 11 tabs/);

  const c = new Client();
  await c.login('tabs-co', 'adas-pass-123', 'ada');
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  const labels = [...rail.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).slice(1);
  assert.deepEqual(labels, ['Properties', 'Tenants', 'Maintenance']);
  assert.equal((await c.get('/app/properties')).status, 200);
  for (const blocked of ['/app/landlords', '/app/landlords/new', '/app/rent-run', '/app/monthly/report.xlsx?month=2026-08', '/app/invoices', '/app/councils', '/app/council-reconciliation']) {
    r = await c.get(blocked);
    assert.equal(r.status, 403, blocked);
  }
  assert.match((await c.get('/app/invoices')).text, /isn’t available on your login/);
  r = await c.post('/app/landlords', { name: 'Sneaky' });
  assert.equal(r.status, 403, 'changes are blocked too');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM landlords WHERE name = 'Sneaky'").get().n, 0);

  // The main login still sees everything; ticking all tabs gives Ada everything back.
  assert.equal((await boss.get('/app/landlords')).status, 200);
  await admin.get(`/admin/users/${companyId}`);
  await admin.post(`/admin/users/${companyId}/tabs/${ada}`, { tabs: ['councils', 'councilrec', 'properties', 'landlords', 'tenants', 'maintenance', 'contractors', 'invoices', 'landlordinvoices', 'rentrun', 'monthly'] });
  assert.equal(db.prepare('SELECT hidden_tabs FROM users WHERE id = ?').get(ada).hidden_tabs, null);
  assert.equal((await c.get('/app/landlords')).status, 200);

  // Only the admin can change tabs, and only for people in that company.
  assert.equal((await boss.post(`/admin/users/${companyId}/tabs/${ada}`, { tabs: ['properties'] })).status, 404);
  const other = await registerAndLogin('tabs-other@example.com', 'Other Tabs');
  const otherId = db.prepare("SELECT id FROM users WHERE username = 'tabs-other'").get().id;
  await admin.get(`/admin/users/${otherId}`);
  assert.equal((await admin.post(`/admin/users/${otherId}/tabs/${ada}`, { tabs: 'properties' })).status, 404);
  assert.ok(other);
});

test('council reconciliation: every council, money owed and in, notes, totals, month buttons', async () => {
  const c = await registerAndLogin('council-rec@example.com', 'Rec Lets');
  let r = await c.post('/app/councils', { name: 'Bristol City Council' });
  const bristol = idFrom(r.location);
  r = await c.post('/app/councils', { name: 'Quiet Council' });
  const quiet = idFrom(r.location);
  const addLet = async (addr, rent) => {
    const p = idFrom((await c.post('/app/properties', { address_line1: addr, council_id: String(bristol), status: 'vacant' })).location);
    return idFrom((await c.post(`/app/properties/${p}/add-tenant`, { tenant_mode: 'new', name: `T ${addr}`, booking_date: '2026-07-01', start_date: '2026-08-01', rent_pence: rent, rent_frequency: 'monthly', status: 'active' })).location);
  };
  const t1 = await addLet('1 Park Row', '500');
  await addLet('2 Park Row', '400');
  await c.get('/app');
  await c.post('/app/rent/raise', { month: '2026-08' });
  await c.post('/app/transactions', { txn_date: '2026-08-06', txn_type: 'rent_received', tenancy_id: t1, amount_pence: '500' });

  assert.match((await c.get('/app')).text, /class="rail-btn  rail-red" href="\/app\/council-reconciliation"/, 'red button in the menu');
  assert.match((await c.get('/app')).text, /class="rail-btn  rail-red" href="\/app\/rent-run"/, 'rent run is red too');
  r = await c.get('/app/council-reconciliation?month=2026-08');
  assert.match(r.text, /‹ Previous month<\/a>/);
  assert.match(r.text, /href="\/app\/council-reconciliation\?month=2026-07">‹ Previous month/);
  assert.match(r.text, /href="\/app\/council-reconciliation\?month=2026-09">Next month ›/);
  assert.match(r.text, /August 2026/);
  assert.match(r.text, /<th[^>]*>Money owed<\/th><th[^>]*>Money in<\/th>/);
  assert.match(r.text, /Bristol City Council[\s\S]*?name="owed"[^>]*placeholder="900\.00"[\s\S]*?name="received"[^>]*placeholder="500\.00"[\s\S]*?£400\.00[\s\S]*?Part paid/);
  assert.match(r.text, /Quiet Council[\s\S]*?Nothing due/, 'every council is listed, even with nothing due');
  assert.match(r.text, /class="total"[\s\S]*?£900\.00[\s\S]*?£500\.00[\s\S]*?£400\.00/);

  // Notes save (as the page's autosave does) and belong to that council and month.
  const res = await fetch(`${base}/app/council-reconciliation/notes`, {
    method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, council_id: String(bristol), month: '2026-08', notes: 'Chased 2 Park Row payment' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.match((await c.get('/app/council-reconciliation?month=2026-08')).text, />Chased 2 Park Row payment<\/textarea>/);
  assert.doesNotMatch((await c.get('/app/council-reconciliation?month=2026-09')).text, /Chased 2 Park Row/);

  // Money owed and money in can be typed straight into the table; they replace the calculated
  // figures for that council and month, and the reply carries the new still-owed, status and totals.
  const save = async (fields) => fetch(`${base}/app/council-reconciliation/notes`, {
    method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, council_id: String(bristol), month: '2026-08', notes: 'Chased 2 Park Row payment', ...fields }).toString(),
  });
  let saved = await save({ owed: '950', received: '£950.00' });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.updates.find((u) => u.id === `rec-status-${bristol}`), { id: `rec-status-${bristol}`, text: 'Paid in full', className: 'badge s-active plain' });
  assert.equal(body.updates.find((u) => u.id === 'rec-total-owed').text, '£950.00');
  r = await c.get('/app/council-reconciliation?month=2026-08');
  assert.match(r.text, /name="owed"[^>]*value="950\.00"[^>]*placeholder="900\.00"/);
  assert.doesNotMatch(r.text, /calculated £/);
  assert.doesNotMatch(r.text, /recorded £/);
  assert.match(r.text, /id="rec-total-received">£950\.00/);
  saved = await save({ owed: 'lots', received: '' });
  assert.equal(saved.status, 422);
  assert.match((await saved.json()).errors.owed, /like 950/);
  // Clearing the boxes goes back to the calculated figures.
  saved = await save({ owed: '', received: '' });
  assert.equal(saved.status, 200);
  assert.match((await c.get('/app/council-reconciliation?month=2026-08')).text, /id="rec-total-owed">£900\.00/);

  // Detail for one council.
  r = await c.get(`/app/council-reconciliation?month=2026-08&council_id=${bristol}`);
  assert.match(r.text, /id="detail"[\s\S]*?1 Park Row[\s\S]*?Paid[\s\S]*?2 Park Row[\s\S]*?Not paid[\s\S]*?Record payment/);

  // Other companies can't write notes on these councils.
  const other = await registerAndLogin('council-rec-2@example.com', 'Other Rec');
  r = await other.post('/app/council-reconciliation/notes', { council_id: String(quiet), month: '2026-08', notes: 'x' });
  assert.equal(r.status, 404);
});

test('admin Tab access page: every person against every tab, saved in one go', async () => {
  await registerAndLogin('grid-co@example.com', 'Grid Lets');
  const companyId = db.prepare("SELECT id FROM users WHERE username = 'grid-co'").get().id;
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  await admin.get(`/admin/users/${companyId}`);
  await admin.post(`/admin/users/${companyId}/people`, { name: 'Bea Clerk', login_name: 'bea', password: 'beas-pass-123' });
  const bea = db.prepare("SELECT id FROM users WHERE company_id = ? AND login_name = 'bea'").get(companyId).id;

  assert.match((await admin.get('/admin')).text, /aria-label="Tab access"/, 'in the admin menu');
  let r = await admin.get(`/admin/access?company=${companyId}`);
  assert.match(r.text, /Grid Lets[\s\S]*?Test User[\s\S]*?main login[\s\S]*?Bea Clerk/);
  assert.match(r.text, new RegExp(`name="t_${bea}" value="councilrec" checked`));
  // Bea: only Rent run and Monthly statements. The main login (companyId) keeps everything.
  const all = ['councils', 'councilrec', 'properties', 'landlords', 'tenants', 'maintenance', 'contractors', 'invoices', 'landlordinvoices', 'rentrun', 'monthly'];
  r = await admin.post('/admin/access', { company: String(companyId), people: [String(companyId), String(bea)], [`t_${companyId}`]: all, [`t_${bea}`]: ['rentrun', 'monthly'] });
  assert.match(decodeURIComponent(r.location), /Saved tab access for 2 people/);
  assert.equal(db.prepare('SELECT hidden_tabs FROM users WHERE id = ?').get(companyId).hidden_tabs, null);
  assert.deepEqual(JSON.parse(db.prepare('SELECT hidden_tabs FROM users WHERE id = ?').get(bea).hidden_tabs).length, 9);

  const c = new Client();
  await c.login('grid-co', 'beas-pass-123', 'bea');
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...rail.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).slice(1), ['Rent run', 'Monthly statements']);
  assert.equal((await c.get('/app/properties')).status, 403);

  // Only the admin can use it; the admin's own login can't be restricted.
  assert.equal((await c.get('/admin/access')).status, 404);
  const adminId = db.prepare('SELECT id FROM users WHERE is_admin = 1').get().id;
  await admin.get('/admin/access');
  await admin.post('/admin/access', { people: [String(adminId)], [`t_${adminId}`]: [] });
  assert.equal(db.prepare('SELECT hidden_tabs FROM users WHERE id = ?').get(adminId).hidden_tabs, null);
});

test('tenant page: a second box with the council, property and tenancy agreement', async () => {
  const c = await registerAndLogin('tenant-box@example.com', 'Box Lets');
  let r = await c.post('/app/councils', { name: 'Leeds City Council', council_tax_phone: '0113 222 4404' });
  const leeds = idFrom(r.location);
  r = await c.post('/app/landlords', { name: 'Lou Landlord' });
  const lou = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '7 Canal Street', town: 'Leeds', postcode: 'LS1 4AB', landlord_id: String(lou), council_id: String(leeds), council_tax_account: 'CT-777', council_tax_payer: 'Tenant', status: 'vacant' });
  const prop = idFrom(r.location);
  r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Nina Tenant', booking_date: '2026-07-10', start_date: '2026-08-01', rent_pence: '850', rent_frequency: 'monthly', status: 'active' });
  const tenancy = idFrom(r.location);
  const tenant = db.prepare('SELECT tenant_id FROM tenancies WHERE id = ?').get(tenancy).tenant_id;

  r = await c.get(`/app/tenants/${tenant}`);
  assert.match(r.text, /<dl class="details">[\s\S]*?<\/dl>[\s\S]*?class="card tenant-box"/, 'second box after the tenant details');
  assert.match(r.text, /Current tenancy/);
  // On the tenant's page the council sits in the top box, right of Phone, not in the tenancy box.
  assert.match(r.text, /<dl class="details">[\s\S]*?<dt>Phone<\/dt>[\s\S]*?<dt>Council<\/dt>\s*<dd><a href="\/app\/councils\/\d+">Leeds City Council<\/a>[\s\S]*?<\/dl>/);
  assert.doesNotMatch(r.text, /<h3>Council<\/h3>/);
  assert.match(r.text, /<h3>Property<\/h3>[\s\S]*?7 Canal Street[\s\S]*?Leeds, LS1 4AB[\s\S]*?Lou Landlord/);
  assert.doesNotMatch(r.text, /Deposit/);
  assert.doesNotMatch((await c.get(`/app/properties/${prop}/add-tenant`)).text, /Deposit/);
  assert.match(r.text, /<h3>Tenancy agreement<\/h3>[\s\S]*?10\/07\/2026[\s\S]*?01\/08\/2026 – ongoing[\s\S]*?£850\.00 a month[\s\S]*?No signed agreement uploaded yet/);

  // Upload the signed agreement from the tenant page; it's shown and can be opened.
  const pdf = new File([Buffer.from('%PDF-1.4\n%signed\n')], 'Nina agreement.pdf');
  r = await c.post(`/app/tenancies/${tenancy}/agreement`, { agreement: pdf, back: `/app/tenants/${tenant}` }, { multipart: true });
  assert.equal(r.location, `/app/tenants/${tenant}#tenancy-${tenancy}`);
  r = await c.get(`/app/tenants/${tenant}`);
  assert.match(r.text, /Nina agreement\.pdf/);
  assert.match(r.text, /Replace agreement/);
  r = await c.get(`/app/tenancies/${tenancy}/agreement`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.match((await c.get(`/app/tenancies/${tenancy}`)).text, /Nina agreement\.pdf/, 'also on the tenancy page');

  // Wrong file types are refused; other companies can't see or change it.
  r = await c.post(`/app/tenancies/${tenancy}/agreement`, { agreement: new File(['<html>'], 'x.pdf'), back: `/app/tenants/${tenant}` }, { multipart: true });
  assert.match(decodeURIComponent(r.location), /PDF, JPG or PNG/);
  const other = await registerAndLogin('tenant-box-2@example.com', 'Other Box');
  assert.equal((await other.get(`/app/tenancies/${tenancy}/agreement`)).status, 404);
  assert.equal((await other.post(`/app/tenancies/${tenancy}/agreement/delete`, {})).status, 404);

  r = await c.post(`/app/tenancies/${tenancy}/agreement/delete`, { back: `/app/tenants/${tenant}` });
  assert.match((await c.get(`/app/tenants/${tenant}`)).text, /No signed agreement uploaded yet/);
  // "back" can only return to a tenant or tenancy page.
  r = await c.post(`/app/tenancies/${tenancy}/agreement/delete`, { back: 'https://evil.example/' });
  assert.equal(r.location, `/app/tenancies/${tenancy}#tenancy-${tenancy}`);
});

test('rent run step 5: payment instruction template and a filled-in instruction to print', async () => {
  const c = await registerAndLogin('pay-instr@example.com', 'Pay Lets');
  let r = await c.post('/app/landlords', { name: 'Paula Paid', code: 'PP1', bank_account_name: 'P Paid', bank_sort_code: '12 34 56', bank_account_number: '12345678' });
  const paula = idFrom(r.location);
  assert.deepEqual({ ...db.prepare('SELECT bank_sort_code, bank_account_number FROM landlords WHERE id = ?').get(paula) }, { bank_sort_code: '12-34-56', bank_account_number: '12345678' });
  r = await c.post('/app/landlords', { name: 'Bad Bank', bank_sort_code: '12', bank_account_number: 'abc' });
  assert.equal(r.status, 422);
  assert.match(r.text, /6-digit sort code/);
  assert.match(r.text, /8-digit account number/);
  r = await c.post('/app/landlords', { name: 'Cheque Charlie', statement_type: 'Cheque' });
  const charlie = idFrom(r.location);
  for (const [ll, addr] of [[paula, '1 Pay Street'], [charlie, '2 Pay Street']]) {
    const p = idFrom((await c.post('/app/properties', { address_line1: addr, landlord_id: String(ll), status: 'vacant' })).location);
    const t = idFrom((await c.post(`/app/properties/${p}/add-tenant`, { tenant_mode: 'new', name: `T ${addr}`, booking_date: '2026-07-01', start_date: '2026-08-01', rent_pence: '1000', rent_frequency: 'monthly', status: 'active' })).location);
    await c.post('/app/transactions', { txn_date: '2026-08-03', txn_type: 'rent_received', tenancy_id: t, amount_pence: '1000' });
  }
  await c.get('/app/rent-run?month=2026-08');
  await c.post('/app/monthly/calculate', { month: '2026-08' });

  r = await c.get('/app/rent-run?month=2026-08');
  // Step 5 is its own box, after the steps, with the form's details to edit.
  assert.match(r.text, /<\/ol>\s*<\/section>\s*<details class="card step5 fold" id="transfer-sheet">\s*<summary><h2><span class="step-no">4<\/span> Bank transfer sheet<\/h2><\/summary>[\s\S]*?id="bulk-file">\s*<summary><h2><span class="step-no">5<\/span> Metro Bank bulk payment file<\/h2><\/summary>[\s\S]*?id="payment-instruction">\s*<summary><h2><span class="step-no">5\.1<\/span> Metro Bank Bulk Payment Instruction<\/h2><\/summary>[\s\S]*?class="btn small blank-form"[^>]*>Blank form/, 'steps 4, 5 and 5.1 in order');
  assert.match(r.text, /<li class="sub" data-step="3\.1">\s*<div><strong>Email the report<\/strong>/, 'emailing the report is step 3.1');
  assert.doesNotMatch(r.text, /Check payments/);
  assert.match(r.text, /name="totalFigures" value="£1,000-00"/, 'total worked out from the payments');
  assert.match(r.text, /name="totalWords" value="ONE THOUSAND POUNDS ONLY"/);
  assert.match(r.text, /name="count" value="1"/);
  assert.doesNotMatch(r.text, /name="store"/, 'no Store box');
  assert.match(r.text, /name="contact_name" value="Test User"/, 'contact name suggested');
  assert.match(r.text, /<table class="centered">/, 'landlords table is centred');

  // Save the blank template, then download / print it.
  const pdf = new File([Buffer.from('%PDF-1.4\n%metro form\n')], 'Metro payment instruction.pdf');
  r = await c.post('/app/rent-run/template', { template: pdf, month: '2026-08' }, { multipart: true });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Saved Metro payment instruction\.pdf as your payment instruction template/);
  r = await c.get('/app/rent-run/template?download=1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Metro payment instruction\.pdf"/);
  r = await c.get('/app/rent-run/template');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', 'can be framed by the site so it can be printed');
  r = await c.post('/app/rent-run/template', { template: new File(['<script>'], 'x.pdf'), month: '2026-08' }, { multipart: true });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /PDF, JPG or PNG/);

  // Fill in: bank-paid landlords with money held, using their bank details; cheque landlords left out.
  r = await c.get('/app/rent-run/instruction?month=2026-08');
  assert.match(r.text, /name="p_name" value="P Paid"[\s\S]*?value="12-34-56"[\s\S]*?value="12345678"[\s\S]*?name="p_amount" value="1000\.00"[\s\S]*?value="PP1 Rent Aug 26"/);
  assert.doesNotMatch(r.text, /Cheque Charlie/);
  r = await c.post('/app/rent-run/instruction', {
    month: '2026-08', from_name: 'Pay Lets Client Account', from_sort_code: '23-05-80', from_account_number: '87654321', payment_date: '2026-09-01',
    signatory_1: 'Theo', signatory_2: '', notes: '',
    p_include: ['0'], p_landlord: [String(paula), ''], p_name: ['P Paid', 'Extra Person'], p_sort: ['12-34-56', ''], p_account: ['12345678', ''], p_amount: ['1000.00', '50'], p_ref: ['PP1 Rent Aug', 'x'],
    then: 'print',
  });
  assert.equal(r.location, '/app/rent-run/instruction/print?month=2026-08');
  r = await c.get(r.location);
  assert.match(r.text, /Metro Bank[\s\S]*?Payment instruction[\s\S]*?Pay Lets[\s\S]*?01\/09\/2026/);
  assert.match(r.text, /Pay Lets Client Account[\s\S]*?23-05-80[\s\S]*?87654321/);
  assert.match(r.text, /P Paid<\/td><td>12-34-56<\/td><td>12345678<\/td><td>PP1 Rent Aug<\/td><td class="num">£1,000\.00/);
  assert.doesNotMatch(r.text, /Extra Person/, 'unticked rows are not printed');
  assert.match(r.text, /Total<\/td><td class="num">£1,000\.00/);
  // Metro's own form, filled in, with the list of payments attached.
  r = await c.get('/app/rent-run/instruction/metro.pdf?month=2026-08');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const { PDFDocument } = require('pdf-lib');
  const { fillMetroForm, amountInWords } = require('../src/metroForm');
  const bytes = await fillMetroForm({ store: 'Borehamwood', accountName: 'Pay Lets Client Account', contactName: 'Theo', accountNumber: '87654321',
    valueDate: '01/09/2026', payees: [{ name: 'P Paid', sort_code: '12-34-56', account_number: '12345678', reference: 'PP1', pence: 100000 }], monthLabel: 'August 2026' });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1, 'just the Metro form, no Bulk Payment File pages');
  assert.equal(amountInWords(123456), 'ONE THOUSAND TWO HUNDRED AND THIRTY-FOUR POUNDS AND FIFTY-SIX PENCE');
  assert.equal(amountInWords(100000), 'ONE THOUSAND POUNDS ONLY');
  assert.equal((await c.get('/app/rent-run/metro-blank.pdf')).status, 200);
  // Saved: reopening keeps what was typed; a new month remembers "paying from".
  assert.match((await c.get('/app/rent-run/instruction?month=2026-08')).text, /value="Pay Lets Client Account"[\s\S]*?Extra Person/);
  assert.match((await c.get('/app/rent-run/instruction?month=2026-09')).text, /value="Pay Lets Client Account"/);
  // Missing bank details on a ticked row are flagged.
  r = await c.post('/app/rent-run/instruction', { month: '2026-08', p_include: ['0'], p_landlord: [''], p_name: ['No Details'], p_sort: [''], p_account: [''], p_amount: [''], p_ref: [''] });
  assert.equal(r.status, 422);
  assert.match(r.text, /No Details: sort code should be 6 digits[\s\S]*?account number should be 8 digits[\s\S]*?enter the amount/);

  // Private to the company.
  const other = await registerAndLogin('pay-instr-2@example.com', 'Other Pay');
  assert.equal((await other.get('/app/rent-run/template')).status, 404);
  assert.doesNotMatch((await other.get('/app/rent-run/instruction?month=2026-08')).text, /Pay Lets Client Account|P Paid/);
});

test('invoices have a month switcher', async () => {
  const c = await registerAndLogin('inv-month@example.com', 'Inv Month Lets');
  const pdf = () => new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  await c.get('/app/invoices/new');
  await c.post('/app/invoices', await invoiceBody(c, { supplier: 'July Plumbing', amount: '10', invoice_date: '2026-07-10', due_date: '2026-07-20', file: pdf() }), { multipart: true });
  await c.post('/app/invoices', await invoiceBody(c, { supplier: 'August Roofing', amount: '20', invoice_date: '2026-08-05', due_date: '2026-08-30', file: pdf() }), { multipart: true });

  let r = await c.get('/app/invoices?month=2026-08');
  assert.match(r.text, /href="\/app\/invoices\?month=2026-07">‹ Previous month/);
  assert.match(r.text, /href="\/app\/invoices\?month=2026-09">Next month ›/);
  assert.match(r.text, /name="month" value="2026-08"/);
  assert.match(r.text, /August Roofing/);
  assert.doesNotMatch(r.text, /July Plumbing/);
  assert.match((await c.get('/app/invoices?month=2026-07')).text, /July Plumbing/);
  r = await c.get('/app/invoices?month=all');
  assert.match(r.text, /July Plumbing[\s\S]*?August Roofing|August Roofing[\s\S]*?July Plumbing/);
  // Tabs keep the month; the unpaid/overdue boxes cover every month.
  r = await c.get('/app/invoices?month=2026-08&status=unpaid');
  assert.match(r.text, /August Roofing/);
  assert.doesNotMatch(r.text, /July Plumbing/);
  assert.match(r.text, /href="\/app\/invoices\?month=2026-08&amp;status=paid"/);
  assert.match(r.text, /Unpaid · all months[\s\S]*?£30\.00/);
  assert.match((await c.get('/app/invoices?status=overdue')).text, /July Plumbing/, 'overdue with no month shows every month');
});

test('invoices link to their property and show whether they were deducted, with the statement', async () => {
  const c = await registerAndLogin('inv-deduct@example.com', 'Deduct Lets');
  let r = await c.post('/app/landlords', { name: 'Dora Deduct' });
  const dora = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '4 Drain Lane', landlord_id: String(dora), status: 'let' });
  const prop = idFrom(r.location);
  const pdf = () => new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  await c.get('/app/invoices/new');
  const charged = idFrom((await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Drain Co', amount: '120', invoice_date: '2026-08-02', property_id: String(prop), file: pdf() }), { multipart: true })).location);
  const notCharged = idFrom((await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Paint Co', amount: '40', invoice_date: '2026-08-03', property_id: String(prop), file: pdf() }), { multipart: true })).location);
  await c.get(`/app/invoices/${charged}`);
  await c.post(`/app/invoices/${charged}/pay`, { paid_date: '2026-08-10', payment_method: 'Bank transfer', charge_landlord: '1' });
  await c.post(`/app/invoices/${notCharged}/pay`, { paid_date: '2026-08-11', payment_method: 'Card' });

  r = await c.get('/app/invoices?month=2026-08');
  assert.match(r.text, /<th>Deducted<\/th>/);
  assert.match(r.text, new RegExp(`Drain Co[\\s\\S]*?<a href="/app/properties/${prop}">4 Drain Lane</a>[\\s\\S]*?yes-no yes">Yes[\\s\\S]*?href="/app/monthly\\?month=2026-08"[^>]*>View statement`));
  assert.match(r.text, /Paint Co[\s\S]*?yes-no no">No/);
  // Once the month's statement is made, the link goes to it, and it shows the deduction.
  await c.get('/app/monthly?month=2026-08');
  await c.post('/app/monthly/generate', { month: '2026-08', landlord_id: String(dora) });
  const statementId = db.prepare('SELECT id FROM monthly_statements WHERE landlord_id = ?').get(dora).id;
  r = await c.get('/app/invoices?month=2026-08');
  assert.match(r.text, new RegExp(`href="/app/monthly/${statementId}"[^>]*>View statement`));
  assert.match((await c.get(`/app/monthly/${statementId}`)).text, /Drain Co[\s\S]*?£120\.00/);
  // Also on the property's page and the invoice's own page.
  assert.match((await c.get(`/app/properties/${prop}`)).text, /Drain Co[\s\S]*?yes-no yes">Yes/);
  assert.match((await c.get(`/app/invoices/${charged}`)).text, /Deducted from landlord[\s\S]*?yes-no yes">Yes<\/span> Dora Deduct/);
  assert.match((await c.get(`/app/invoices/${notCharged}`)).text, /Deducted from landlord[\s\S]*?yes-no no">No/);
});

test('Transactions is not in the menu, but recording payments still works', async () => {
  const c = await registerAndLogin('no-txn-tab@example.com', 'No Txn Lets');
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(rail, /aria-label="Transactions"/);
  assert.equal((await c.get('/app/transactions/new?txn_type=rent_received')).status, 200);
});

test('Tab access uses the same names as the menu', async () => {
  const { TABS } = require('../src/tabs');
  const c = await registerAndLogin('tab-names@example.com', 'Tab Names Lets');
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  const menu = [...rail.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).slice(1);
  assert.deepEqual(TABS.map((t) => t.label), menu);
});

test('contractors: every supplier listed with how much has been paid to them in total', async () => {
  const c = await registerAndLogin('contractors@example.com', 'Contractor Lets');
  const accountId = db.prepare("SELECT id FROM users WHERE username = 'contractors'").get().id;
  const pdf = () => new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  await c.get('/app/invoices/new');
  const upload = async (supplier, amount, date) => idFrom((await c.post('/app/invoices', await invoiceBody(c, { supplier, amount, invoice_date: date, file: pdf() }), { multipart: true })).location);
  const a1 = await upload('Heat Ltd', '100', '2026-06-01');
  const a2 = await upload('heat ltd ', '50', '2026-08-01'); // same contractor despite capitals/spaces
  await upload('Heat Ltd', '30', '2026-08-15'); // left unpaid
  const b1 = await upload('Sparks Electrical', '200', '2026-07-01');
  for (const id of [a1, a2, b1]) await c.post(`/app/invoices/${id}/pay`, { paid_date: '2026-08-20', payment_method: 'Bank transfer' });

  const contractors = db.prepare('SELECT * FROM contractors WHERE account_id = ? ORDER BY name').all(accountId);
  assert.deepEqual(contractors.map((x) => x.name), ['Heat Ltd', 'Sparks Electrical'], 'added automatically from invoices, once each');
  const heat = contractors[0].id;

  // Menu: Contractors sits above Invoices; Compliance is gone.
  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  const labels = [...rail.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.indexOf('Contractors') + 1, labels.indexOf('Contractors Invoices'));
  assert.ok(!labels.includes('Compliance'));

  let r = await c.get('/app/contractors');
  assert.match(r.text, /<th[^>]*>Total paid<\/th>/);
  assert.match(r.text, /Heat Ltd[\s\S]*?<td[^>]*>\s*3\s*<\/td>[\s\S]*?£150\.00[\s\S]*?£30\.00/);
  assert.match(r.text, /Sparks Electrical[\s\S]*?£200\.00/);
  assert.match(r.text, /class="total"[\s\S]*?4[\s\S]*?£350\.00[\s\S]*?£30\.00/);

  // A contractor's page lists their invoices and total paid, with an upload link that fills them in.
  r = await c.get(`/app/contractors/${heat}`);
  assert.match(r.text, /Invoices <span class="count">3<\/span> <span class="muted small">· £150\.00 paid in total/);
  assert.match(r.text, new RegExp(`/app/invoices/new\\?contractor_id=${heat}`));
  assert.match((await c.get(`/app/invoices/new?contractor_id=${heat}`)).text, /name="supplier"[^>]*value="Heat Ltd"/);

  // Renaming keeps their history and updates the invoices.
  await c.get(`/app/contractors/${heat}/edit`);
  await c.post(`/app/contractors/${heat}`, { name: 'Heat & Gas Ltd', trade: 'Heating engineer' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE contractor_id = ? AND supplier = ?').get(heat, 'Heat & Gas Ltd').n, 3);
  assert.match((await c.get('/app/contractors')).text, /Heat &amp; Gas Ltd[\s\S]*?Heating engineer[\s\S]*?£150\.00/);

  // Compliance pages still work from a property (certificates), just not in the menu.
  assert.equal((await c.get('/app/compliance/new')).status, 200);
});

test('landlord invoices: bill a landlord, deduct from rent or mark paid, print and email', async () => {
  const c = await registerAndLogin('ll-invoices@example.com', 'Bill Lets');
  let r = await c.post('/app/landlords', { name: 'Larry Landlord', code: 'LL9', email: 'larry@example.com', address: '1 Home Road' });
  const larry = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '8 Bill Street', landlord_id: String(larry), status: 'let' });
  const prop = idFrom(r.location);

  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  const labels = [...rail.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.indexOf('Contractors Invoices') + 1, labels.indexOf('Landlord Invoices'));
  assert.match((await c.get('/app/invoices')).text, /<h1>Contractors invoices<\/h1>/);

  r = await c.get(`/app/landlord-invoices/new?property_id=${prop}`);
  assert.match(r.text, /name="invoice_number" value="LI-0001"/);
  assert.match(r.text, new RegExp(`<option value="${larry}" selected>Larry Landlord`), 'landlord filled in from the property');
  r = await c.post('/app/landlord-invoices', { landlord_id: String(larry), property_id: String(prop), invoice_number: 'LI-0001', invoice_date: '2026-08-04', due_date: '2026-08-18', description: 'Tenant find fee', amount: '£300', notes: 'Thank you' });
  const inv1 = idFrom(r.location);
  r = await c.post('/app/landlord-invoices', { landlord_id: '', invoice_number: '', invoice_date: 'x', description: '', amount: 'lots' });
  assert.equal(r.status, 422);
  assert.match((await c.get('/app/landlord-invoices/new')).text, /name="invoice_number" value="LI-0002"/, 'numbers count up');

  // The invoice page is printable, with who it's billed to.
  r = await c.get(`/app/landlord-invoices/${inv1}`);
  assert.match(r.text, /\(Maintenance Invoice\)[\s\S]*?Client<\/strong>:<\/span><span>Larry Landlord[\s\S]*?Property Address:[\s\S]*?8 Bill Street[\s\S]*?INVOICE[\s\S]*?<li>Tenant find fee<\/li>[\s\S]*?TOTAL<\/strong><strong>£300\.00/);
  assert.match(r.text, /data-print/);

  // Deduct from rent: a fee on the landlord's statement for that month.
  r = await c.post(`/app/landlord-invoices/${inv1}/settle`, { how: 'deduct', date: '2026-08-20' });
  assert.match(decodeURIComponent(r.location), /Deducted £300\.00 from Larry Landlord's rent for August 2026/);
  const li = db.prepare('SELECT * FROM landlord_invoices WHERE id = ?').get(inv1);
  assert.equal(li.status, 'paid');
  const fee = db.prepare('SELECT * FROM transactions WHERE id = ?').get(li.txn_id);
  assert.equal(fee.txn_type, 'fee');
  assert.equal(fee.amount_pence, 30000);
  assert.equal(fee.landlord_id, larry);
  await c.get('/app/monthly?month=2026-08');
  await c.post('/app/monthly/generate', { month: '2026-08', landlord_id: String(larry) });
  const statement = db.prepare("SELECT * FROM monthly_statements WHERE landlord_id = ? AND month = '2026-08'").get(larry);
  assert.equal(statement.fees_pence, 30000, 'on their statement as a deduction');
  r = await c.get('/app/landlord-invoices?month=2026-08');
  assert.match(r.text, new RegExp(`LI-0001[\\s\\S]*?Larry Landlord[\\s\\S]*?8 Bill Street[\\s\\S]*?Deducted 20/08/2026[\\s\\S]*?yes-no yes">Yes[\\s\\S]*?href="/app/monthly/${statement.id}"`));

  // Undo removes the deduction.
  await c.post(`/app/landlord-invoices/${inv1}/unsettle`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id = ?').get(li.txn_id).n, 0);
  // Paid by the landlord: no deduction.
  await c.post(`/app/landlord-invoices/${inv1}/settle`, { how: 'paid', date: '2026-08-22' });
  const paid = db.prepare('SELECT * FROM landlord_invoices WHERE id = ?').get(inv1);
  assert.equal(paid.paid_how, 'Paid by landlord');
  assert.equal(paid.txn_id, null);
  assert.match((await c.get('/app/landlord-invoices?month=2026-08')).text, /yes-no no">No/);

  // Email to the landlord.
  sentMail.length = 0;
  r = await c.post(`/app/landlord-invoices/${inv1}/email`, {});
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'larry@example.com');
  assert.match(sentMail[0].subject, /Invoice LI-0001 from Bill Lets/);
  assert.match(sentMail[0].text, /Tenant find fee[\s\S]*?£300\.00/);

  // Private to the company; deleting removes it.
  const other = await registerAndLogin('ll-invoices-2@example.com', 'Other Bill');
  assert.equal((await other.get(`/app/landlord-invoices/${inv1}`)).status, 404);
  await c.post(`/app/landlord-invoices/${inv1}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM landlord_invoices WHERE id = ?').get(inv1).n, 0);
});

test('contractor invoices: no invoice number or due date on the form; file, supplier and "Added by" on one line', async () => {
  const c = await registerAndLogin('added-by@example.com', 'Added By Lets');
  const companyId = db.prepare("SELECT id FROM users WHERE username = 'added-by'").get().id;
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  await admin.get(`/admin/users/${companyId}`);
  await admin.post(`/admin/users/${companyId}/people`, { name: 'Pat Clerk', login_name: 'pat', password: 'pats-pass-123' });
  const pat = db.prepare("SELECT id FROM users WHERE company_id = ? AND login_name = 'pat'").get(companyId).id;

  let r = await c.get('/app/invoices/new');
  assert.doesNotMatch(r.text, /name="invoice_number"|name="due_date"/);
  assert.match(r.text, /<div class="field wide top-trio">\s*<div class="field">\s*<label for="f-file">[\s\S]*?<label for="f-supplier">[\s\S]*?<label for="f-added_by">Added by <span class="req">\*<\/span><\/label>/, 'Invoice file, Supplier and Added by share one line');
  assert.match(r.text, new RegExp(`<option value="${companyId}" selected>Test User</option><option value="${pat}" >Pat Clerk</option>`), 'defaults to whoever is signed in');

  const pdf = new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Lock Co', amount: '75', invoice_date: '2026-09-01', added_by: String(pat), file: pdf }), { multipart: true });
  const id = idFrom(r.location);
  assert.equal(db.prepare('SELECT added_by FROM invoices WHERE id = ?').get(id).added_by, pat);
  assert.match((await c.get(`/app/invoices/${id}`)).text, /<dt>Added by<\/dt><dd>Pat Clerk<\/dd>/);
  // Someone from another company can't be picked.
  const other = await registerAndLogin('added-by-2@example.com', 'Other Added');
  const otherId = db.prepare("SELECT id FROM users WHERE username = 'added-by-2'").get().id;
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Lock Co', amount: '5', added_by: String(otherId), file: new File([Buffer.from('%PDF-1.4\n')], 'j.pdf') }), { multipart: true });
  assert.equal(r.status, 422);
  assert.ok(other);
  // Editing keeps an existing invoice number / due date.
  db.prepare("UPDATE invoices SET invoice_number = 'INV-9', due_date = '2026-09-30' WHERE id = ?").run(id);
  await c.get(`/app/invoices/${id}/edit`);
  const cur = db.prepare('SELECT maintenance_job_id, property_id FROM invoices WHERE id = ?').get(id);
  await c.post(`/app/invoices/${id}`, { supplier: 'Lock Co', amount: '80', invoice_date: '2026-09-01', added_by: String(pat), maintenance_job_id: String(cur.maintenance_job_id), property_id: String(cur.property_id), description: 'Lock change', charge_landlord: 'yes', landlord_amount: '80' }, { multipart: true });
  assert.deepEqual({ ...db.prepare('SELECT invoice_number, due_date, amount_pence FROM invoices WHERE id = ?').get(id) }, { invoice_number: 'INV-9', due_date: '2026-09-30', amount_pence: 8000 });
});

test('contractor invoice form offers the saved contractors as a type-to-narrow list', async () => {
  const c = await registerAndLogin('supplier-list@example.com', 'Supplier List Lets');
  await c.post('/app/contractors', { name: 'Ace Plumbing', trade: 'Plumber' });
  await c.post('/app/contractors', { name: 'Bright Sparks', trade: 'Electrician' });
  const r = await c.get('/app/invoices/new');
  assert.match(r.text, /name="supplier"[^>]*list="contractor-list"/);
  assert.match(r.text, /<datalist id="contractor-list"><option value="Ace Plumbing">Plumber<\/option><option value="Bright Sparks">Electrician<\/option><\/datalist>/);
  assert.match(r.text, /<h1>Upload contractor invoice<\/h1>/);
});

test('"Deduct from landlord" straight from adding a contractor or landlord invoice', async () => {
  const c = await registerAndLogin('deduct-now@example.com', 'Deduct Now Lets');
  let r = await c.post('/app/landlords', { name: 'Nora Now' });
  const nora = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '3 Quick Street', landlord_id: String(nora), status: 'let' });
  const prop = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: 'No Landlord House', status: 'vacant' });
  const lonely = idFrom(r.location);
  const pdf = () => new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');

  // Contractor invoice.
  r = await c.get('/app/invoices/new');
  assert.match(r.text, /name="then" value="deduct"[^>]*>Upload &amp; deduct from landlord/);
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Quick Fix', amount: '90', invoice_date: '2026-08-12', property_id: String(prop), then: 'deduct', file: pdf() }), { multipart: true });
  const inv = idFrom(r.location.split('?')[0]);
  assert.match(decodeURIComponent(r.location), /Deducted £90\.00 from Nora Now for August 2026/);
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv);
  assert.equal(row.status, 'paid');
  assert.equal(row.paid_date, '2026-08-12');
  const exp = db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.payment_txn_id);
  assert.deepEqual([exp.txn_type, exp.landlord_id, exp.amount_pence], ['expense', nora, 9000]);
  // Without a landlord to charge, it says so and nothing is saved.
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Quick Fix', amount: '10', property_id: String(lonely), then: 'deduct', file: pdf() }), { multipart: true });
  assert.equal(r.status, 422);
  assert.match(r.text, /To deduct from a landlord, choose the landlord/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE property_id = ?').get(lonely).n, 0);
  // Plain upload still leaves it unpaid.
  r = await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Quick Fix', amount: '20', property_id: String(prop), then: 'save', file: pdf() }), { multipart: true });
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(idFrom(r.location)).status, 'unpaid');

  // Landlord invoice.
  r = await c.get('/app/landlord-invoices/new');
  assert.match(r.text, /name="then" value="deduct"[^>]*>Create &amp; deduct from rent/);
  r = await c.post('/app/landlord-invoices', { landlord_id: String(nora), property_id: String(prop), invoice_number: 'LI-0001', invoice_date: '2026-08-15', due_date: '2026-08-29', description: 'Inspection', amount: '60', notes: 'Annual inspection', then: 'deduct' });
  assert.match(decodeURIComponent(r.location), /Created and deducted £60\.00 from Nora Now's rent for August 2026/);
  const li = db.prepare("SELECT * FROM landlord_invoices WHERE invoice_number = 'LI-0001' AND landlord_id = ?").get(nora);
  assert.equal(li.paid_how, 'Deducted from rent');
  assert.equal(db.prepare('SELECT txn_type FROM transactions WHERE id = ?').get(li.txn_id).txn_type, 'fee');

  // Both come off Nora's August statement.
  await c.get('/app/monthly?month=2026-08');
  await c.post('/app/monthly/generate', { month: '2026-08', landlord_id: String(nora) });
  const s = db.prepare("SELECT fees_pence, expenses_pence FROM monthly_statements WHERE landlord_id = ? AND month = '2026-08'").get(nora);
  assert.deepEqual({ ...s }, { fees_pence: 6000, expenses_pence: 9000 });
});

test('every section must be filled in when adding a contractor or landlord invoice', async () => {
  const c = await registerAndLogin('all-required@example.com', 'Required Lets');
  let r = await c.get('/app/invoices/new');
  for (const name of ['supplier', 'invoice_date', 'property_id', 'added_by', 'charge_landlord']) {
    assert.match(r.text, new RegExp(`name="${name}"[^>]*required|required[^>]*name="${name}"`), `${name} is required on the contractor invoice form`);
  }
  // Notes, the maintenance job and the invoice file are optional.
  for (const name of ['file', 'maintenance_job_id', 'description']) {
    assert.doesNotMatch(r.text, new RegExp(`name="${name}"[^>]*required|required[^>]*name="${name}"`), `${name} is optional`);
  }
  r = await c.post('/app/invoices', { supplier: 'Bare Minimum', amount: '10' }, { multipart: true });
  assert.equal(r.status, 422);
  assert.match(r.text, /Choose whether to charge the landlord[\s\S]*?Enter the invoice date[\s\S]*?Choose the property/);
  assert.doesNotMatch(r.text, /Choose the maintenance job|Add a note|Attach the invoice/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE supplier = 'Bare Minimum'").get().n, 0);
  const bareProp = idFrom((await c.post('/app/properties', { address_line1: '1 Bare Street', status: 'vacant' })).location);
  await c.get('/app/invoices/new');
  r = await c.post('/app/invoices', { supplier: 'Bare Minimum', amount: '10', invoice_date: '2026-09-01', property_id: String(bareProp), maintenance_job_id: '', description: '', charge_landlord: 'yes', landlord_amount: '12' }, { multipart: true });
  assert.equal(r.status, 302, 'saved with no file, no job and no notes');
  const bare = db.prepare("SELECT file_name, maintenance_job_id, description FROM invoices WHERE supplier = 'Bare Minimum'").get();
  assert.deepEqual({ ...bare }, { file_name: null, maintenance_job_id: null, description: null });
  assert.equal((await c.get(`/app/invoices/${idFrom(r.location)}`)).status, 200);

  r = await c.get('/app/landlord-invoices/new');
  for (const name of ['landlord_id', 'property_id', 'amount', 'invoice_date', 'description']) {
    assert.match(r.text, new RegExp(`name="${name}"[^>]*required|required[^>]*name="${name}"`), `${name} is required on the landlord invoice form`);
  }
  const ll = idFrom((await c.post('/app/landlords', { name: 'Req Landlord' })).location);
  r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), invoice_number: 'LI-0001', invoice_date: '2026-08-01', description: 'Fee', amount: '5' });
  assert.equal(r.status, 422);
  assert.match(r.text, /Choose the property/);
  assert.doesNotMatch(r.text, /Enter the due date|Add notes for the invoice|name="due_date"/);
  assert.doesNotMatch(r.text, /name="notes"[^>]*required/, 'notes are optional');
});

test('contractor invoice job can be None; councils take several phone numbers and emails', async () => {
  const c = await registerAndLogin('none-job@example.com', 'None Job Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '1 No Job Road', status: 'vacant' })).location);
  let r = await c.get('/app/invoices/new');
  assert.match(r.text, /<option value="none" selected>None – no job<\/option>/);
  const pdf = new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  r = await c.post('/app/invoices', { supplier: 'Key Cutters', amount: '12', invoice_date: '2026-09-02', maintenance_job_id: 'none', property_id: String(prop), description: 'Spare keys', charge_landlord: 'yes', landlord_amount: '12', file: pdf }, { multipart: true });
  assert.equal(r.status, 302, r.text);
  const inv = db.prepare('SELECT maintenance_job_id, property_id FROM invoices WHERE id = ?').get(idFrom(r.location));
  assert.equal(inv.maintenance_job_id, null);
  assert.equal(inv.property_id, prop);
  // Editing an invoice with no job shows None selected.
  const keyInvoice = db.prepare("SELECT id FROM invoices WHERE supplier = 'Key Cutters'").get().id;
  assert.match((await c.get(`/app/invoices/${keyInvoice}/edit`)).text, /<option value="none" selected>None – no job/);

  // Councils: several phone numbers and emails.
  r = await c.post('/app/councils', { name: 'Multi Council', council_tax_phone: '0113 222 4404\n0113 222 4405', council_tax_email: 'tax@multi.gov.uk, benefits@multi.gov.uk' });
  const council = idFrom(r.location);
  const row = db.prepare('SELECT council_tax_phone, council_tax_email FROM councils WHERE id = ?').get(council);
  assert.equal(row.council_tax_phone, '0113 222 4404\n0113 222 4405');
  assert.equal(row.council_tax_email, 'tax@multi.gov.uk\nbenefits@multi.gov.uk');
  assert.match((await c.get(`/app/councils/${council}`)).text, /tax@multi\.gov\.uk\nbenefits@multi\.gov\.uk/);
  r = await c.post('/app/councils', { name: 'Bad Council', council_tax_email: 'good@x.gov.uk\nnot-an-email' });
  assert.equal(r.status, 422);
  assert.match(r.text, /Check &#34;not-an-email&#34;: not a valid email address/);
});

test('contractor invoices: unpaid and paid boxes for the chosen month either side of the all-months boxes', async () => {
  const c = await registerAndLogin('inv-tiles@example.com', 'Tiles Lets');
  await c.get('/app/invoices/new');
  const pdf = () => new File([Buffer.from('%PDF-1.4\n%x\n')], 'i.pdf');
  const add = async (amount, date) => idFrom((await c.post('/app/invoices', await invoiceBody(c, { supplier: 'Tile Co', amount, invoice_date: date, file: pdf() }), { multipart: true })).location);
  const paid = await add('100', '2026-08-03');
  await add('40', '2026-08-09');
  await add('7', '2026-07-01');
  await c.post(`/app/invoices/${paid}/pay`, { paid_date: '2026-08-10', payment_method: 'Card' });
  const r = await c.get('/app/invoices?month=2026-08');
  const labels = [...r.text.matchAll(/<span class="label">([^<]+)<\/span><span class="value">([^<]+)</g)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(labels, ['Unpaid · August 2026=£40.00', 'Unpaid · all months=£47.00', 'Paid · August 2026=£100.00']);
  assert.doesNotMatch((await c.get('/app/invoices?month=all')).text, /Paid · /, 'no month boxes when showing all months');
});

test('the app is called Rift everywhere people see it', async () => {
  const login = (await new Client().get('/login')).text;
  assert.match(login, /<title>Sign in · Rift<\/title>/);
  assert.match(login, /<span class="logo">R<\/span>Rift/);
  assert.doesNotMatch(login, /Nexus/);
  const c = await registerAndLogin('rift-name@example.com', 'Rift Name Lets');
  const home = (await c.get('/app')).text;
  assert.match(home, /<span class="logo">R<\/span>/);
  assert.doesNotMatch(home, /Nexus/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), /^# Rift/);
});

test('Tenants and Tenancies are one tab', async () => {
  const c = await registerAndLogin('merged-tenants@example.com', 'Merged Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Merge Council' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '5 Joined Road', council_id: String(council), status: 'vacant' })).location);
  let r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Current Carol', booking_date: '2026-07-01', start_date: '2026-08-01', rent_pence: '950', rent_frequency: 'monthly', status: 'active' });
  const tenancy = idFrom(r.location);
  r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Past Pete', booking_date: '2025-01-01', start_date: '2025-02-01', end_date: '2026-01-31', rent_pence: '900', rent_frequency: 'monthly', status: 'ended' });
  await c.post('/app/tenants', { name: 'Waiting Wendy' });

  const rail = (await c.get('/app')).text.match(/<nav class="rail"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(rail, /aria-label="Tenancies"/);
  assert.match(rail, /aria-label="Tenants"/);
  assert.equal((await c.get('/app/tenancies')).location, '/app/tenants');

  r = await c.get('/app/tenants');
  assert.match(r.text, /<th[^>]*>Property<\/th>\s*<th[^>]*>Rent<\/th>\s*<th[^>]*>Tenancy<\/th>\s*<th[^>]*>Status<\/th>\s*<th[^>]*>Phone<\/th>\s*<th[^>]*>Council<\/th>/);
  assert.match(r.text, new RegExp(`Current Carol[\\s\\S]*?5 Joined Road[\\s\\S]*?£950\\.00 pcm[\\s\\S]*?href="/app/tenancies/${tenancy}">01/08/2026 – ongoing[\\s\\S]*?badge s-active">active[\\s\\S]*?Merge Council`));
  assert.match(r.text, /Waiting Wendy[\s\S]*?No tenancy yet/);
  assert.doesNotMatch(r.text, /Past Pete/, 'current tenants by default');
  r = await c.get('/app/tenants?show=past');
  assert.match(r.text, /Past Pete[\s\S]*?31\/01\/2026/);
  assert.doesNotMatch(r.text, /Current Carol/);
  assert.match((await c.get('/app/tenants?show=all')).text, /Current Carol[\s\S]*?Past Pete|Past Pete[\s\S]*?Current Carol/);

  // A tenancy's page belongs to the Tenants tab and leads back to its tenant.
  r = await c.get(`/app/tenancies/${tenancy}`);
  const carol = db.prepare('SELECT tenant_id FROM tenancies WHERE id = ?').get(tenancy).tenant_id;
  assert.match(r.text, new RegExp(`class="crumb" href="/app/tenants/${carol}">← Current Carol`));
  assert.match(r.text, /class="rail-btn active " href="\/app\/tenants"|class="rail-btn active" href="\/app\/tenants"|aria-label="Tenants" aria-current="page"/);
});

test('maintenance jobs: upload photos and files, view, download, remove', async () => {
  const c = await registerAndLogin('job-files@example.com', 'Job Files Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '6 Photo Lane', status: 'let' })).location);
  const job = idFrom((await c.post('/app/maintenance', { property_id: String(prop), title: 'Leaking tap', priority: 'normal', status: 'open' })).location);
  let r = await c.get(`/app/maintenance/${job}`);
  assert.match(r.text, /id="files"[\s\S]*?Photos &amp; files[\s\S]*?name="files" multiple/);
  assert.match(r.text, /No photos or files yet/);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
  const form = new FormData();
  form.append('_csrf', c.csrf);
  form.append('files', new File([png], 'before.png'));
  form.append('files', new File([jpg], 'after.jpg'));
  form.append('files', new File([heic], 'IMG_0001.HEIC'));
  form.append('files', new File([Buffer.from('%PDF-1.4\n')], 'quote.pdf'));
  form.append('files', new File(['<script>'], 'evil.png'));
  const res = await fetch(`${base}/app/maintenance/${job}/files`, { method: 'POST', headers: { cookie: c.cookie }, body: form, redirect: 'manual' });
  const loc = decodeURIComponent(res.headers.get('location'));
  assert.match(loc, /Uploaded 4 files\. Not uploaded .*evil\.png/);

  r = await c.get(`/app/maintenance/${job}`);
  assert.match(r.text, /Photos &amp; files <span class="count">4<\/span>/);
  assert.match(r.text, /<img src="\/app\/maintenance\/\d+\/files\/\d+" alt="after\.jpg"/);
  assert.match(r.text, /file-type">PDF</);
  assert.match(r.text, /file-type">HEIC</);
  assert.match(r.text, /Test User/, 'shows who uploaded it');
  const files = db.prepare('SELECT id, filename FROM maintenance_files WHERE job_id = ? ORDER BY id').all(job);
  r = await c.get(`/app/maintenance/${job}/files/${files[0].id}`);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  r = await c.get(`/app/maintenance/${job}/files/${files[2].id}`);
  assert.match(r.headers.get('content-disposition'), /^attachment/, 'HEIC downloads rather than displays');

  // Private to the company; removing works.
  const other = await registerAndLogin('job-files-2@example.com', 'Other Files');
  assert.equal((await other.get(`/app/maintenance/${job}/files/${files[0].id}`)).status, 404);
  assert.equal((await other.post(`/app/maintenance/${job}/files/${files[0].id}/delete`, {})).status, 404);
  await c.get(`/app/maintenance/${job}`);
  await c.post(`/app/maintenance/${job}/files/${files[0].id}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM maintenance_files WHERE job_id = ?').get(job).n, 3);
  // Deleting the job removes its files.
  await c.post(`/app/maintenance/${job}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM maintenance_files WHERE job_id = ?').get(job).n, 0);
});

test('landlords list shows their councils to the right of phone', async () => {
  const c = await registerAndLogin('ll-councils@example.com', 'LL Councils Lets');
  const leeds = idFrom((await c.post('/app/councils', { name: 'Leeds City Council' })).location);
  const york = idFrom((await c.post('/app/councils', { name: 'York Council' })).location);
  const ll = idFrom((await c.post('/app/landlords', { name: 'Two Council Tom', phone: '07700 900001' })).location);
  await c.post('/app/properties', { address_line1: 'A1', landlord_id: String(ll), council_id: String(leeds), status: 'let' });
  await c.post('/app/properties', { address_line1: 'A2', landlord_id: String(ll), council_id: String(york), status: 'let' });
  await c.post('/app/properties', { address_line1: 'A3', landlord_id: String(ll), council_id: String(leeds), status: 'let' });
  const r = await c.get('/app/landlords');
  assert.match(r.text, /<th[^>]*>Phone<\/th>\s*<th[^>]*>Councils<\/th>/);
  assert.match(r.text, /07700 900001[\s\S]*?<span class="cell-text">Leeds City Council\nYork Council<\/span>/);
});

test('a landlord page has no Transactions list', async () => {
  const c = await registerAndLogin('ll-no-txn@example.com', 'No Txn LL Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Quiet Landlord' })).location);
  const r = await c.get(`/app/landlords/${ll}`);
  assert.match(r.text, /Properties owned/);
  assert.doesNotMatch(r.text, /<h2>Transactions/);
});

test('saving account details keeps your own username (including the admin account)', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const me = db.prepare('SELECT * FROM users WHERE is_admin = 1').get();
  await admin.get(`/admin/users/${me.id}`);
  let r = await admin.post(`/admin/users/${me.id}/details`, { username: me.username, login_name: me.login_name, name: me.name, agency_name: me.agency_name || 'Owner', email: me.email || '', phone: '0113 000 0000', address: '' });
  assert.doesNotMatch(decodeURIComponent(r.location), /taken/, 'the admin can save their own details');
  assert.match(decodeURIComponent(r.location), /Account details saved/);
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(me.id).phone, '0113 000 0000');
  // The admin's username can't be changed here (it comes from the ADMIN_USERNAME setting).
  r = await admin.post(`/admin/users/${me.id}/details`, { username: 'SomethingElse', login_name: me.login_name, name: me.name, agency_name: me.agency_name || 'Owner' });
  assert.match(decodeURIComponent(r.location), /admin username is set in the server settings/);
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(me.id).username, me.username);

  // A company saving with its own username (any capitals) is fine too; someone else's is still refused.
  await registerAndLogin('keep-name@example.com', 'Keep Name Lets');
  const co = db.prepare("SELECT * FROM users WHERE username = 'keep-name'").get();
  await admin.get(`/admin/users/${co.id}`);
  r = await admin.post(`/admin/users/${co.id}/details`, { username: 'keep-name', login_name: co.login_name, name: co.name, agency_name: co.agency_name, email: co.email });
  assert.match(decodeURIComponent(r.location), /Account details saved/);
  r = await admin.post(`/admin/users/${co.id}/details`, { username: 'Keep-Name', login_name: co.login_name, name: co.name, agency_name: co.agency_name, email: co.email });
  assert.match(decodeURIComponent(r.location), /Account details saved/, 'changing only the capitals is allowed');
  await registerAndLogin('other-name@example.com', 'Other Name Lets');
  r = await admin.post(`/admin/users/${co.id}/details`, { username: 'other-name', login_name: co.login_name, name: co.name, agency_name: co.agency_name, email: co.email });
  assert.match(decodeURIComponent(r.location), /That username is taken/);
});

test('the admin sign-in name is shown read-only and cannot be changed from the form', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const me = db.prepare('SELECT * FROM users WHERE is_admin = 1').get();
  const r0 = await admin.get(`/admin/users/${me.id}`);
  assert.match(r0.text, /name="login_name"[^>]*readonly/);
  const r = await admin.post(`/admin/users/${me.id}/details`, { login_name: 'Someone', name: me.name, agency_name: me.agency_name || 'Owner' });
  assert.match(decodeURIComponent(r.location), /ADMIN_LOGIN_NAME/);
  assert.equal(db.prepare('SELECT login_name FROM users WHERE id = ?').get(me.id).login_name, me.login_name);
});

test('the admin account picks up the Rift name instead of the old Nexus one', () => {
  const dbx = openDatabase(':memory:');
  const cfg = { ...config, adminUsername: 'TPAS2', adminLoginName: 'Theo', adminPassword: 'owner-password-123', appName: 'Nexus' };
  ensureAdmin(dbx, cfg, () => {});
  assert.equal(dbx.prepare('SELECT agency_name FROM users WHERE is_admin = 1').get().agency_name, 'Nexus');
  ensureAdmin(dbx, { ...cfg, appName: 'Rift' }, () => {});
  assert.equal(dbx.prepare('SELECT agency_name FROM users WHERE is_admin = 1').get().agency_name, 'Rift');
  // A name the admin chose themselves is left alone.
  dbx.prepare("UPDATE users SET agency_name = 'Theo Lettings' WHERE is_admin = 1").run();
  ensureAdmin(dbx, { ...cfg, appName: 'Rift' }, () => {});
  assert.equal(dbx.prepare('SELECT agency_name FROM users WHERE is_admin = 1').get().agency_name, 'Theo Lettings');
});

test('account details on the admin panel: Agency, Your name, Password, Email, Phone; saving without a username keeps it', async () => {
  await registerAndLogin('no-username-box@example.com', 'No Box Lets');
  const co = db.prepare("SELECT * FROM users WHERE username = 'no-username-box'").get();
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const r = await admin.get(`/admin/users/${co.id}`);
  const details = r.text.slice(r.text.indexOf('id="details"'), r.text.indexOf('id="people"'));
  const order = ['Agency', 'Your name', 'Password', 'Email', 'Phone'].map((l) => details.indexOf(`>${l}`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `labels out of order: ${order}`);
  assert.doesNotMatch(r.text, /id="reset-password"/);
  assert.match(details, new RegExp(`formaction="/admin/users/${co.id}/password"[^>]*>Change password`));
  let pw = await admin.post(`/admin/users/${co.id}/password`, { password: '' });
  assert.match(decodeURIComponent(pw.location), /Type a new password first/);
  pw = await admin.post(`/admin/users/${co.id}/password`, { password: 'changed-by-button-1', name: 'ignored' });
  assert.match(decodeURIComponent(pw.location), /Password changed/);
  assert.ok(require('../src/auth').verifyPassword('changed-by-button-1', db.prepare('SELECT password_hash FROM users WHERE id = ?').get(co.id).password_hash));
  const saved = await admin.post(`/admin/users/${co.id}/details`, { login_name: co.login_name, name: 'New Contact', agency_name: co.agency_name, email: co.email });
  assert.match(decodeURIComponent(saved.location), /Account details saved/);
  assert.deepEqual({ ...db.prepare('SELECT username, name FROM users WHERE id = ?').get(co.id) }, { username: 'no-username-box', name: 'New Contact' });
});

test('admin can change how often automatic backups run', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  let r = await admin.get('/admin/backups');
  assert.match(r.text, /Backup frequency/);
  r = await admin.post('/admin/backups/frequency', { hours: '6' });
  assert.match(decodeURIComponent(r.location), /every 6 hours/);
  assert.equal(require('../src/backup').intervalHours(db, { backupIntervalHours: 24 }), 6);
  assert.match((await admin.get('/admin/backups')).text, /name="hours"[^>]*value="6"/);
  r = await admin.post('/admin/backups/frequency', { hours: '36' });
  assert.match(decodeURIComponent(r.location), /every 36 hours/);
  assert.equal(require('../src/backup').intervalHours(db, { backupIntervalHours: 24 }), 36);
  for (const bad of ['1.5', '-2', '721', 'abc', '']) {
    r = await admin.post('/admin/backups/frequency', { hours: bad });
    assert.match(decodeURIComponent(r.location), /Enter a whole number of hours/, bad);
  }
  assert.equal(require('../src/backup').intervalHours(db, { backupIntervalHours: 24 }), 36);
  r = await admin.post('/admin/backups/frequency', { hours: '0' });
  assert.match(decodeURIComponent(r.location), /Automatic backups are off/);
  assert.equal(require('../src/backup').intervalHours(db, { backupIntervalHours: 24 }), 0);
});

test('signing in plays the welcome animation once, on the first page', async () => {
  const c = new Client();
  let r = await c.get('/login');
  assert.match(r.text, /Welcome back/);
  r = await c.post('/login', { login: 'admin', member: 'Theo', password: 'owner-password-123' });
  r = await c.get(r.location);
  assert.match(r.text, /data-intro/);
  assert.doesNotMatch(r.text.slice(r.text.indexOf('data-intro'), r.text.indexOf('</div>', r.text.indexOf('intro-center'))), /Welcome/);
  r = await c.get('/admin');
  assert.doesNotMatch(r.text, /data-intro/);
});

test('several accounts can share one email address', async () => {
  await registerAndLogin('shared@example.com', 'First Shared Lets');
  const c = new Client();
  const r = await c.post('/register', { username: 'shared-two', name: 'Test User', agency_name: 'Second Shared Lets', email: 'shared@example.com', password: 'kettle-harbour-58', password_confirm: 'kettle-harbour-58' });
  assert.equal(r.status, 302, r.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'shared@example.com'").get().n, 2);

  // The admin can give another account the same email too.
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const other = await registerAndLogin('someone-else@example.com', 'Third Shared Lets');
  const third = db.prepare("SELECT * FROM users WHERE username = 'someone-else'").get();
  const saved = await admin.post(`/admin/users/${third.id}/details`, { login_name: third.login_name, name: third.name, agency_name: third.agency_name, email: 'SHARED@example.com' });
  assert.match(decodeURIComponent(saved.location), /Account details saved/);
  assert.ok(other);
});

test('older databases with one-email-per-account are converted, keeping every row', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rift-email-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL, agency_name TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT, login_count INTEGER NOT NULL DEFAULT 0)`);
  old.prepare("INSERT INTO users (username, email, name, agency_name, password_hash) VALUES ('oldco', 'a@b.com', 'Old', 'Old Co', 'x')").run();
  old.close();
  const migrated = openDatabase(file);
  assert.equal(migrated.prepare("SELECT username FROM users WHERE email = 'a@b.com'").get().username, 'oldco');
  migrated.prepare("INSERT INTO users (username, email, name, agency_name, password_hash) VALUES ('newco', 'A@b.com', 'New', 'New Co', 'x')").run();
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'a@b.com'").get().n, 2);
  assert.throws(() => migrated.prepare("INSERT INTO users (username, name, agency_name, password_hash) VALUES ('OLDCO', 'Dup', 'Dup', 'x')").run(), /UNIQUE/);
  migrated.close();
});

test('Account details page: People section under All logins adds someone to a chosen agency', async () => {
  await registerAndLogin('people-here@example.com', 'People Here Lets');
  const co = db.prepare("SELECT * FROM users WHERE username = 'people-here'").get();
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  let r = await admin.get('/admin/accounts');
  assert.ok(r.text.indexOf('All logins') < r.text.indexOf('id="people"'));
  assert.match(r.text, new RegExp(`<option value="${co.id}"`));
  r = await admin.post('/admin/accounts/people', { company_id: '', name: 'Nobody', login_name: 'nobody', password: 'long-enough-1' });
  assert.match(decodeURIComponent(r.location), /Choose which agency/);
  r = await admin.post('/admin/accounts/people', { company_id: String(co.id), name: 'Jo Bloggs', login_name: 'jo', password: 'long-enough-1' });
  assert.match(r.location, /^\/admin\/accounts\?flash=/);
  assert.match(decodeURIComponent(r.location), /Added Jo Bloggs to People Here Lets/);
  const jo = db.prepare("SELECT * FROM users WHERE company_id = ? AND login_name = 'jo'").get(co.id);
  assert.ok(jo);
  assert.match((await admin.get('/admin/accounts')).text, /Jo Bloggs/);
  const staff = new Client();
  const s = await staff.post('/login', { login: 'people-here', member: 'jo', password: 'long-enough-1' });
  assert.match(s.location, /^\/app/);
});

test('maintenance is shown one month at a time, like the invoice tabs', async () => {
  const c = await registerAndLogin('maint-months@example.com', 'Maint Months Lets');
  let r = await c.post('/app/properties', { address_line1: '9 Month Row', status: 'let' });
  const pid = idFrom(r.location);
  await c.post('/app/maintenance', { property_id: String(pid), title: 'Boiler August', priority: 'normal', status: 'open', reported_date: '2026-08-12', cost_pence: '120' });
  await c.post('/app/maintenance', { property_id: String(pid), title: 'Tap September', priority: 'normal', status: 'completed', reported_date: '2026-09-03', cost_pence: '40' });
  r = await c.get('/app/maintenance?month=2026-09');
  assert.match(r.text, /Tap September/);
  assert.doesNotMatch(r.text, /Boiler August/);
  assert.match(r.text, /‹ Previous month/);
  assert.match(r.text, /Open from earlier months<\/span><span class="value">1</);
  assert.match(r.text, /Cost · September 2026<\/span><span class="value">£40\.00/);
  r = await c.get('/app/maintenance?month=2026-08');
  assert.match(r.text, /Boiler August/);
  assert.doesNotMatch(r.text, /Tap September/);
  r = await c.get('/app/maintenance?month=all');
  assert.match(r.text, /Boiler August[\s\S]*|Tap September/);
  assert.ok(r.text.includes('Boiler August') && r.text.includes('Tap September'));
  assert.match((await c.get('/app')).text, /href="\/app\/maintenance\?month=all"/);
});

test('properties list columns: Property name, Council, Landlord, Tenant, Status', async () => {
  const c = await registerAndLogin('prop-cols@example.com', 'Prop Cols Lets');
  let r = await c.post('/app/councils', { name: 'Col Council' });
  const council = idFrom(r.location);
  r = await c.post('/app/landlords', { name: 'Col Landlord' });
  const landlord = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '3 Column Close', council_id: String(council), landlord_id: String(landlord), status: 'vacant' });
  const prop = idFrom(r.location);
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Cora Tenant', booking_date: '2026-07-10', start_date: '2026-08-01', rent_pence: '850', rent_frequency: 'monthly', status: 'active' });
  r = await c.get('/app/properties');
  const heads = [...r.text.slice(r.text.indexOf('<thead'), r.text.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(heads.slice(0, 5), ['Property name', 'Council', 'Landlord', 'Tenant', 'Status']);
  assert.match(r.text, /3 Column Close[\s\S]*Col Council[\s\S]*Col Landlord[\s\S]*Cora Tenant/);
});

test('rent run: Edit sender changes who statement emails come from', async () => {
  const sentMail = [];
  const c = await registerAndLogin('sender-edit@example.com', 'Sender Edit Lets');
  const co = db.prepare("SELECT id FROM users WHERE username = 'sender-edit'").get();
  let r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /Email all landlords<\/button>\s*<\/form>\s*<button class="btn" type="button" data-toggle="#sender-settings"[^>]*>Edit sender/);
  r = await c.post('/app/monthly/email/settings', { month: '2026-08', from_email: 'not-an-email', from_name: '', reply_to: '' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /isn’t a valid email/);
  r = await c.post('/app/monthly/email/settings', { month: '2026-08', from_email: 'statements@agency.example', from_name: 'Sender Edit Team', reply_to: 'office@gmail.com' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Saved who statement emails come from/);
  const row = db.prepare('SELECT statement_from_email, statement_from_name, statement_reply_to FROM users WHERE id = ?').get(co.id);
  assert.deepEqual({ ...row }, { statement_from_email: 'statements@agency.example', statement_from_name: 'Sender Edit Team', statement_reply_to: 'office@gmail.com' });
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /From: <strong>Sender Edit Team<\/strong> &lt;statements@agency\.example&gt; · replies to office@gmail\.com/);
  assert.ok(sentMail);
});

test('mailer uses the chosen From address when one is given', async () => {
  const { createMailer } = require('../src/mailer');
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; };
  try {
    const m = createMailer({ resendApiKey: 'test-key', emailFrom: 'default@verified.example' });
    await m.send({ to: 'a@b.com', subject: 'S', text: 't', fromName: 'Agency', from: 'statements@verified.example', replyTo: 'office@gmail.com' });
    await m.send({ to: 'a@b.com', subject: 'S', text: 't', fromName: 'Agency' });
    assert.equal(calls[0].from, '"Agency" <statements@verified.example>');
    assert.equal(calls[0].reply_to, 'office@gmail.com');
    assert.equal(calls[1].from, '"Agency" <default@verified.example>');
    assert.equal(m.defaultFrom, 'default@verified.example');
  } finally { global.fetch = realFetch; }
});

test('council reconciliation: Date received and Email sent date columns save, no "Changes save automatically" text', async () => {
  const c = await registerAndLogin('rec-dates@example.com', 'Rec Dates Lets');
  let r = await c.post('/app/councils', { name: 'Dates Council' });
  const council = idFrom(r.location);
  r = await c.get('/app/council-reconciliation?month=2026-09');
  assert.match(r.text, /Money in<\/th><th>Date received<\/th><th>Email sent<\/th>/);
  assert.match(r.text, /name="received_date"[\s\S]*?name="email_sent_date"/);
  assert.match(r.text, /data-autosave data-autosave-quiet/);
  r = await c.req('POST', '/app/council-reconciliation/notes', { council_id: String(council), month: '2026-09', notes: '', owed: '', received: '', received_date: '2026-09-17', email_sent_date: '2026-09-18' });
  const row = db.prepare('SELECT received_date, email_sent_date FROM council_rec_notes WHERE council_id = ?').get(council);
  assert.deepEqual({ ...row }, { received_date: '2026-09-17', email_sent_date: '2026-09-18' });
  r = await c.get('/app/council-reconciliation?month=2026-09');
  assert.match(r.text, /name="received_date" value="2026-09-17"/);
  assert.match(r.text, /name="email_sent_date" value="2026-09-18"/);
  // Cleared again: the row goes when nothing is left.
  await c.req('POST', '/app/council-reconciliation/notes', { council_id: String(council), month: '2026-09', notes: '', owed: '', received: '', received_date: '', email_sent_date: '' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM council_rec_notes WHERE council_id = ?').get(council).n, 0);
});

test('council reconciliation: still owed for the month and all months in the top right', async () => {
  const c = await registerAndLogin('rec-owed@example.com', 'Rec Owed Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Owed Council' })).location);
  const save = (month, fields) => fetch(`${base}/app/council-reconciliation/notes`, {
    method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, council_id: String(council), month, notes: '', ...fields }).toString(),
  });
  await save('2026-07', { owed: '500', received: '200' });
  const res = await save('2026-08', { owed: '100', received: '0' });
  const json = await res.json();
  const upd = Object.fromEntries(json.updates.map((u) => [u.id, u.text]));
  assert.equal(upd['rec-owed-month'], '£100.00');
  assert.equal(upd['rec-owed-all'], '£400.00', 'July’s £300 plus August’s £100');
  const page = (await c.get('/app/council-reconciliation?month=2026-08')).text;
  assert.match(page, /Still owed · August 2026<\/span><span class="value bad-text" id="rec-owed-month">£100\.00/);
  assert.match(page, /Still owed · all months<\/span><span class="value bad-text" id="rec-owed-all">£400\.00/);
  // An overpayment later offsets what's owed overall.
  await save('2026-09', { owed: '0', received: '450' });
  assert.match((await c.get('/app/council-reconciliation?month=2026-09')).text, /id="rec-owed-all">£50\.00 over/);
});

test('contractor invoices: choose the landlord to charge and say what is required', async () => {
  const c = await registerAndLogin('inv-landlord@example.com', 'Inv Landlord Lets');
  const owner = idFrom((await c.post('/app/landlords', { name: 'Owner Olive' })).location);
  const other = idFrom((await c.post('/app/landlords', { name: 'Other Oscar' })).location);
  const pid = String(idFrom((await c.post('/app/properties', { address_line1: '3 Chosen Road', status: 'vacant', landlord_id: String(owner) })).location));
  let form = await c.get('/app/invoices/new');
  assert.match(form.text, /name="landlord_id"[\s\S]*?Other Oscar/);
  assert.match(form.text, /What(’|'|&#39;)s required/);
  assert.match(form.text, /data-landlord="\d+"[^>]*>3 Chosen Road/);

  // Left blank: the property's landlord. Deducted from them.
  let r = await c.post('/app/invoices', { supplier: 'Tap Co', amount: '50', landlord_amount: '60', charge_landlord: 'yes', invoice_date: '2026-09-02', property_id: pid, maintenance_job_id: 'none', work_required: 'Fix the kitchen tap', then: 'deduct' }, { multipart: true });
  assert.equal(r.status, 302, r.text);
  let inv = db.prepare("SELECT * FROM invoices WHERE supplier = 'Tap Co'").get();
  assert.equal(inv.landlord_id, owner);
  assert.equal(inv.work_required, 'Fix the kitchen tap');
  assert.equal(db.prepare('SELECT landlord_id FROM transactions WHERE id = ?').get(inv.payment_txn_id).landlord_id, owner);
  assert.match((await c.get(`/app/invoices/${inv.id}`)).text, /What(’|'|&#39;)s required<\/dt><dd class="pre">Fix the kitchen tap/);

  // Chosen by hand: charged to that landlord instead.
  r = await c.post('/app/invoices', { supplier: 'Roof Co', amount: '100', landlord_amount: '120', charge_landlord: 'yes', invoice_date: '2026-09-03', property_id: pid, maintenance_job_id: 'none', landlord_id: String(other), then: 'deduct' }, { multipart: true });
  inv = db.prepare("SELECT * FROM invoices WHERE supplier = 'Roof Co'").get();
  assert.equal(inv.landlord_id, other);
  assert.equal(db.prepare('SELECT landlord_id FROM transactions WHERE id = ?').get(inv.payment_txn_id).landlord_id, other);
  assert.match((await c.get(`/app/invoices/${inv.id}`)).text, /Other Oscar/);

  // Another company's landlord is refused.
  const stranger = await registerAndLogin('inv-landlord2@example.com', 'Stranger Lets');
  const spid = String(idFrom((await stranger.post('/app/properties', { address_line1: '9 Elsewhere', status: 'vacant' })).location));
  r = await stranger.post('/app/invoices', { supplier: 'Sneaky', amount: '10', landlord_amount: '10', charge_landlord: 'yes', invoice_date: '2026-09-03', property_id: spid, maintenance_job_id: 'none', landlord_id: String(owner) }, { multipart: true });
  assert.equal(r.status, 422);
  form = r.text;
  assert.match(form, /Choose a valid landlord/);
});

test('council database: typing a cancellation date on Live ends the entry', async () => {
  const c = await registerAndLogin('cdb-cancel@example.com', 'Cancel Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Cancel Council' })).location);
  await c.get(`/app/councils/${council}/database`);
  await c.post(`/app/councils/${council}/database/entries`, { our_ref: 'CX1', client_name: 'Cara', booking_date: '2026-05-01' });
  const e = db.prepare("SELECT id FROM council_db_entries WHERE our_ref = 'CX1'").get();
  const save = (fields) => fetch(`${base}/app/councils/${council}/database/entries/${e.id}`, {
    method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, our_ref: 'CX1', client_name: 'Cara', booking_date: '2026-05-01', ...fields }).toString(),
  });
  let res = await save({ cancellation_date: '2026-04-01' });
  assert.equal(res.status, 422, 'not before the booking date');
  res = await save({ cancellation_date: '2026-09-20' });
  const json = await res.json();
  assert.match(json.reload, new RegExp(`^/app/councils/${council}/database\\?flash=.*#previous$`));
  assert.deepEqual({ ...db.prepare('SELECT ended, cancellation_date FROM council_db_entries WHERE id = ?').get(e.id) }, { ended: 1, cancellation_date: '2026-09-20' });
  // Added with a cancellation date: straight to Previous tenant.
  const r = await c.post(`/app/councils/${council}/database/entries`, { our_ref: 'CX2', cancellation_date: '2026-09-01' });
  assert.match(decodeURIComponent(r.location), /added to Previous tenant/);
  assert.equal(db.prepare("SELECT ended FROM council_db_entries WHERE our_ref = 'CX2'").get().ended, 1);
});

test('maintenance: a completed job has a landlord invoice to download and email', async () => {
  const c = await registerAndLogin('job-invoice@example.com', 'Job Invoice Lets');
  const co = db.prepare("SELECT id FROM users WHERE username = 'job-invoice'").get();
  db.prepare("UPDATE users SET address = 'Unit 9 Netherhouse Farm', phone = '020 8882 5500', email = 'info@jobinvoice.example' WHERE id = ?").run(co.id);
  let r = await c.post('/app/landlords', { name: 'Mrs Karen Wright', email: 'karen@example.com' });
  const ll = idFrom(r.location);
  r = await c.post('/app/properties', { address_line1: '2 Review Lodge', town: 'Review Road', postcode: 'RM10 9DB', landlord_id: String(ll), status: 'let' });
  const prop = idFrom(r.location);
  r = await c.post('/app/maintenance', { property_id: String(prop), title: 'Gas certificate', priority: 'normal', status: 'open', reported_date: '2026-09-01', cost_pence: '120' });
  const job = idFrom(r.location);

  r = await c.get(`/app/maintenance/${job}`);
  assert.match(r.text, /Landlord invoice[\s\S]*?once this job is marked <strong>completed/);
  r = await c.get(`/app/maintenance/${job}/invoice.pdf`);
  assert.match(decodeURIComponent(r.location || ''), /once the job is marked completed/);

  db.prepare("UPDATE maintenance_jobs SET status = 'completed' WHERE id = ?").run(job);
  r = await c.get(`/app/maintenance/${job}`);
  assert.match(r.text, /Download invoice \(PDF\)[\s\S]*?name="to" value="karen@example\.com"[\s\S]*?Email invoice/);
  r = await c.get(`/app/maintenance/${job}/invoice.pdf?download=1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="2_Review_Lodge_RM10_9DB_-_\w+_\d{4}\.pdf"/);
  assert.ok(r.buf.subarray(0, 5).toString() === '%PDF-');
  assert.ok(db.prepare('SELECT invoice_date FROM maintenance_jobs WHERE id = ?').get(job).invoice_date, 'dated when first made');

  // The invoice date can be changed; the PDF uses it.
  await c.get(`/app/maintenance/${job}`);
  r = await c.post(`/app/maintenance/${job}/invoice/date`, { invoice_date: '2026-09-10' });
  assert.match(decodeURIComponent(r.location), /Invoice dated 10\/09\/2026/);
  const { jobInvoiceData, longDate } = require('../src/jobInvoice');
  const data = jobInvoiceData(db, co.id, job);
  assert.deepEqual(data.pdf.property, ['2 Review Lodge', 'Review Road', 'RM10 9DB']);
  assert.equal(data.pdf.client, 'Mrs Karen Wright');
  assert.deepEqual(data.pdf.items, ['Gas certificate']);
  assert.equal(data.pdf.totalPence, 12000);
  assert.equal(data.filename, '2_Review_Lodge_RM10_9DB_-_September_2026.pdf');
  assert.deepEqual(longDate('2026-09-10'), { day: '10', suffix: 'th', rest: 'September 2026' });
  assert.equal(longDate('2026-09-22').suffix, 'nd');

  // Email it to the landlord, with the PDF attached.
  await c.get(`/app/maintenance/${job}`);
  sentMail.length = 0;
  r = await c.post(`/app/maintenance/${job}/invoice/email`, { to: 'karen@example.com' });
  assert.match(decodeURIComponent(r.location), /Emailed the invoice to karen@example\.com/);
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'karen@example.com');
  assert.equal(sentMail[0].attachments[0].filename, '2_Review_Lodge_RM10_9DB_-_September_2026.pdf');
  assert.equal(sentMail[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.match(sentMail[0].text, /£120\.00/);
  r = await c.get(`/app/maintenance/${job}`);
  assert.match(r.text, /Emailed to karen@example\.com on[\s\S]*?Email again/);

  // Another company can't get it.
  const other = await registerAndLogin('job-invoice-2@example.com', 'Other Invoice Lets');
  assert.equal((await other.get(`/app/maintenance/${job}/invoice.pdf`)).status, 404);
});

test('contractor invoice: price to us, price to landlord, profit, and charge to landlord Yes/No', async () => {
  const c = await registerAndLogin('profit@example.com', 'Profit Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Pat Profit' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '5 Margin Row', landlord_id: String(ll), status: 'let' })).location);
  let r = await c.get('/app/invoices/new');
  assert.match(r.text, /Charge to landlord <span class="req">\*<\/span>[\s\S]*?<option value="" selected>Choose…[\s\S]*?Price to us \(£\)[\s\S]*?Price to landlord \(£\)[\s\S]*?Profit \(£\)/);

  // Deducted at the price to the landlord; the profit shows on the invoice.
  r = await c.post('/app/invoices', { supplier: 'Gas Safe Co', amount: '120', landlord_amount: '150', charge_landlord: 'yes', invoice_date: '2026-09-10', property_id: String(prop), then: 'deduct' }, { multipart: true });
  assert.equal(r.status, 302, r.text);
  const id = idFrom(r.location.split('?')[0]);
  const inv = db.prepare('SELECT amount_pence, landlord_price_pence, charge_landlord, status, payment_txn_id FROM invoices WHERE id = ?').get(id);
  assert.deepEqual({ amount: inv.amount_pence, landlord: inv.landlord_price_pence, charge: inv.charge_landlord, status: inv.status }, { amount: 12000, landlord: 15000, charge: 1, status: 'paid' });
  assert.equal(db.prepare('SELECT amount_pence FROM transactions WHERE id = ?').get(inv.payment_txn_id).amount_pence, 15000, 'landlord charged the price to landlord');
  r = await c.get(`/app/invoices/${id}`);
  assert.match(r.text, /Price to us<\/dt><dd><strong>£120\.00[\s\S]*?Price to landlord<\/dt><dd><strong>£150\.00[\s\S]*?Profit<\/dt><dd><strong class="ok-text">£30\.00/);

  // Both prices are optional: blank price to us is £0.00, blank price to landlord is the price to us.
  await c.get('/app/invoices/new');
  r = await c.post('/app/invoices', { supplier: 'No Prices', amount: '', landlord_amount: '', charge_landlord: 'yes', invoice_date: '2026-09-11', property_id: String(prop) }, { multipart: true });
  assert.equal(r.status, 302, r.text);
  assert.deepEqual({ ...db.prepare("SELECT amount_pence, landlord_price_pence FROM invoices WHERE supplier = 'No Prices'").get() }, { amount_pence: 0, landlord_price_pence: null });
  assert.doesNotMatch((await c.get('/app/invoices/new')).text, /name="amount"[^>]*required|name="landlord_amount"[^>]*required/);
  // The list has an Edit button to the left of Pay.
  const noPrices = db.prepare("SELECT id FROM invoices WHERE supplier = 'No Prices'").get().id;
  assert.match((await c.get('/app/invoices?month=all')).text, new RegExp(`href="/app/invoices/${noPrices}/edit">Edit</a>\\s*<a class="btn small primary" href="/app/invoices/${noPrices}#pay">Pay</a>`));
  r = await c.post('/app/invoices', { supplier: 'Locksmith', amount: '80', landlord_amount: '80', charge_landlord: 'yes', invoice_date: '2026-09-11', property_id: String(prop) }, { multipart: true });
  const lock = idFrom(r.location);
  assert.match((await c.get(`/app/invoices/${lock}`)).text, /Profit<\/dt><dd><strong class="">£0\.00/);
  // Charge to landlord must be chosen.
  await c.get('/app/invoices/new');
  r = await c.post('/app/invoices', { supplier: 'Unsure', amount: '10', landlord_amount: '10', invoice_date: '2026-09-11', property_id: String(prop) }, { multipart: true });
  assert.match(r.text, /Choose whether to charge the landlord/);

  // Charge to landlord: No — saved, shown, and the pay box starts unticked.
  await c.get('/app/invoices/new');
  r = await c.post('/app/invoices', { supplier: 'Office Repairs', amount: '60', charge_landlord: 'no', invoice_date: '2026-09-12', property_id: String(prop) }, { multipart: true });
  const noCharge = idFrom(r.location);
  assert.equal(db.prepare('SELECT charge_landlord FROM invoices WHERE id = ?').get(noCharge).charge_landlord, 0);
  r = await c.get(`/app/invoices/${noCharge}`);
  assert.match(r.text, /Charge to landlord<\/dt><dd><span class="badge plain ">No/);
  assert.match(r.text, /<input type="checkbox" name="charge_landlord" value="1" >/);
  assert.match((await c.get(`/app/invoices/${noCharge}/edit`)).text, /<option value="no" selected>No/);

  // A bad price to landlord is refused.
  await c.get('/app/invoices/new');
  r = await c.post('/app/invoices', { supplier: 'Bad Price', amount: '10', landlord_amount: 'abc', invoice_date: '2026-09-12', property_id: String(prop) }, { multipart: true });
  assert.equal(r.status, 422);
  assert.match(r.text, /Enter the price to the landlord/);
});

test('dashboard has no Raise rent box and no Tenancies ending list', async () => {
  const c = await registerAndLogin('dash-trim@example.com', 'Dash Trim Lets');
  const r = await c.get('/app');
  assert.doesNotMatch(r.text, /Raise rent|rent\/raise/);
  assert.doesNotMatch(r.text, /Tenancies ending/);
  assert.match(r.text, /Notifications/);
  assert.doesNotMatch(r.text, /<h2>Open maintenance<\/h2>/);
  assert.match(r.text, /class="label">Open maintenance</, 'the Open maintenance box at the top stays');
  assert.doesNotMatch(r.text, /Coming up in 1–2 months/);
});

test('dashboard: Total invoiced to councils, Total paid to landlords and Gross profit after Open maintenance', async () => {
  const c = await registerAndLogin('dash-order@example.com', 'Dash Order Lets');
  const r = await c.get('/app');
  assert.match(r.text, /class="label">Open maintenance<[\s\S]*?class="label">Total invoiced to councils<[\s\S]*?class="label">Total paid to landlords<[\s\S]*?class="label">Gross profit</);
  assert.doesNotMatch(r.text, /Rent received this month/);
});

test('councils: a Database button per council, with the Live and Previous tenant headings to download as Excel', async () => {
  const c = await registerAndLogin('council-db@example.com', 'Council DB Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Enfield' })).location);
  let r = await c.get('/app/councils');
  assert.match(r.text, new RegExp(`href="/app/councils/${council}/database" class="btn small">Database`));
  assert.match((await c.get(`/app/councils/${council}`)).text, new RegExp(`href="/app/councils/${council}/database">Database`));
  r = await c.get(`/app/councils/${council}/database`);
  assert.match(r.text, /Enfield database[\s\S]*?ENFIELD - COUNCIL DB LETS[\s\S]*?OUR REF[\s\S]*?PROPERTY ADDRESS[\s\S]*?PRICE PER NIGHT[\s\S]*?EMAIL[\s\S]*?PREVIOUS TENANTS/);
  r = await c.get(`/app/councils/${council}/database.xlsx`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Enfield_Database\.xlsx/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Live', 'Previous tenant']);
  const live = wb.getWorksheet('Live');
  assert.equal(live.getCell('A1').value, 'ENFIELD - COUNCIL DB LETS');
  assert.deepEqual(Array.from({ length: 13 }, (_, i) => live.getRow(3).getCell(i + 1).value), ['OUR REF', 'PROPERTY ADDRESS', 'SCHEME', 'PROPERTY SIZE', 'PROPERTY REFERENCE', 'DATE OF RESERVATION', 'DATE OF BOOKING', 'CANCELLATION DATE', 'PRICE PER NIGHT', "CLIENT'S NAME", 'CONTACT NUMBER', 'NO. OF PEOPLE', 'EMAIL']);
  assert.equal(live.getCell('B5').value, null, 'no data yet');
  const prev = wb.getWorksheet('Previous tenant');
  assert.equal(prev.getCell('A1').value, 'PREVIOUS TENANTS');
  assert.equal(prev.getCell('M2').value, 'EMAIL');
  // Another company can't open it.
  const other = await registerAndLogin('council-db-2@example.com', 'Other DB Lets');
  assert.equal((await other.get(`/app/councils/${council}/database.xlsx`)).status, 404);
});

test('tenancies: booking and start dates cannot be after the end date', async () => {
  const c = await registerAndLogin('tenancy-dates@example.com', 'Tenancy Dates Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '8 Date Row', status: 'vacant' })).location);
  let r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Early Ender', booking_date: '2026-09-01', start_date: '2026-10-01', end_date: '2026-08-31', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  assert.equal(r.status, 422);
  assert.match(r.text, /The booking date can’t be after the end date/);
  assert.match(r.text, /The start date can’t be after the end date/);
  r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Fine Tenant', booking_date: '2026-09-01', start_date: '2026-10-01', end_date: '2027-09-30', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  assert.equal(r.status, 302);
  const tenancy = db.prepare("SELECT ty.id, ty.tenant_id FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id WHERE t.name = 'Fine Tenant'").get();
  // Editing it to end before it starts is refused too.
  await c.get(`/app/tenancies/${tenancy.id}/edit`);
  r = await c.post(`/app/tenancies/${tenancy.id}`, { property_id: String(prop), tenant_id: String(tenancy.tenant_id), booking_date: '2026-09-01', start_date: '2026-10-01', end_date: '2026-09-15', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  assert.equal(r.status, 422);
  assert.match(r.text, /The start date can’t be after the end date/);
  assert.doesNotMatch(r.text, /The booking date can’t be after/);
});

test('property page: End tenancy button sets the end date and status; ended tenants show under Past', async () => {
  const c = await registerAndLogin('end-tenancy@example.com', 'End Tenancy Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '3 Ending Way', status: 'let' })).location);
  const prop2 = idFrom((await c.post('/app/properties', { address_line1: '4 Next Door', status: 'let' })).location);
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Leaving Lucy', booking_date: '2026-01-01', start_date: '2026-02-01', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const t = db.prepare("SELECT ty.id, ty.tenant_id FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id WHERE t.name = 'Leaving Lucy'").get();
  // Lucy also rents another place (still current there).
  await c.post(`/app/properties/${prop2}/add-tenant`, { tenant_mode: 'existing', tenant_id: String(t.tenant_id), booking_date: '2026-09-01', start_date: '2026-10-01', rent_pence: '800', rent_frequency: 'monthly', status: 'active' });
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Staying Sam', booking_date: '2026-01-01', start_date: '2026-02-01', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });

  let r = await c.get(`/app/properties/${prop}`);
  assert.match(r.text, new RegExp(`action="/app/tenancies/${t.id}/end"[\\s\\S]*?End tenancy`));
  r = await c.post(`/app/tenancies/${t.id}/end`, { end_date: '2026-01-15' });
  assert.match(decodeURIComponent(r.location), /can’t be before the start date/);
  r = await c.post(`/app/tenancies/${t.id}/end`, { end_date: '2026-09-30' });
  assert.match(decodeURIComponent(r.location), /Tenancy ended on 30\/09\/2026/);
  assert.deepEqual({ ...db.prepare('SELECT end_date, status FROM tenancies WHERE id = ?').get(t.id) }, { end_date: '2026-09-30', status: 'ended' });
  r = await c.get(`/app/properties/${prop}`);
  assert.doesNotMatch(r.text, new RegExp(`action="/app/tenancies/${t.id}/end"`), 'no button once ended');

  r = await c.get('/app/tenants?show=past');
  assert.match(r.text, /Leaving Lucy[\s\S]*?3 Ending Way/, 'past list shows the tenancy that ended');
  assert.doesNotMatch(r.text, /Staying Sam/);
  assert.match((await c.get('/app/tenants?show=current')).text, /Staying Sam/);
});

test('tenants: All lists every tenancy including ended ones; Edit buttons for tenancies on the tenant page', async () => {
  const c = await registerAndLogin('all-tenancies@example.com', 'All Tenancies Lets');
  const p1 = idFrom((await c.post('/app/properties', { address_line1: '1 Old Flat', status: 'let' })).location);
  const p2 = idFrom((await c.post('/app/properties', { address_line1: '2 New Flat', status: 'let' })).location);
  await c.post(`/app/properties/${p1}/add-tenant`, { tenant_mode: 'new', name: 'Moving Mo', booking_date: '2025-01-01', start_date: '2025-02-01', end_date: '2026-01-31', rent_pence: '700', rent_frequency: 'monthly', status: 'ended' });
  const mo = db.prepare("SELECT id FROM tenants WHERE name = 'Moving Mo'").get().id;
  await c.post(`/app/properties/${p2}/add-tenant`, { tenant_mode: 'existing', tenant_id: String(mo), booking_date: '2026-01-15', start_date: '2026-02-01', rent_pence: '800', rent_frequency: 'monthly', status: 'active' });
  let r = await c.get('/app/tenants?show=all');
  assert.match(r.text, /Moving Mo[\s\S]*?Moving Mo/, 'one line per tenancy');
  assert.match(r.text, /1 Old Flat/);
  assert.match(r.text, /2 New Flat/);
  r = await c.get(`/app/tenants/${mo}`);
  const active = db.prepare("SELECT id FROM tenancies WHERE tenant_id = ? AND status = 'active'").get(mo).id;
  assert.match(r.text, new RegExp(`<dt>Status</dt><dd class="status-edit"><span class="badge s-active">active</span> <a class="btn small" href="/app/tenancies/${active}/edit">Edit</a>`));
  const ended = db.prepare("SELECT id FROM tenancies WHERE tenant_id = ? AND status = 'ended'").get(mo).id;
  assert.match(r.text, new RegExp(`href="/app/tenancies/${ended}/edit">Edit</a>`), 'ended tenancy editable from the list');
});

test('tenant Edit form: a Council dropdown that changes the council of the property they rent', async () => {
  const c = await registerAndLogin('tenant-council@example.com', 'Tenant Council Lets');
  const leeds = idFrom((await c.post('/app/councils', { name: 'Leeds' })).location);
  const york = idFrom((await c.post('/app/councils', { name: 'York' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '6 Council Close', council_id: String(leeds), status: 'let' })).location);
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Cal Tenant', booking_date: '2026-01-01', start_date: '2026-02-01', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const tenant = db.prepare("SELECT id FROM tenants WHERE name = 'Cal Tenant'").get().id;
  let r = await c.get(`/app/tenants/${tenant}/edit`);
  assert.match(r.text, /name="phone"[\s\S]*?<label for="f-tenant_council_id">Council<\/label>[\s\S]*?<option value="\d+" selected>Leeds<\/option>/);
  r = await c.post(`/app/tenants/${tenant}`, { name: 'Cal Tenant', email: '', phone: '', notes: '', tenant_council_id: String(york) });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT council_id FROM properties WHERE id = ?').get(prop).council_id, york);
  assert.match((await c.get(`/app/tenants/${tenant}`)).text, /<dt>Council<\/dt>\s*<dd><a[^>]*>York/);
  // Someone else's council is refused.
  const other = await registerAndLogin('tenant-council-2@example.com', 'Other Council Lets');
  const theirs = idFrom((await other.post('/app/councils', { name: 'Theirs' })).location);
  await c.get(`/app/tenants/${tenant}/edit`);
  r = await c.post(`/app/tenants/${tenant}`, { name: 'Cal Tenant', email: '', phone: '', notes: '', tenant_council_id: String(theirs) });
  assert.equal(r.status, 422);
  assert.equal(db.prepare('SELECT council_id FROM properties WHERE id = ?').get(prop).council_id, york);
});

test('adding a property: no council tax account number or council tax paid by', async () => {
  const c = await registerAndLogin('no-ct@example.com', 'No CT Lets');
  const r = await c.get('/app/properties/new');
  assert.doesNotMatch(r.text, /Council tax account|Council tax paid by|name="council_tax_account"|name="council_tax_payer"/);
});

test('a tenancy with an end date that has come is ended automatically', async () => {
  const fmt = require('../src/format');
  const c = await registerAndLogin('auto-end@example.com', 'Auto End Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '9 Auto Road', status: 'let' })).location);
  let r = await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Past Pat', booking_date: '2025-01-01', start_date: '2025-02-01', end_date: fmt.addDays(fmt.today(), -1), rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare("SELECT ty.status FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id WHERE t.name = 'Past Pat'").get().status, 'ended');
  // Editing an active tenancy to add an end date of today ends it.
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Now Nell', booking_date: '2025-01-01', start_date: '2025-02-01', rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const nell = db.prepare("SELECT ty.* FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id WHERE t.name = 'Now Nell'").get();
  assert.equal(nell.status, 'active');
  await c.get(`/app/tenancies/${nell.id}/edit`);
  r = await c.post(`/app/tenancies/${nell.id}`, { property_id: String(prop), tenant_id: String(nell.tenant_id), booking_date: '2025-01-01', start_date: '2025-02-01', end_date: fmt.today(), rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT status FROM tenancies WHERE id = ?').get(nell.id).status, 'ended');
  // A future end date keeps it active until that day comes.
  await c.post(`/app/properties/${prop}/add-tenant`, { tenant_mode: 'new', name: 'Future Fay', booking_date: '2025-01-01', start_date: '2025-02-01', end_date: fmt.addDays(fmt.today(), 30), rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const fay = db.prepare("SELECT ty.id FROM tenancies ty JOIN tenants t ON t.id = ty.tenant_id WHERE t.name = 'Future Fay'").get().id;
  assert.equal(db.prepare('SELECT status FROM tenancies WHERE id = ?').get(fay).status, 'active');
  db.prepare('UPDATE tenancies SET end_date = ? WHERE id = ?').run(fmt.addDays(fmt.today(), -2), fay); // time passes
  await c.get('/app');
  assert.equal(db.prepare('SELECT status FROM tenancies WHERE id = ?').get(fay).status, 'ended');
});

test('admin panel users box has no Landlords, Properties or Tenancies columns', async () => {
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const r = await admin.get('/admin');
  const head = r.text.slice(r.text.indexOf('<th>User</th>'), r.text.indexOf('</tr>', r.text.indexOf('<th>User</th>')));
  assert.match(head, /Logins/);
  assert.doesNotMatch(head, /Landlords|Properties|Tenancies/);
});

test('council database: add entries, edit, end (moves to Previous tenant), back to Live, remove, and download', async () => {
  const c = await registerAndLogin('council-entries@example.com', 'Entries Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Enfield' })).location);
  await c.get(`/app/councils/${council}/database`);
  let r = await c.get(`/app/councils/${council}/database`);
  assert.doesNotMatch(r.text, /\+ Add entry/);
  assert.match(r.text, /<tr class="new-row">[\s\S]*?name="our_ref"[\s\S]*?form="new-entry"/, 'new entries typed into the empty row under the headings');
  r = await c.post(`/app/councils/${council}/database/entries`, { our_ref: '' });
  assert.match(decodeURIComponent(r.location), /Enter at least the reference/);
  r = await c.post(`/app/councils/${council}/database/entries`, { our_ref: 'AL1001', property_address: '1 Test Road N13', scheme: 'BB', property_size: '2 bed flat', property_reference: 'PR-9', reservation_date: '2026-09-01', booking_date: '2026-09-02', price_pence: '56', client_name: 'Test Client', contact_number: '07000 000000', people: '3', email: 'client@example.com' });
  assert.match(decodeURIComponent(r.location), /Entry added to Live/);
  const e = db.prepare('SELECT * FROM council_db_entries WHERE council_id = ?').get(council);
  assert.equal(e.price_pence, 5600);
  assert.equal(e.ended, 0);
  r = await c.get(`/app/councils/${council}/database`);
  assert.match(r.text, /id="live"[\s\S]*?End<\/button>[\s\S]*?AL1001[\s\S]*?Test Client[\s\S]*?id="previous"/, 'the End button is in the first column');
  assert.match(r.text, /id="live"[\s\S]*?<input form="entry-\d+" name="cancellation_date" type="date" value=""/, 'the cancellation date can be typed on Live');

  // Every cell is a box to type into; changes save by themselves.
  r = await c.get(`/app/councils/${council}/database`);
  assert.match(r.text, new RegExp(`<input form="entry-${e.id}" name="client_name" type="text" value="Test Client"`));
  assert.match(r.text, new RegExp(`<form id="entry-${e.id}"[^>]*data-autosave`));
  const saved = await fetch(`${base}/app/councils/${council}/database/entries/${e.id}`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'X-Autosave': '1' },
    body: new URLSearchParams({ _csrf: c.csrf, our_ref: 'AL1001', property_address: '1 Test Road N13', booking_date: '2026-09-02', client_name: 'Typed In Table', price_pence: '56' }) });
  assert.equal((await saved.json()).ok, true);
  assert.equal(db.prepare('SELECT client_name FROM council_db_entries WHERE id = ?').get(e.id).client_name, 'Typed In Table');
  // Edit it.
  await c.get(`/app/councils/${council}/database/entries/${e.id}/edit`);
  r = await c.post(`/app/councils/${council}/database/entries/${e.id}`, { our_ref: 'AL1001', property_address: '1 Test Road N13', booking_date: '2026-09-02', client_name: 'Test Client Jr', price_pence: '60' });
  assert.match(decodeURIComponent(r.location), /Entry saved/);
  assert.equal(db.prepare('SELECT client_name FROM council_db_entries WHERE id = ?').get(e.id).client_name, 'Test Client Jr');

  // End it: cancellation date set, moves to Previous tenant.
  await c.get(`/app/councils/${council}/database`);
  r = await c.post(`/app/councils/${council}/database/entries/${e.id}/end`, { cancellation_date: '2026-08-01' });
  assert.match(decodeURIComponent(r.location), /can’t be before the booking date/);
  r = await c.post(`/app/councils/${council}/database/entries/${e.id}/end`, { cancellation_date: '2026-10-16' });
  assert.match(decodeURIComponent(r.location), /now under Previous tenant/);
  assert.deepEqual({ ...db.prepare('SELECT ended, cancellation_date FROM council_db_entries WHERE id = ?').get(e.id) }, { ended: 1, cancellation_date: '2026-10-16' });
  r = await c.get(`/app/councils/${council}/database`);
  assert.match(r.text, /id="previous"[\s\S]*?name="cancellation_date" type="date" value="2026-10-16"[\s\S]*?value="Test Client Jr"/);

  // The download has it on the Previous tenant sheet.
  r = await c.get(`/app/councils/${council}/database.xlsx`);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const prev = wb.getWorksheet('Previous tenant');
  assert.equal(prev.getCell('A4').value, 'AL1001');
  assert.equal(prev.getCell('J4').value, 'Test Client Jr');
  assert.equal(prev.getCell('I4').value, 60);
  assert.equal(wb.getWorksheet('Live').getCell('A5').value, null);

  // Back to Live, then remove.
  await c.get(`/app/councils/${council}/database`);
  await c.post(`/app/councils/${council}/database/entries/${e.id}/reopen`, {});
  assert.deepEqual({ ...db.prepare('SELECT ended, cancellation_date FROM council_db_entries WHERE id = ?').get(e.id) }, { ended: 0, cancellation_date: null });
  await c.post(`/app/councils/${council}/database/entries/${e.id}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM council_db_entries WHERE council_id = ?').get(council).n, 0);

  // Another company can't touch these.
  const other = await registerAndLogin('council-entries-2@example.com', 'Other Entries Lets');
  assert.equal((await other.get(`/app/councils/${council}/database`)).status, 404);
});

test('rent run step 5 box: edit the Metro form details; typed-over totals are kept, blanks stay blank', async () => {
  const c = await registerAndLogin('step5-box@example.com', 'Step Five Lets');
  const co = db.prepare("SELECT id FROM users WHERE username = 'step5-box'").get().id;
  await c.get('/app/rent-run?month=2026-08');
  let r = await c.post('/app/rent-run/instruction/form', { month: '2026-08', store: 'Borehamwood', from_name: 'Step Five Client Account', contact_name: 'Theo', from_account_number: '87654321', payment_date: '2026-09-17', totalFigures: '£5,000.00', totalWords: '', count: '', signatory_1: 'Theo', signatory_2: '', then: 'save' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Saved the payment instruction details/);
  r = await c.get('/app/rent-run?month=2026-08');
  assert.doesNotMatch(r.text, /name="store"/, 'no Store box for now');
  assert.match(r.text, /name="totalFigures" value="£5,000-00"/);
  assert.match(r.text, /name="payment_date" value="2026-09-17"/);
  assert.doesNotMatch(r.text, /name="signatory_1"|name="signatory_2"|Customer signature/, 'the signature section is left for signing by hand');
  const { metroData } = require('../src/paymentInstruction')(db);
  const d = metroData({ id: co, name: 'Test User' }, '2026-08');
  assert.equal(d.store, '', 'store left blank on the form');
  assert.equal(d.contactName, 'Theo', 'the contact name goes on the form');
  assert.equal(d.accountName, 'Step Five Client Account');
  assert.equal(d.accountNumber, '87654321');
  assert.equal(d.totalFigures, '£5,000-00', 'typed-over total goes on the form');
  assert.deepEqual([d.signatory1, d.signatory2], ['', ''], 'no names printed in the signature boxes');
  assert.equal(d.valueDate, '17/09/2026');
  r = await c.post('/app/rent-run/instruction/form', { month: '2026-08', store: 'Borehamwood', then: 'metro' });
  assert.match(r.location, /^\/app\/rent-run\/documents\/\d+$/);
  const first = await c.get(r.location);
  assert.equal(first.headers.get('content-type'), 'application/pdf');
  // A second one; Previous documents lists both, newest first, with the date created.
  db.prepare("UPDATE metro_documents SET created_at = '2026-09-01 09:00:00' WHERE account_id = ?").run(co);
  await c.get('/app/rent-run?month=2026-08');
  r = await c.post('/app/rent-run/instruction/form', { month: '2026-08', store: 'Borehamwood', then: 'metro' });
  const newest = idFrom(r.location);
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /Previous documents \(2\)/);
  const rows = [...r.text.matchAll(/href="\/app\/rent-run\/documents\/(\d+)" target="_blank"/g)].map((m) => Number(m[1]));
  assert.equal(rows[0], newest, 'newest at the top');
  assert.match(r.text, /01\/09\/2026 09:00[\s\S]*?August 2026/);
  const other = await registerAndLogin('step5-box-2@example.com', 'Other Step Five');
  assert.equal((await other.get(`/app/rent-run/documents/${newest}`)).status, 404);
});

test('landlord invoice: Download invoice gives a PDF', async () => {
  const c = await registerAndLogin('li-download@example.com', 'LI Download Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Dan Download' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '2 Paper Lane', postcode: 'N1 1AA', landlord_id: String(ll), status: 'let' })).location);
  await c.get('/app/landlord-invoices/new');
  let r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_number: 'LI-7001', invoice_date: '2026-09-01', description: 'Inventory check', notes: 'Room by room', amount: '85' });
  const id = idFrom(r.location.split('?')[0]);
  r = await c.get(`/app/landlord-invoices/${id}`);
  assert.match(r.text, new RegExp(`href="/app/landlord-invoices/${id}/invoice.pdf">Download invoice`));
  r = await c.get(`/app/landlord-invoices/${id}/invoice.pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="2_Paper_Lane_N1_1AA_-_September_2026\.pdf"/);
  assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  const other = await registerAndLogin('li-download-2@example.com', 'Other LI Lets');
  assert.equal((await other.get(`/app/landlord-invoices/${id}/invoice.pdf`)).status, 404);
});

test('invoice tabs: month boxes on Landlord invoices like Contractors invoices, and centred boxes on both', async () => {
  const c = await registerAndLogin('li-tiles@example.com', 'LI Tiles Lets');
  let r = await c.get('/app/landlord-invoices?month=2026-09');
  assert.match(r.text, /<section class="tiles centered-tiles">[\s\S]*?Unpaid · September 2026[\s\S]*?Unpaid · all months[\s\S]*?Paid · September 2026/);
  r = await c.get('/app/invoices?month=2026-09');
  assert.match(r.text, /<section class="tiles centered-tiles">[\s\S]*?Unpaid · all months/);
});

test('contractor page: boxes for paid in a chosen month, paid all time, unpaid and last paid', async () => {
  const c = await registerAndLogin('contractor-tiles@example.com', 'Contractor Tiles Lets');
  const prop = idFrom((await c.post('/app/properties', { address_line1: '1 Tile Street', status: 'let' })).location);
  const body = (amount, date) => ({ supplier: 'Tile Fixers', amount, landlord_amount: amount, charge_landlord: 'no', invoice_date: date, property_id: String(prop) });
  await c.get('/app/invoices/new');
  const a = idFrom((await c.post('/app/invoices', body('100', '2026-08-05'), { multipart: true })).location);
  const b = idFrom((await c.post('/app/invoices', body('40', '2026-09-03'), { multipart: true })).location);
  await c.post('/app/invoices', body('25', '2026-09-20'), { multipart: true });
  db.prepare("UPDATE invoices SET status = 'paid', paid_date = '2026-08-10' WHERE id = ?").run(a);
  db.prepare("UPDATE invoices SET status = 'paid', paid_date = '2026-09-06' WHERE id = ?").run(b);
  const contractor = db.prepare("SELECT id FROM contractors WHERE name = 'Tile Fixers'").get().id;
  let r = await c.get(`/app/contractors/${contractor}?month=2026-09`);
  assert.match(r.text, /Paid in[\s\S]*?<option value="2026-09" selected>September 2026[\s\S]*?class="value">£40\.00/);
  assert.match(r.text, /Paid all time<\/span><span class="value">£140\.00/);
  assert.match(r.text, /Unpaid<\/span><span class="value">£25\.00/);
  assert.match(r.text, /Last paid<\/span><span class="value sm">06\/09\/2026/);
  r = await c.get(`/app/contractors/${contractor}?month=2026-08`);
  assert.match(r.text, /<option value="2026-08" selected>August 2026[\s\S]*?class="value">£100\.00/);
});

test('landlords have a Date started, shown in their info box', async () => {
  const c = await registerAndLogin('ll-started@example.com', 'LL Started Lets');
  let r = await c.get('/app/landlords/new');
  assert.match(r.text, /Date started[\s\S]*?name="date_started"[^>]*value="\d{4}-\d{2}-\d{2}"/, 'defaults to today');
  const id = idFrom((await c.post('/app/landlords', { name: 'Stella Start', date_started: '2019-04-01', statement_type: 'Email' })).location);
  r = await c.get(`/app/landlords/${id}`);
  assert.match(r.text, /<dt>Date started<\/dt>[\s\S]*?01\/04\/2019/);
});

test('landlord invoice number can be changed; no Paid by us option', async () => {
  const c = await registerAndLogin('li-number@example.com', 'LI Number Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Nia Number' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '3 Count Road', landlord_id: String(ll), status: 'let' })).location);
  await c.get('/app/landlord-invoices/new');
  let r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_number: 'LI-0500', invoice_date: '2026-09-01', description: 'Key cutting', amount: '15' });
  const id = idFrom(r.location.split('?')[0]);
  assert.equal(db.prepare('SELECT invoice_number FROM landlord_invoices WHERE id = ?').get(id).invoice_number, 'LI-0500');
  assert.match((await c.get('/app/landlord-invoices/new')).text, /name="invoice_number" value="LI-0501"/, 'carries on from the highest');
  r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_number: 'LI-0500', invoice_date: '2026-09-01', description: 'Dup', amount: '1' });
  assert.equal(r.status, 422);
  assert.match(r.text, /LI-0500 is already used/);
  // No "Paid by us" option: if the agency pays, no invoice is raised.
  assert.doesNotMatch((await c.get(`/app/landlord-invoices/${id}`)).text, /Paid by us|value="us"/);
});

test('landlord invoice paid over several months: deducted a month at a time, undone and re-split on edit', async () => {
  const c = await registerAndLogin('li-months@example.com', 'LI Months Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Ivy Instalment' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '4 Split Street', landlord_id: String(ll), status: 'let' })).location);
  let r = await c.get('/app/landlord-invoices/new');
  assert.match(r.text, /name="months"[\s\S]*?<option value="3" >3 months/);
  r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_date: '2026-09-15', description: 'New boiler', amount: '100', months: '3', then: 'deduct' });
  assert.match(decodeURIComponent(r.location), /over 3 months from September 2026/);
  const id = idFrom(r.location.split('?')[0]);
  const fees = () => db.prepare("SELECT txn_date, amount_pence, description FROM transactions WHERE landlord_id = ? AND txn_type = 'fee' ORDER BY txn_date").all(ll).map((t) => ({ ...t }));
  assert.deepEqual(fees().map((t) => [t.txn_date, t.amount_pence]), [['2026-09-15', 3334], ['2026-10-15', 3333], ['2026-11-15', 3333]]);
  assert.match(fees()[1].description, /\(2 of 3\)/);
  r = await c.get(`/app/landlord-invoices/${id}`);
  assert.match(r.text, /Paid over 3 months[\s\S]*?1 of 3<\/td><td>September 2026<\/td><td class="num">£33\.34[\s\S]*?3 of 3<\/td><td>November 2026/);
  assert.match(r.text, /deducted from the rent payment over 3 months/);
  // Editing to 2 months re-splits the deductions.
  await c.get(`/app/landlord-invoices/${id}/edit`);
  await c.post(`/app/landlord-invoices/${id}`, { landlord_id: String(ll), property_id: String(prop), invoice_date: '2026-09-15', description: 'New boiler', amount: '100', months: '2' });
  assert.deepEqual(fees().map((t) => [t.txn_date, t.amount_pence]), [['2026-09-15', 5000], ['2026-10-15', 5000]]);
  // Undo removes every deduction.
  await c.post(`/app/landlord-invoices/${id}/unsettle`, {});
  assert.equal(fees().length, 0);
  // Month-end dates stay in the right month.
  await c.post(`/app/landlord-invoices/${id}/settle`, { how: 'deduct', date: '2026-01-31' });
  assert.deepEqual(fees().map((t) => t.txn_date), ['2026-01-31', '2026-02-28']);
  await c.post(`/app/landlord-invoices/${id}/delete`, {});
  assert.equal(fees().length, 0, 'deleting removes them all');
});

test('landlord invoice instalments: an Edit button beside each deducted payment changes its amount or date', async () => {
  const c = await registerAndLogin('li-inst-edit@example.com', 'LI Inst Edit Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Ed Instalment' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '5 Edit Road', landlord_id: String(ll), status: 'let' })).location);
  await c.get('/app/landlord-invoices/new');
  let r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_date: '2026-01-10', description: 'Roof', amount: '90', months: '3', then: 'deduct' });
  const id = idFrom(r.location.split('?')[0]);
  const txns = db.prepare("SELECT id FROM transactions WHERE landlord_id = ? AND txn_type = 'fee' ORDER BY txn_date").all(ll).map((t) => t.id);
  r = await c.get(`/app/landlord-invoices/${id}`);
  assert.match(r.text, new RegExp(`Deducted</span></td><td><a class="btn small" href="/app/landlord-invoices/${id}/instalments/${txns[0]}/edit">Edit</a>`));
  await c.get(`/app/landlord-invoices/${id}/instalments/${txns[1]}/edit`);
  r = await c.post(`/app/landlord-invoices/${id}/instalments/${txns[1]}`, { date: '2026-02-20', amount: '45' });
  assert.match(decodeURIComponent(r.location), /Payment 2 changed to £45\.00 on 20\/02\/2026/);
  assert.deepEqual({ ...db.prepare('SELECT txn_date, amount_pence FROM transactions WHERE id = ?').get(txns[1]) }, { txn_date: '2026-02-20', amount_pence: 4500 });
  r = await c.get(`/app/landlord-invoices/${id}`);
  assert.match(r.text, /add up to £105\.00, not the invoice's £90\.00/);
  // Only this invoice's payments can be edited.
  const other = db.prepare("INSERT INTO transactions (account_id, txn_date, txn_type, landlord_id, amount_pence) VALUES (?, '2026-01-01', 'fee', ?, 1)").run(db.prepare("SELECT id FROM users WHERE username = 'li-inst-edit'").get().id, ll);
  assert.equal((await c.get(`/app/landlord-invoices/${id}/instalments/${Number(other.lastInsertRowid)}/edit`)).status, 404);
});

test('Landlord invoices list: an Edit button to the right of Deducted', async () => {
  const c = await registerAndLogin('li-list-edit@example.com', 'LI List Edit Lets');
  const ll = idFrom((await c.post('/app/landlords', { name: 'Lea List' })).location);
  const prop = idFrom((await c.post('/app/properties', { address_line1: '6 List Lane', landlord_id: String(ll), status: 'let' })).location);
  await c.get('/app/landlord-invoices/new');
  const r = await c.post('/app/landlord-invoices', { landlord_id: String(ll), property_id: String(prop), invoice_date: '2026-09-01', description: 'Keys', amount: '10' });
  const id = idFrom(r.location.split('?')[0]);
  const list = (await c.get('/app/landlord-invoices?month=2026-09')).text;
  assert.match(list, /<th>Deducted<\/th><th><\/th>/);
  assert.match(list, new RegExp(`yes-no no">No</span></td>\\s*<td class="num"><a class="btn small" href="/app/landlord-invoices/${id}/edit">Edit</a>`));
});

test('council reconciliation: download as Excel (agency layout) and a print page', async () => {
  const c = await registerAndLogin('rec-xlsx@example.com', 'Rec Xlsx Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Haringey BB' })).location);
  await c.get('/app/council-reconciliation?month=2026-07');
  await c.req('POST', '/app/council-reconciliation/notes', { council_id: String(council), month: '2026-07', notes: '', owed: '32457', received: '32457', received_date: '2026-09-14', email_sent_date: '2026-09-01' });
  let r = await c.get('/app/council-reconciliation?month=2026-07');
  assert.match(r.text, /href="\/app\/council-reconciliation\.xlsx\?month=2026-07">Download Excel[\s\S]*?href="\/app\/council-reconciliation\/print\?month=2026-07"[^>]*>Print/);
  r = await c.get('/app/council-reconciliation.xlsx?month=2026-07');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Rec_Xlsx_Lets_Payment_Reconciliation_July_2026\.xlsx/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'July 2026');
  assert.equal(ws.getCell('A2').value, 'RECONCILIATION  REC XLSX LETS');
  assert.equal(ws.getCell('B4').value, 'JULY 2026');
  assert.equal(ws.getCell('D5').value, 'PAYMENTS TO REC XLSX LETS BY LOCAL AUTHORITIES');
  assert.equal(ws.getCell('B7').value, 'Haringey BB');
  assert.equal(ws.getCell('C7').value, 32457);
  assert.equal(ws.getCell('E7').value.formula, 'SUM(C7-D7)');
  assert.equal(new Date(ws.getCell('F7').value).toISOString().slice(0, 10), '2026-09-14');
  assert.equal(ws.getCell('C9').value.formula, 'SUM(C7:C7)');
  r = await c.get('/app/council-reconciliation/print?month=2026-07');
  assert.match(r.text, /RECONCILIATION&nbsp;&nbsp;REC XLSX LETS[\s\S]*?JULY 2026[\s\S]*?Haringey BB[\s\S]*?£32,457\.00[\s\S]*?14\/09\/2026[\s\S]*?01\/09\/2026/);
  assert.match(r.text, /data-print/);
});

test('rent run step 5: Preview document shows the Metro form with what is typed, without saving', async () => {
  const c = await registerAndLogin('step5-preview@example.com', 'Preview Lets');
  let r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /formaction="\/app\/rent-run\/instruction\/preview" formtarget="_blank">Preview document/);
  r = await c.post('/app/rent-run/instruction/preview', { month: '2026-08', store: 'Unsaved Branch', from_name: 'X', totalFigures: '£1.00' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  const co = db.prepare("SELECT id FROM users WHERE username = 'step5-preview'").get().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_instructions WHERE account_id = ?').get(co).n, 0, 'nothing saved');
});

test('rent run step 5: presets to fill in the Metro form, with Edit and Remove', async () => {
  const c = await registerAndLogin('presets@example.com', 'Preset Lets');
  let r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, /data-preset-pick[\s\S]*?Fill in[\s\S]*?Presets \(0\)/);
  r = await c.post('/app/rent-run/presets', { month: '2026-08', preset_name: 'Main client account', store: 'Borehamwood', from_name: 'Preset Lets Client', contact_name: 'Theo', from_account_number: '12345678', signatory_1: 'Theo', signatory_2: 'Sam', totalFigures: '£9' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, ' ')), /Saved the preset “Main client account”/);
  const p = db.prepare("SELECT * FROM metro_presets WHERE name = 'Main client account'").get();
  assert.deepEqual(JSON.parse(p.data_json), { from_name: 'Preset Lets Client', contact_name: 'Theo', from_account_number: '12345678' });
  r = await c.get('/app/rent-run?month=2026-08');
  assert.match(r.text, new RegExp(`<option value="${p.id}" data-preset="[^"]*Preset Lets Client[^"]*">Main client account</option>`));
  assert.match(r.text, new RegExp(`href="/app/rent-run/presets/${p.id}/edit\\?month=2026-08">Edit`));
  // Edit it.
  r = await c.get(`/app/rent-run/presets/${p.id}/edit?month=2026-08`);
  assert.match(r.text, /name="from_name" value="Preset Lets Client"/);
  r = await c.post(`/app/rent-run/presets/${p.id}`, { month: '2026-08', name: 'Main account', from_name: 'Preset Lets Client 2', contact_name: 'Theo', from_account_number: '12345678', signatory_1: 'Theo', signatory_2: '' });
  assert.equal(db.prepare('SELECT name FROM metro_presets WHERE id = ?').get(p.id).name, 'Main account');
  assert.equal(JSON.parse(db.prepare('SELECT data_json FROM metro_presets WHERE id = ?').get(p.id).data_json).from_name, 'Preset Lets Client 2');
  // Another company can't see or change it; remove it.
  const other = await registerAndLogin('presets-2@example.com', 'Other Preset Lets');
  assert.equal((await other.get(`/app/rent-run/presets/${p.id}/edit`)).status, 404);
  await c.get('/app/rent-run?month=2026-08');
  await c.post(`/app/rent-run/presets/${p.id}/delete`, { month: '2026-08' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM metro_presets WHERE id = ?').get(p.id).n, 0);
});

test('security headers, malformed cookies and sign-out clean-up', async () => {
  const c = new Client();
  const page = await c.get('/login');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
  assert.match(page.headers.get('cache-control'), /no-store/, 'pages with data are never cached');
  // A broken cookie must not break the site.
  const bad = await fetch(base + '/login', { headers: { cookie: 'sid=%E0%A4%A' } });
  assert.equal(bad.status, 200);

  const agent = await registerAndLogin('headers@example.com', 'Header Lets');
  assert.match((await agent.get('/app')).text, /data-who="\d+"/, 'the page says whose form copies it may keep');
  const out = await agent.post('/logout', {});
  assert.match(out.headers.get('clear-site-data'), /"storage"/, 'signing out clears copies of forms left in the browser');
});

test('repeated wrong passwords for one agency are blocked from any address', async () => {
  const agent = await registerAndLogin('bruteforce@example.com', 'Brute Lets');
  const username = usernameFor('bruteforce@example.com');
  // Different names give each attempt its own per-name counter; the per-agency counter still adds up.
  for (let i = 0; i < 30; i++) {
    const r = await new Client().post('/login', { login: username, member: `Guess${i}`, password: 'wrong-password' });
    assert.equal(r.status, 401);
  }
  const blocked = await new Client().post('/login', { login: username, member: 'Test', password: 'kettle-harbour-58' });
  assert.equal(blocked.status, 429, 'even the right password waits once the agency has had 30 wrong guesses');
  assert.ok(agent);
});

test('dark mode switch is saved per person and applied to every page', async () => {
  const c = await registerAndLogin('theme@example.com', 'Theme Lets');
  const dash = await c.get('/app');
  assert.match(dash.text, /id="theme-switch"/);
  assert.doesNotMatch(dash.text, /<html lang="en-GB" data-theme/, 'follows the computer until chosen');
  const r = await c.post('/app/theme', { theme: 'dark' });
  assert.equal(r.status, 200);
  assert.match((await c.get('/app/landlords')).text, /<html lang="en-GB" data-theme="dark">/);
  await c.post('/app/theme', { theme: '"><script>' });
  assert.doesNotMatch((await c.get('/app')).text, /data-theme=/, 'anything else resets to the computer setting');
  c.csrf = 'wrong';
  assert.equal((await c.post('/app/theme', { theme: 'dark' })).status, 403);
});

test('rent run steps 4 and 5: Bank Transfer sheet (.xlsx) and Metro bulk file (.xlsm) from the Rift report', async () => {
  const c = await registerAndLogin('bank-files@example.com', 'Bank Files Lets');
  const co = db.prepare("SELECT id FROM users WHERE username = 'bank-files'").get().id;
  const landlord = (name, code, extra = {}) => Number(db.prepare(
    `INSERT INTO landlords (account_id, name, code, statement_type, bank_account_name, bank_sort_code, bank_account_number, bank_name, payment_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(co, name, code, extra.type || 'Email', extra.accName || null, extra.sort ?? '30-93-84', extra.acc ?? '12345678', extra.bank || 'Lloyds', extra.note || null).lastInsertRowid);
  const statement = (l, closing, props) => db.prepare(
    `INSERT INTO monthly_statements (account_id, landlord_id, month, opening_pence, rent_pence, fees_pence, expenses_pence, net_pence,
      payments_pence, closing_pence, outstanding_pence, detail_json, summary, summary_source, generated_at)
     VALUES (?, ?, '2026-09', 0, 0, 0, 0, ?, 0, ?, 0, ?, 'x', 'template', datetime('now'))`
  ).run(co, l, closing, closing, JSON.stringify({ properties: props }));
  // Two properties that add up exactly: a row each. One property: one row. Nothing held: "No payment".
  statement(landlord('Mr Two Props', 'L102', { acc: '01234567' }), 150000, [
    { id: 1, address_line1: '1 First Road', rent: 100000, fees: 10000, expenses: 0 },
    { id: 2, address_line1: '2 Second Road', rent: 70000, fees: 10000, expenses: 0 }]);
  statement(landlord('Ms One Prop', 'L101', { accName: 'One Prop Ltd', bank: 'HSBC' }), 90000, [{ id: 3, address_line1: '3 Third Road', rent: 100000, fees: 10000, expenses: 0 }]);
  statement(landlord('Mr Unpaid', 'L103', { note: 'QUARTERLY' }), 0, [{ id: 4, address_line1: '4 Fourth Road', rent: 0, fees: 0, expenses: 0 }]);
  statement(landlord('Mrs Cheque', 'L104', { type: 'Cheque' }), 50000, []);
  statement(landlord('Mr No Bank', 'L105', { sort: '', acc: '' }), 20000, []);

  const bulk = require('../src/bulkPayment');
  const t = bulk.transferRows(db, co, '2026-09');
  assert.deepEqual(t.rows.map((r) => [r.code, r.reference, r.pence]), [
    ['L101', '3 Third Road', 90000], ['L102', '1 First Road', 90000], ['L102', '2 Second Road', 60000],
    ['L103', '4 Fourth Road', null], ['L105', 'L105 Rent Sept 26', 20000]]);
  assert.deepEqual(t.cheques.map((x) => x.name), ['Mrs Cheque']);
  const b = bulk.bulkRows(db, co, '2026-09');
  assert.equal(b.rows.length, 4, 'no "No payment" rows in the bulk file');
  assert.equal(b.total, 260000, 'the Rift report total, less cheques');
  assert.deepEqual(b.problems.map((p) => p.name), ['Mr No Bank']);

  // Rent run: step 4, step 5, step 5.1; previews; downloads.
  let r = await c.get('/app/rent-run?month=2026-09');
  assert.match(r.text, /href="\/app\/rent-run\/transfer\.xlsx\?month=2026-09"/);
  assert.match(r.text, /href="\/app\/rent-run\/bulk\.xlsm\?month=2026-09"/);
  r = await c.get('/app/rent-run/transfer?month=2026-09');
  assert.match(r.text, /Bank Files Lets SEPTEMBER 2026 Bank Transfer/);
  assert.match(r.text, /4 Fourth Road[\s\S]*?No payment[\s\S]*?yellow-note">QUARTERLY/);
  r = await c.get('/app/rent-run/bulk?month=2026-09');
  assert.match(r.text, /Mr No Bank<\/a>: no sort code, no account number/);
  assert.doesNotMatch(r.text, /Mrs Cheque<\/td>/);

  r = await c.get('/app/rent-run/transfer.xlsx?month=2026-09');
  assert.match(r.headers.get('content-disposition'), /Bank_Files_Lets_SEPT_2026_Online_payments\.xlsx/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('B1').value, 'Bank Files Lets SEPTEMBER 2026 Bank Transfer');
  assert.deepEqual(ws.getRow(3).values.slice(1, 8), ['Landlord', 'LCODE', 'Property Address / Reference', 'Sort Code', 'Account Number', 'Bank Name', 'Amount']);
  assert.deepEqual(ws.getRow(4).values.slice(1, 8), ['Ms One Prop', 'L101', '3 Third Road', '30-93-84', 12345678, 'HSBC', 900]);
  assert.equal(ws.getCell('E5').value, '01234567', 'an account number starting with 0 keeps it');
  assert.equal(ws.getCell('G7').value, 'No payment');
  assert.equal(ws.getCell('H7').value, 'QUARTERLY');
  assert.equal(ws.getCell('F9').value, 'Total');
  assert.equal(ws.getCell('G9').value.formula, 'SUM(G4:G8)');

  r = await c.get('/app/rent-run/bulk.xlsm?month=2026-09');
  assert.equal(r.headers.get('content-type'), 'application/vnd.ms-excel.sheet.macroEnabled.12');
  assert.match(r.headers.get('content-disposition'), /filename="\d{1,2}(st|nd|rd|th)_[A-Z]+_\d{4}\.xlsm"/, 'named after the payment date (today until one is set)');
  const zip = await require('jszip').loadAsync(r.buf);
  assert.ok(zip.file('xl/vbaProject.bin'), 'Metro\'s macro (the CREATE TXT FILE button) is kept');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<c r="A2" s="8" t="inlineStr"><is><t xml:space="preserve">30-93-84<\/t><\/is><\/c><c r="B2" s="10" t="inlineStr"><is><t xml:space="preserve">One Prop Ltd<\/t>/);
  assert.match(sheet, /<c r="E6" s="19"><f>SUM\(E2:E5\)<\/f><v>2600\.00<\/v><\/c>/);
  // Nothing from the original files (names, bank links) is left in the templates.
  for (const f of ['metro-bulk-payment-template.xlsm.tpl', 'online-payments-template.xlsx.tpl']) {
    const z = await require('jszip').loadAsync(require('fs').readFileSync(require('path').join(__dirname, '..', 'assets', f)));
    for (const name of Object.keys(z.files).filter((n) => /\.(xml|rels)$/.test(n))) {
      const text = await z.file(name).async('string');
      assert.doesNotMatch(text, /bankline|sharepoint|TargetMode="External"/i, `${f} ${name}: no links out`);
      assert.doesNotMatch(text, /<dc:creator>[^<]|<cp:lastModifiedBy>[^<]/, `${f} ${name}: no author names`);
    }
  }
});

test('login: over-long input is refused quickly, counted as a wrong attempt, and the boxes have limits', async () => {
  const page = (await new Client().get('/login')).text;
  assert.match(page, /name="login"[^>]*maxlength="60"/);
  assert.match(page, /name="member"[^>]*maxlength="60"/);
  assert.match(page, /name="password"[^>]*maxlength="200"/);
  const agent = await registerAndLogin('long-pass@example.com', 'Long Pass Lets');
  assert.ok(agent);
  const username = usernameFor('long-pass@example.com');
  const huge = 'x'.repeat(100000);
  const started = Date.now();
  const r = await new Client().post('/login', { login: username, member: 'Test', password: huge });
  assert.equal(r.status, 401);
  assert.match(r.text, /Incorrect agency, name or password/);
  assert.ok(Date.now() - started < 2000, 'answered without hashing the huge password');
  assert.ok(db.prepare("SELECT 1 FROM login_events WHERE email = ? AND success = 0").get(`${username} / Test`), 'logged as a failed attempt');
  // A long password can't be set in the first place.
  const reg = await new Client().post('/register', { username: 'toolong', name: 'T', agency_name: 'T', password: 'y'.repeat(201), password_confirm: 'y'.repeat(201) });
  assert.equal(reg.status, 422);
  assert.match(reg.text, /Use at most 200 characters/);
});

test('landlord bank details changes are recorded and flagged until checked with the landlord', async () => {
  const c = await registerAndLogin('bank-change@example.com', 'Bank Change Lets');
  const id = idFrom((await c.post('/app/landlords', { name: 'Mr Careful', statement_type: 'Email' })).location);
  const save = (fields) => c.post(`/app/landlords/${id}`, { name: 'Mr Careful', statement_type: 'Email', ...fields });
  // Filling them in for the first time isn't a change.
  await save({ bank_account_name: 'Mr Careful', bank_sort_code: '30-93-84', bank_account_number: '12345678' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM landlord_bank_changes WHERE landlord_id = ?').get(id).n, 0);
  let page = (await c.get(`/app/landlords/${id}`)).text;
  assert.doesNotMatch(page, /Bank details changed/);
  // Changing them is.
  await save({ bank_account_name: 'Mr Careful', bank_sort_code: '11-22-33', bank_account_number: '87654321' });
  // Edits straight after (e.g. autosave while typing) are the same change.
  await save({ bank_account_name: 'Mr Careful', bank_sort_code: '11-22-33', bank_account_number: '87654329' });
  const changes = db.prepare('SELECT * FROM landlord_bank_changes WHERE landlord_id = ?').all(id);
  assert.equal(changes.length, 1);
  assert.deepEqual([changes[0].old_account, changes[0].new_account], ['12345678', '87654329']);
  page = (await c.get(`/app/landlords/${id}`)).text;
  assert.match(page, /Bank details changed — check with the landlord before paying them/);
  assert.match(page, /account ••••5678 → ••••4329/, 'account numbers are masked');
  assert.doesNotMatch(page, /87654329<\/li>/);
  // Shown in the rent run's payment files too.
  db.prepare(`INSERT INTO monthly_statements (account_id, landlord_id, month, opening_pence, rent_pence, fees_pence, expenses_pence, net_pence,
    payments_pence, closing_pence, outstanding_pence, detail_json, summary, summary_source, generated_at)
    VALUES (?, ?, '2026-09', 0, 0, 0, 0, 1000, 0, 1000, 0, '{}', 'x', 'template', datetime('now'))`)
    .run(db.prepare("SELECT id FROM users WHERE username = 'bank-change'").get().id, id);
  assert.match((await c.get('/app/rent-run/bulk?month=2026-09')).text, /Bank details changed and not yet checked[\s\S]*?Mr Careful/);
  assert.match((await c.get('/app/rent-run?month=2026-09')).text, /1 landlord with changed bank details to check/);
  // Another company can't clear it; the landlord's own agency can.
  const other = await registerAndLogin('bank-change-2@example.com', 'Other Bank Lets');
  assert.equal((await other.post(`/app/landlords/${id}/bank-checked`, {})).status, 404);
  await c.get(`/app/landlords/${id}`);
  await c.post(`/app/landlords/${id}/bank-checked`, {});
  assert.ok(db.prepare('SELECT checked_at FROM landlord_bank_changes WHERE landlord_id = ?').get(id).checked_at);
  assert.doesNotMatch((await c.get(`/app/landlords/${id}`)).text, /Bank details changed/);
});

test('weak passwords are refused wherever a password is set; the admin is nudged to use two-step login', async () => {
  const auth = require('../src/auth');
  assert.ok(auth.weakPassword('Password123!'));
  assert.ok(auth.weakPassword('qwerty1234'));
  assert.ok(auth.weakPassword('aaaaaaaaaaaa'));
  assert.ok(auth.weakPassword('harbourlets2026', ['harbourlets']));
  assert.equal(auth.weakPassword('kettle-harbour-58', ['sam', 'coast']), '');
  const r = await new Client().post('/register', { username: 'weakling', name: 'Weak Ling', agency_name: 'Weak Lets', password: 'password123', password_confirm: 'password123' });
  assert.equal(r.status, 422);
  assert.match(r.text, /too common/);
  const admin = new Client();
  await admin.login('admin', 'owner-password-123');
  const page = (await admin.get('/admin')).text;
  assert.match(page, /Two-step login is off for your admin account/);
  const created = await admin.post('/admin/users', { agency_name: 'Sunny Lets', name: 'Sunny Day', username: 'sunnylets', password: 'sunnylets-99' });
  assert.equal(created.status, 422);
  assert.match(created.text, /username, name or agency/);
});

test('council page: Council Database and Council Invoices boxes under Properties in this council', async () => {
  const c = await registerAndLogin('council-boxes@example.com', 'Council Boxes Lets');
  const council = idFrom((await c.post('/app/councils', { name: 'Boxes Council' })).location);
  let page = (await c.get(`/app/councils/${council}`)).text;
  assert.match(page, /<details class="card fold" id="council-properties"><summary><h2>Properties in this council[\s\S]*?<details class="card fold" id="council-database">\s*<summary><h2>Council Database[\s\S]*?<details class="card fold" id="council-invoices">\s*<summary><h2>Council Invoices/, 'three drop-down boxes');
  assert.match(page, /No live entries yet/);
  await c.get(`/app/councils/${council}/database`);
  await c.post(`/app/councils/${council}/database/entries`, { our_ref: 'BX1', property_address: '5 Box Lane', client_name: 'Made Up Client', booking_date: '2026-09-01', price_pence: '45' });
  page = (await c.get(`/app/councils/${council}`)).text;
  assert.match(page, /<td>BX1<\/td><td>5 Box Lane<\/td><td>Made Up Client<\/td><td>01\/09\/2026<\/td><td class="num">£45\.00<\/td>/);
  assert.match(page, new RegExp(`href="/app/councils/${council}/database\\.xlsx">Download Excel`));
  // Another company's council isn't shown.
  const other = await registerAndLogin('council-boxes-2@example.com', 'Other Boxes Lets');
  assert.equal((await other.get(`/app/councils/${council}`)).status, 404);
});

test('with the idle sign-out turned off (0), people stay signed in', async () => {
  const s = createApp({ ...config, idleTimeoutMinutes: 0 }, db, { mailer: fakeMailer }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const c = await registerAndLogin('no-idle@example.com', 'No Idle Lets');
    // Pretend they were last seen a week ago.
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-7 days')").run();
    const r = await fetch(`${url}/app`, { headers: { cookie: c.cookie }, redirect: 'manual' });
    assert.equal(r.status, 200, 'not signed out');
  } finally { s.close(); }
});

test('phones: the page fits the screen (viewport tag, shrinking forms, scrolling tables, 16px boxes)', async () => {
  const c = await registerAndLogin('phone-fit@example.com', 'Phone Fit Lets');
  assert.match((await c.get('/app')).text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  const css = await (await fetch(`${base}/static/style.css`)).text();
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/, 'one-column forms that can shrink');
  assert.match(css, /\.table-wrap > table \{ table-layout: auto; width: max-content; min-width: 100%; \}/, 'tables scroll sideways instead of squashing');
  assert.match(css, /input, select, textarea, table\.council-db \.cell-input \{ font-size: 16px; \}/, 'no iPhone zoom when tapping a box');
  assert.match(css, /\.form-actions \{ flex-wrap: wrap; \}/);
});

test('landlord invoices tab: profit from contractor invoices this month and all time (paid, charged to a landlord)', async () => {
  const c = await registerAndLogin('profit-tiles@example.com', 'Profit Tiles Lets');
  const ll = String(idFrom((await c.post('/app/landlords', { name: 'Profit Owner', statement_type: 'Email' })).location));
  const prop = String(idFrom((await c.post('/app/properties', { address_line1: '7 Margin Road', status: 'let', landlord_id: ll })).location));
  const add = async (fields) => { await c.get('/app/invoices/new'); return c.post('/app/invoices', { maintenance_job_id: 'none', property_id: prop, charge_landlord: 'yes', ...fields }, { multipart: true }); };
  await add({ supplier: 'Sept Co', amount: '100', landlord_amount: '150', invoice_date: '2026-09-05', then: 'deduct' }); // +50 in September
  await add({ supplier: 'Aug Co', amount: '80', landlord_amount: '100', invoice_date: '2026-08-10', then: 'deduct' }); // +20 in August
  await add({ supplier: 'Unpaid Co', amount: '10', landlord_amount: '500', invoice_date: '2026-09-06' }); // not paid: not counted
  await add({ supplier: 'Ours Co', amount: '40', charge_landlord: 'no', invoice_date: '2026-09-07' }); // not charged: not counted
  const r = (await c.get('/app/landlord-invoices?month=2026-09')).text;
  assert.match(r, /Profit from invoices · September 2026<\/span><span class="value ok-text" id="profit-month">£50\.00/);
  assert.match(r, /Profit from invoices · all time<\/span><span class="value ok-text" id="profit-all">£70\.00/);
  assert.match((await c.get('/app/landlord-invoices?month=2026-08')).text, /id="profit-month">£20\.00/);
});

test('dashboard: properties box (empty needing maintenance or ready, booked, acquired and handed back this month)', async () => {
  const c = await registerAndLogin('prop-box@example.com', 'Prop Box Lets');
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const fixer = String(idFrom((await c.post('/app/properties', { address_line1: '1 Fixer Road', status: 'vacant' })).location));
  await c.post('/app/properties', { address_line1: '2 Ready Road', status: 'vacant' });
  await c.post('/app/maintenance', { property_id: fixer, title: 'Repaint', priority: 'normal', status: 'open' });
  const let1 = String(idFrom((await c.post('/app/properties', { address_line1: '3 Booked Road', status: 'let' })).location));
  const ten = String(idFrom((await c.post('/app/tenants', { name: 'Made Up Tenant' })).location));
  await c.post('/app/tenancies', { property_id: let1, tenant_id: ten, booking_date: today, start_date: today, rent_pence: '900', rent_frequency: 'monthly', status: 'active' });
  const back = String(idFrom((await c.post('/app/properties', { address_line1: '4 Returned Road', status: 'let', acquired_date: '2025-01-01' })).location));
  await c.post(`/app/properties/${back}`, { address_line1: '4 Returned Road', status: 'let', acquired_date: '2025-01-01', handed_back_date: today });
  assert.equal(db.prepare('SELECT status FROM properties WHERE id = ?').get(Number(back)).status, 'handed back');
  const page = (await c.get('/app')).text;
  const n = (label) => Number(page.match(new RegExp(`<span class="po-n">(\\d+)</span><span class="po-label">${label}`))[1]);
  assert.equal(n('Empty – needs maintenance'), 1);
  assert.equal(n('Empty – ready to rent'), 1);
  assert.equal(n('Booked'), 1);
  assert.equal(n('New acquisitions'), 3, 'the three added today (not the one acquired in 2025)');
  assert.equal(n('Handed back'), 1);
  assert.match(page, /1 Fixer Road<\/a> <span class="muted small">· 1 open job/);
  assert.ok(month);
});
