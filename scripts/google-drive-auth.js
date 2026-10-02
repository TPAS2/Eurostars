'use strict';

// One-time set-up: lets Rift save backups to YOUR Google Drive. Run it on your own computer:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-drive-auth
// It prints a short code; you enter it at google.com/device, approve, and it prints the
// GOOGLE_REFRESH_TOKEN to paste into Render's environment settings. Nothing is written to disk.
// The client must be created as an OAuth client of type "TVs and Limited Input devices".

const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // only files Rift itself creates
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see the Google Drive set-up steps).');
  process.exit(1);
}
const post = async (url, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};

(async () => {
  const dev = await post('https://oauth2.googleapis.com/device/code', { client_id: clientId, scope: SCOPE });
  if (!dev.ok) { console.error('Google refused the request:', dev.body.error_description || dev.body.error); process.exit(1); }
  console.log(`\n1. Open ${dev.body.verification_url}\n2. Enter this code: ${dev.body.user_code}\n3. Choose your Google account and allow access.\n\nWaiting for you to approve…`);
  let wait = (dev.body.interval || 5) * 1000;
  const until = Date.now() + (dev.body.expires_in || 600) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    const t = await post('https://oauth2.googleapis.com/token', {
      client_id: clientId, client_secret: clientSecret, device_code: dev.body.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.ok && t.body.refresh_token) {
      console.log('\nDone. Add this in Render → Environment (keep it secret, never share it):\n\nGOOGLE_REFRESH_TOKEN=' + t.body.refresh_token + '\n');
      return;
    }
    if (t.body.error === 'slow_down') wait += 5000;
    else if (t.body.error && t.body.error !== 'authorization_pending') { console.error('Stopped:', t.body.error_description || t.body.error); process.exit(1); }
  }
  console.error('The code expired. Run it again.');
  process.exit(1);
})();
