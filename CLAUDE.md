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
- No front-end build except the dashboard's React pieces (dark mode switch, MicroSlats animated
  background): source in `client/`, bundled to `public/dashboard.js` with `npm run build:client`
  (the bundle is committed; rebuild after changing `client/`).
- Installable app (PWA): `public/manifest.webmanifest` and the worker `public/sw.js` (served at `/sw.js`).
  The worker must never cache pages or data (they hold personal details); it only shows an offline page.
- Libraries: `pdf-lib` (Metro form, invoices), `exceljs` (reports), `jszip` (filling the
  spreadsheet templates in `assets/`), `nodemailer`/Resend for email.

## Conventions

- Multi-company: `req.user.id` is the company (every record has `account_id`);
  `req.user.person_id` is the person signed in. Scope every query by `account_id`.
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
