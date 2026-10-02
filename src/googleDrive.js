'use strict';

// Sends each backup to the owner's own Google Drive, as an extra safe copy off the server.
//
// - Only ENCRYPTED backups are ever sent (BACKUP_PASSWORD must be set), so Google only holds
//   scrambled files nobody can open without that password.
// - It uses the narrow "drive.file" permission: Rift can only see the folder and files it made
//   itself, never anything else in the Drive.
// - Credentials come from Render's settings (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   GOOGLE_REFRESH_TOKEN). Get the refresh token once with `npm run google-drive-auth`.
// - A failure here never stops the backup itself: it is recorded and shown on the Backups page.

const fs = require('node:fs');
const { Readable } = require('node:stream');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const enabled = (config) => {
  const g = config.googleDrive || {};
  return !!(g.clientId && g.clientSecret && g.refreshToken);
};

async function accessToken(g, f) {
  const r = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(j.error === 'invalid_grant'
      ? 'Google no longer accepts the saved sign-in. Run the Google Drive set-up again to get a new GOOGLE_REFRESH_TOKEN.'
      : (j.error_description || j.error || `Google refused the sign-in (${r.status}).`));
  }
  return j.access_token;
}

async function call(f, token, url, opts = {}) {
  const r = await f(url, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!r.ok) {
    let message = '';
    try { message = (await r.json()).error.message; } catch { /* no details */ }
    throw new Error(message || `Google Drive error (${r.status}).`);
  }
  return r;
}

async function folderId(f, token, name) {
  const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await (await call(f, token, `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)).json();
  if (found.files && found.files[0]) return found.files[0].id;
  const made = await (await call(f, token, `${API}/files?fields=id`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return made.id;
}

// Streams the file up, so a large backup never has to sit in memory.
async function upload(f, token, parent, file, name) {
  const size = fs.statSync(file).size;
  const start = await call(f, token, `${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(size) },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const where = start.headers.get('location');
  if (!where) throw new Error('Google Drive did not start the upload.');
  const put = await f(where, {
    method: 'PUT', headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
    body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half',
  });
  if (!put.ok) throw new Error(`Google Drive upload failed (${put.status}).`);
  return (await put.json()).id;
}

// Keeps the newest `keep` backups in the folder and deletes older ones.
async function prune(f, token, parent, keep) {
  const q = `'${parent}' in parents and trashed=false`;
  const list = await (await call(f, token, `${API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&pageSize=1000&fields=files(id,name)`)).json();
  const old = (list.files || []).filter((x) => /^rift-backup-/.test(x.name)).slice(keep);
  for (const x of old) await call(f, token, `${API}/files/${x.id}`, { method: 'DELETE' });
  return old.length;
}

// Copies one backup to Drive. Resolves { ok: true, ... } or { ok: false, error }; never throws.
async function uploadBackup(config, file, name) {
  const g = config.googleDrive || {};
  const f = config.googleFetch || fetch;
  try {
    if (!enabled(config)) return { ok: false, skipped: true, error: 'Google Drive is not set up.' };
    if (!name.endsWith('.enc')) throw new Error('Not sent: backups must be encrypted first. Set BACKUP_PASSWORD in Render.');
    const token = await accessToken(g, f);
    const parent = await folderId(f, token, g.folderName || 'Rift backups');
    await upload(f, token, parent, file, name);
    let removed = 0;
    try { removed = await prune(f, token, parent, config.backupKeep || 14); } catch (err) { console.error('Tidying old Google Drive backups failed:', err.message); }
    return { ok: true, name, removed };
  } catch (err) {
    console.error('Backup copy to Google Drive failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { enabled, uploadBackup };
