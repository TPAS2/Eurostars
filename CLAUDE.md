# Rift — notes for Claude

Rift is a lettings management web app for UK letting agents (landlords, properties, tenants,
councils, maintenance, invoices, the monthly rent run). It's used for real at a letting agency
and holds real people's personal and bank details. It's deployed on Render from the branch
`claude/hopeful-ramanujan-jdgrpx` (see `render.yaml`).

## Data safety (most important)

- Never commit passwords, API keys or any real credential. The owner has shared real passwords
  in chat before: never write them into files, commits, tests or examples. Before every
  commit, check the staged diff for anything that looks like a password or key.
- Never commit real personal data. Spreadsheets and documents the owner uploads contain real
  landlords, tenants, addresses, bank details and staff names. Copy only their headings and
  layout. Use made-up names and figures in tests, screenshots and samples.
- When a real file is used as a template (see `assets/*.tpl`), strip every row of data, links,
  author/printer metadata and sharing paths, and keep the test that checks nothing is left.
- Don't show real data from uploads back in chat beyond what's needed; blur it in any image.
- No viewable or reversible passwords. Passwords are scrypt hashes only.
- Secrets (Resend key, admin password, backup password) belong in Render's environment
  settings, never in the repo or in chat.
- Be wary of third-party tools and plugins that send data elsewhere; check before installing.

## Stack

- Node 22, Express 4, EJS views, SQLite through `node:sqlite` (`DatabaseSync`).
- No front-end build except the dashboard's React piece (the GhostFibers animated
  background): source in `client/`, bundled to `public/dashboard.js` with `npm run build:client`
  (the bundle is committed; rebuild after changing `client/`).
- Installable app (PWA): `public/manifest.webmanifest` and the worker `public/sw.js` (served at `/sw.js`).
  The worker must never cache pages or data (they hold personal details); it only shows an offline page.
- Legal: proprietary `LICENSE`; public `/privacy` and `/terms` (details come from LEGAL_NAME, LEGAL_ADDRESS,
  PRIVACY_EMAIL, ICO_NUMBER in Render). After changing dependencies run `npm run notices` to refresh
  `public/third-party-notices.txt`. If a new feature sends personal data to another service, update the privacy notice.
- Libraries: `pdf-lib` (Metro form, invoices), `exceljs` (reports), `jszip` (filling the
  spreadsheet templates in `assets/`), `nodemailer`/Resend for email.

## Conventions

- Multi-company: `req.user.id` is the agency (every record has `account_id`);
  `req.user.person_id` is the person signed in. Scope every query by `account_id`.
- An agency is its own `users` row (`company_id IS NULL`, `is_agency = 1`): names, contact
  details, status. It never signs in. Everyone who signs in is a user under it (`company_id` =
  the agency), all equal. Create agencies with `createAgency` in `src/db.js`. The admin account
  is the one exception: a single row that signs in as itself.
- Schema changes: add to `SCHEMA` or use `addColumnIfMissing` in `src/db.js` (no migrations
  framework). Generic list/show/edit pages come from `src/entities.js`.
- Security middleware must stay on: CSRF on every POST (multipart routes call
  `auth.checkCsrfAfterUpload`), strict CSP (`script-src 'self'`, no inline scripts or
  `style=` attributes; use classes), per-company scoping, sandboxed file downloads.
- Autosaving forms use `data-autosave`; the server answers `X-Autosave` requests with JSON.
- Money is stored in pence (integers). Dates are ISO `YYYY-MM-DD`; show UK format (`dd/mm/yyyy`).
- Write for the owner: plain British English, no jargon, in the UI and in replies.

## Rent run steps (keep this numbering)

1 Calculate rents · 2 Email landlords · 3 Rift report (Excel; was called the CFP report) ·
3.1 Email the report · 4 Bank transfer sheet (.xlsx) · 5 Metro bulk payment file (.xlsm, keeps
Metro's CREATE TXT FILE macro) · 5.1 Metro Bank Bulk Payment Instruction (the PDF form:
capitals, pen-blue writing, date under signature 1 only, no Store box, signatures left blank).
Steps 4, 5 and 5.1 all come from the Rift report (`src/bulkPayment.js`), so their totals agree.

## Working here

- `npm test` runs everything (`test/app.test.js`); keep it passing and add a test for each change.
- Check UI changes in a real browser (Playwright is available) before saying they're done.
- Commit and push to `claude/hopeful-ramanujan-jdgrpx` only. Don't open pull requests unless asked.
- No model names in commits or code.

## Owner's to-do (remind them when email comes up)

- Upgrade the Resend plan: the free plan stops at 100 emails a day / 3,000 a month, too few for
  emailing every landlord their statement in one go.
- Buy a website domain for Rift (e.g. rift-something.co.uk) and add it in Render (the service's
  Settings → Custom Domains, then the DNS records Render shows; HTTPS is automatic). Rift needs no
  change: it has no fixed web address in its settings.
- Verify that same domain in Resend too (its DNS records), so emails can come from any address on
  it; then set EMAIL_FROM in Render to an address on it.
