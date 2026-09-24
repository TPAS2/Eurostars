'use strict';

// Builds docs/index.html: a static, read-only copy of the app for GitHub Pages.
// It opens on the sign-in page; each account only sees its own agency's pages.
//
// Usage: start the app with demo data (npm run seed-demo && npm start), then
//   node scripts/build-preview.js [base-url] [output]
// Accounts are taken from PREVIEW_ACCOUNTS as "username:password" pairs separated by commas.
// The sign-in check is only a convenience gate: a static page can't truly protect its
// contents, so only ever build it from sample data.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3] || path.join(__dirname, '..', 'docs', 'index.html');
const ACCOUNTS = (process.env.PREVIEW_ACCOUNTS || 'harbour:demo-password-123,citylets:demo-password-456,admin:owner-password-123')
  .split(',').map((pair) => { const i = pair.indexOf(':'); return { username: pair.slice(0, i), password: pair.slice(i + 1) }; });

const SKIP = /\/file\b|\/export$|\.csv$|\/admin\/backups\/(?:nexus|letwise)-|[?&]download=|[?&]print=|\/new(\?|$)|\/edit$|\/add-tenant$/;
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&#34;/g, '"');
const stripCsrf = (html) => html.replace(/<input type="hidden" name="_csrf" value="[^"]*">/g, '');

async function login(username, password) {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: username, password }).toString(),
  });
  if (r.status !== 302) throw new Error(`Could not sign in as ${username}`);
  return { cookie: r.headers.get('set-cookie').split(';')[0], home: r.headers.get('location') };
}

async function fetchPage(url, cookie) {
  const res = await fetch(BASE + url, { headers: { cookie }, redirect: 'manual' });
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return null;
  return res.text();
}

async function crawl(cookie, start, limit) {
  const pages = {};
  let sidebar = '';
  const queue = [...start];
  const seen = new Set(queue);
  while (queue.length && Object.keys(pages).length < limit) {
    const url = queue.shift();
    const html = await fetchPage(url, cookie);
    if (!html || !html.includes('<main class="content">')) continue;
    const main = html.slice(html.indexOf('<main class="content">') + '<main class="content">'.length, html.lastIndexOf('</main>'));
    pages[url] = { title: decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''), main: stripCsrf(main) };
    if (!sidebar) sidebar = stripCsrf((html.match(/<aside class="sidebar">([\s\S]*?)<\/aside>/) || [])[1] || '');
    for (const m of html.matchAll(/href="(\/(?:app|admin)[^"#]*)"/g)) {
      const u = decode(m[1]);
      if (SKIP.test(u) || seen.has(u)) continue;
      seen.add(u);
      queue.push(u);
    }
  }
  return { pages, sidebar };
}

(async () => {
  const loginHtml = await fetchPage('/login', '');
  const loginMain = loginHtml.slice(loginHtml.indexOf('<main class="public">') + '<main class="public">'.length, loginHtml.lastIndexOf('</main>'))
    .replace(/<p class="muted small">New here\?[\s\S]*?<\/p>/, '');

  const accounts = {};
  for (const { username, password } of ACCOUNTS) {
    const { cookie, home } = await login(username, password);
    const starts = home === '/admin' ? ['/admin', '/admin/backups'] : ['/app', '/app/monthly', '/app/invoices?status=unpaid', '/app/invoices?status=overdue', '/app/invoices?status=paid', '/app/statements'];
    const { pages, sidebar } = await crawl(cookie, starts, 400);
    const salt = crypto.randomBytes(8).toString('hex');
    accounts[username] = {
      salt,
      hash: crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'),
      home, sidebar, pages,
    };
    console.log(`${username}: ${Object.keys(pages).length} pages`);
  }

  // App stylesheet, with dark mode also following an explicit theme choice.
  let css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark) {');
  const rootOpen = css.indexOf(':root {', darkStart);
  const rootClose = css.indexOf('}', rootOpen);
  const darkEnd = css.indexOf('}', rootClose + 1) + 1;
  const tokens = css.slice(rootOpen + ':root {'.length, rootClose);
  css = css.slice(0, darkStart)
    + `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${tokens}} }\n:root[data-theme="dark"] {${tokens}}\n`
    + css.slice(darkEnd);

  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const shell = fs.readFileSync(path.join(__dirname, 'preview-shell.html'), 'utf8');
  const out = shell
    .replace('/*APP_CSS*/', () => css)
    .replace('/*DATA*/', () => `const LOGIN_HTML = ${json(stripCsrf(loginMain))};\nconst ACCOUNTS = ${json(accounts)};`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`Wrote ${OUT} (${Math.round(out.length / 1024)} KB)`);
})().catch((err) => { console.error(err); process.exit(1); });
