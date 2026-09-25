# Nexus

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
- **Data export.** The admin can download any agency's data as JSON from that company's page in the admin panel.

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

Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` to reach the admin panel. Public sign-up is off: you add each company's login from **Admin panel → Add account**, and can reset anyone's password from their page there. (Set `ALLOW_REGISTRATION=true` to let companies sign themselves up instead.)

Anyone who doesn't use the site for an hour is signed out (change with `IDLE_TIMEOUT_MINUTES`; `0` turns it off). A warning shows five minutes before. Nothing typed is lost: edits are saved first, and anything not yet saved is kept in the browser and put back after signing in again, on the same page.


## Several people at one company

Each company has one username (e.g. `eurostars`). In the admin panel, open the company and use **People → Add a person** to give someone their own sign-in name (e.g. `john`) and password. Everyone signs in with all three boxes filled in, typed exactly (capitals count):
- **Username:** the company's username, e.g. `eurostars`
- **Your name:** their own name, e.g. `john`. A company's main contact uses the sign-in name set when the company was added (their first name unless you chose another); change it under **Account details**.
- **Password:** their own

The admin signs in with `ADMIN_USERNAME` (e.g. `TPAS2`), the name `ADMIN_LOGIN_NAME` (e.g. `Theo`) and `ADMIN_PASSWORD`.

Everyone at the company sees the same data, and the activity log shows who did what. From the People section you can reset a person's password, suspend them or remove them without affecting anyone else. Suspending the company suspends everyone in it.

## Security

- **Two-step login for the admin:** in the admin panel, open **Security → Set up two-step login**, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) and enter the code. After that, signing in as admin needs the 6-digit code from the app as well as the password. Save the 8 recovery codes it shows. Lost the phone and the codes? Set `ADMIN_2FA_RESET=true` in Render, sign in with your password, then remove it.
- **Encrypted backups:** set `BACKUP_PASSWORD` in Render. Backups are then encrypted with AES-256 (`.tar.gz.enc`), and the restore command asks for that password. Keep it somewhere safe.

## Forgotten passwords

Passwords are stored scrambled (hashed), so nobody can look one up, including the admin.
- **A company forgets theirs:** open their page in the admin panel and use **Reset password**.
- **You forget the admin password:** in Render, open the service's **Environment** tab, set `ADMIN_PASSWORD` to a new password and add `ADMIN_PASSWORD_RESET` = `true`, then save (it redeploys). Sign in with the new password, then delete `ADMIN_PASSWORD_RESET`.

## How the admin panel stays yours

- Only the account with username `ADMIN_USERNAME` has admin rights. Admin rights are re-checked every time the server starts.
- Nobody else can take that username, and only the admin can add accounts (unless you turn public sign-up on).
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
npm run restore-backup -- data/backups/nexus-backup-2026-09-24T02-00-00Z.tar.gz.enc
```

The current data is moved to `data/pre-restore-…/` first, so a restore never deletes anything. The backup is also a normal tar archive (`tar -xzf file.tar.gz`), so you can open it without this app.

## Deploying

**Render (easiest).** The repo includes `render.yaml`:
1. Sign in at https://render.com with your GitHub account.
2. Open https://render.com/deploy?repo=https://github.com/TPAS2/Eurostars (or **New → Blueprint** and pick this repo).
3. Fill in `ADMIN_PASSWORD` (and optionally `ADMIN_EMAIL`, and `ANTHROPIC_API_KEY` for AI statement summaries), then click **Apply**. The admin username is `TPAS2` (change `ADMIN_USERNAME` in `render.yaml` to use another).
4. When the deploy finishes, open the `https://nexus-….onrender.com` address it shows. You can add your own domain under **Settings → Custom Domains**.

It uses Render's Starter plan with a 1 GB disk (about $7.25 a month), because the free plan has no permanent disk and would lose the data on every restart.

**Anywhere else:**

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

## Rent run and email

The **Rent run** tab does month end in four steps: calculate all rents (charges each tenancy and works out every landlord's statement), email every landlord their statement, preview/download the CSV statements report, and email the report.

Emails need a sending service. Set `EMAIL_FROM` (e.g. `statements@youragency.co.uk`) and either `RESEND_API_KEY` ([Resend](https://resend.com), after verifying your domain there) or `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` for any SMTP provider. Emails show the agency's name as the sender and replies go to the agency's email address. Until email is set up, the email buttons are disabled and the report can still be downloaded.
