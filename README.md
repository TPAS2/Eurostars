# LetWise

Lettings, property management and client-accounting software for UK letting agents, similar in scope to CFP WinMan. Each agency that signs up gets its own private workspace. You, the owner, get an admin panel that shows everyone using the software.

## Features

**For agencies**
- **Landlords and properties.** Each landlord's page lists the properties they own, with an "Add property" button that links the new property to that landlord.
- **Tenants and tenancies.** "Add tenant" on any property creates the tenant and the tenancy in one step. It records the booking date, start and end dates, rent, deposit and deposit scheme.
- **Rent.** One click raises the month's rent for every active tenancy. You then record receipts, and arrears show up on the dashboard.
- **Client accounting.**
  - Management fees are deducted automatically when rent is received.
  - You can record expenses and payments to landlords.
  - Each landlord has a running balance and a statement for any date range.
- **Monthly statements.** A statement is produced for every landlord every month, showing rent received minus fees and costs. AI writes a plain-English summary, and each statement prints or saves as a PDF.
- **Maintenance and invoices.**
  - You can log repairs and upload contractor invoices (PDF or photo).
  - Unpaid and overdue invoices are listed.
  - Clicking an invoice lets you pay it. The payment is recorded and charged to the landlord's account.
- **Compliance.** Tracks gas safety, EICR, EPC, licences and similar certificates, with warnings before they expire.
- **Autosave.** Edits save as you type. New forms keep a draft in the browser until you submit them.
- **Data export.** Each agency can download all of its data as JSON.

**For you (admin panel)**
- All users, with sign-up date, last login, number of logins and how much each agency uses the software.
- Sign-in history, including failed logins.
- Suspend, reactivate, sign out everywhere, or delete an account.
- CSV export of all users.
- **Backups:** automatic daily backups, a "Back up now" button, and a download link for each backup.

## Quick start

Requires Node.js 22.13 or later.

```bash
npm install
cp .env.example .env        # then edit ADMIN_EMAIL / ADMIN_PASSWORD
export $(grep -v '^#' .env | xargs)
npm start                   # http://localhost:3000
```

Sign in as `admin` (or your `ADMIN_EMAIL`) with `ADMIN_PASSWORD` to reach the admin panel. Agencies create an account at `/register` with a username and password (email is optional) and can then sign in with either.

To try it with realistic sample data, run `npm run seed-demo`, then sign in as `harbour` / `demo-password-123`.

## How the admin panel stays yours

- Only the account whose email matches `ADMIN_EMAIL` has admin rights. Admin rights are re-checked every time the server starts.
- Nobody can register with that email address or with the admin username (`admin`, or `ADMIN_USERNAME`).
- Anyone else who visits `/admin` gets a "page not found" response.
- The admin panel shows usage counts only. It does not show the contents of an agency's records.

## AI monthly statements

- All figures on a statement are calculated by the app's own accounts: rent, fees, costs, net amount and balance held.
- Claude (`claude-opus-5`) only writes the summary paragraph.
- **Numbers check:** if the summary quotes any £ amount that isn't on the statement, the summary is discarded and a standard one is used instead.
- **Fallback model:** server-side fallbacks (`fallbacks: "default"`) are enabled. If the model declines a request, the API retries it on a recommended fallback model.
- Without `ANTHROPIC_API_KEY`, every statement uses the standard summary.
- Last month's statements are generated automatically after the month ends. You can also generate or regenerate them from **Monthly statements**.

## Backups and restore

Each backup is a single `.tar.gz` file containing:
- a consistent snapshot of the database (taken safely while the app is running)
- every uploaded invoice file

Backups are:
- **Automatic:** every `BACKUP_INTERVAL_HOURS` (default 24). The newest `BACKUP_KEEP` (default 14) are kept.
- **On demand:** click **Admin → Backups → Back up now**, or run `npm run backup`.
- **Copied off the server (recommended):** set `BACKUP_COPY_DIR` to a network drive or cloud-synced folder, and/or download backups regularly.

**To restore**, stop the server, then run:

```bash
npm run restore-backup -- data/backups/letwise-backup-2026-09-24T02-00-00Z.tar.gz
```

The current data is moved to `data/pre-restore-…/` first, so a restore never deletes anything. The backup is also a normal tar archive (`tar -xzf file.tar.gz`), so you can open it without this app.

## Online preview (GitHub Pages)

`docs/index.html` is a read-only copy of the app for showing people. It opens on the sign-in page, and each login shows only that company's pages:

| Username | Password | Shows |
|---|---|---|
| `harbour` | `demo-password-123` | Harbour Lettings (sample data) |
| `citylets` | `demo-password-456` | City Lets Bath (sample data) |
| `admin` | `owner-password-123` | The admin panel |

To rebuild it: run the app with demo data (`npm run seed-demo`, then `npm start`), then run `node scripts/build-preview.js http://localhost:3000`. It's static, so the sign-in only keeps casual visitors out; never build it from real data.

## Deploying

- Run behind HTTPS.
- Set `NODE_ENV=production`, which makes session cookies secure.
- Set `TRUST_PROXY=true` if the app runs behind a proxy.
- Keep the `data/` directory on persistent storage. It holds the database, uploads and backups.

## Security notes

- Passwords are hashed with scrypt.
- Sessions use random tokens, stored hashed. Cookies are HttpOnly and SameSite=Lax.
- Every form has CSRF protection, and cross-site POST requests are rejected.
- Login attempts are rate-limited and every sign-in attempt is logged.
- Every query is scoped to the signed-in agency, so one agency can never read or change another's data.
- Uploaded files are checked by their actual content, stored under random names, and served in a sandbox.
- A strict Content Security Policy is applied.

## Development

```bash
npm run dev    # auto-restart on changes
npm test       # end-to-end tests
```

This is a solid starting point, not a finished regulated product. Before charging agencies, get an accountant to review the client-money accounting. Also add password reset emails, two-factor login for the admin account, and a privacy policy and data processing agreement (you will be processing tenants' and landlords' personal data under UK GDPR).
