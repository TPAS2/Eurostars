'use strict';

// Full backups: a consistent snapshot of the database plus every uploaded invoice file,
// written as a single .tar.gz that the standard `tar` tool (or scripts/restore-backup.js) can open.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const NAME_RE = /^(?:nexus|letwise)-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.tar\.gz(\.enc)?$/;

// ---- encryption: AES-256-GCM with a key made from BACKUP_PASSWORD (scrypt) ----
// File layout: "NEXUSENC1" | salt (16) | iv (12) | encrypted .tar.gz | auth tag (16)
const MAGIC = Buffer.from('NEXUSENC1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function backupKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, SCRYPT);
}

async function encryptFile(src, dest, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', backupKey(password, salt), iv);
  const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

function isEncrypted(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally { fs.closeSync(fd); }
}

// Decrypts to dest. Throws "Wrong backup password" if the password (or file) is wrong.
async function decryptFile(src, dest, password) {
  const size = fs.statSync(src).size;
  const headerLen = MAGIC.length + 16 + 12;
  const fd = fs.openSync(src, 'r');
  const header = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, headerLen, 0);
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally { fs.closeSync(fd); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an encrypted Nexus backup.');
  const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = header.subarray(MAGIC.length + 16, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const tmp = `${dest}.partial`;
  try {
    await pipeline(fs.createReadStream(src, { start: headerLen, end: size - 17 }), decipher, fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (/authenticate/i.test(err.message)) throw new Error('Wrong backup password (or the file is damaged).');
    throw err;
  }
}

// ---- minimal ustar writer ----

function tarHeader(name, size, mtime, type = '0') {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(type === '5' ? 0o755 : 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

async function writeTarGz(outFile, entries) {
  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(outFile, { flags: 'wx', mode: 0o600 });
  gzip.pipe(out);
  const write = async (buf) => { if (!gzip.write(buf)) await once(gzip, 'drain'); };
  for (const e of entries) {
    const data = e.data ?? fs.readFileSync(e.file);
    await write(tarHeader(e.name, data.length, e.mtime ?? Date.now()));
    await write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024)); // end-of-archive
  gzip.end();
  await once(out, 'close');
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else if (ent.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

// Create a backup and prune old ones. Returns { name, file, size }.
async function createBackup(db, config, { reason = 'manual' } = {}) {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  // With BACKUP_PASSWORD set, backups are encrypted and end in .tar.gz.enc.
  const ext = config.backupPassword ? '.tar.gz.enc' : '.tar.gz';
  let name = `nexus-backup-${stamp()}${ext}`;
  for (let i = 1; fs.existsSync(path.join(config.backupDir, name)); i++) name = `nexus-backup-${stamp()}-${i}${ext}`;
  const file = path.join(config.backupDir, name);
  const plainFile = config.backupPassword ? path.join(config.backupDir, `.plain-${process.pid}-${Date.now()}.tar.gz`) : file;

  // VACUUM INTO produces a consistent copy even while the app is serving requests.
  const tmpDb = path.join(config.backupDir, `.snapshot-${process.pid}-${Date.now()}.db`);
  db.prepare('VACUUM INTO ?').run(tmpDb);
  try {
    const n = (sql) => db.prepare(sql).get().n;
    const manifest = {
      app: config.appName,
      created_at: new Date().toISOString(),
      reason,
      counts: {
        users: n('SELECT COUNT(*) n FROM users'),
        landlords: n('SELECT COUNT(*) n FROM landlords'),
        properties: n('SELECT COUNT(*) n FROM properties'),
        tenants: n('SELECT COUNT(*) n FROM tenants'),
        tenancies: n('SELECT COUNT(*) n FROM tenancies'),
        transactions: n('SELECT COUNT(*) n FROM transactions'),
        invoices: n('SELECT COUNT(*) n FROM invoices'),
        monthly_statements: n('SELECT COUNT(*) n FROM monthly_statements'),
      },
    };
    const uploads = walk(config.uploadDir);
    manifest.counts.uploaded_files = uploads.length;
    manifest.encrypted = !!config.backupPassword;
    await writeTarGz(plainFile, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'nexus.db', file: tmpDb },
      ...uploads.map((u) => ({ name: `uploads/${u.rel}`, file: u.full, mtime: fs.statSync(u.full).mtimeMs })),
    ]);
    if (config.backupPassword) await encryptFile(plainFile, file, config.backupPassword);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  } finally {
    fs.rmSync(tmpDb, { force: true });
    if (plainFile !== file) fs.rmSync(plainFile, { force: true });
  }

  // Optional second copy, e.g. a mounted network drive or a cloud-synced folder.
  if (config.backupCopyDir) {
    try {
      fs.mkdirSync(config.backupCopyDir, { recursive: true });
      fs.copyFileSync(file, path.join(config.backupCopyDir, name));
      pruneDir(config.backupCopyDir, config.backupKeep);
    } catch (err) {
      console.error(`Backup copy to ${config.backupCopyDir} failed:`, err.message);
    }
  }
  pruneDir(config.backupDir, config.backupKeep);
  return { name, file, size: fs.statSync(file).size };
}

function pruneDir(dir, keep) {
  const names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort().reverse();
  for (const old of names.slice(keep)) fs.rmSync(path.join(dir, old), { force: true });
}

function listBackups(config) {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs.readdirSync(config.backupDir)
    .filter((n) => NAME_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(config.backupDir, name));
      return { name, size: st.size, created: st.mtime };
    })
    .sort((a, b) => b.created - a.created);
}

function backupPath(config, name) {
  if (!NAME_RE.test(String(name))) return null;
  const file = path.join(config.backupDir, name);
  return fs.existsSync(file) ? file : null;
}

// Back up on a timer; skips a run if a recent enough backup already exists.
function scheduleBackups(db, config, log = console.log) {
  const everyMs = config.backupIntervalHours * 3600 * 1000;
  const tick = async () => {
    const latest = listBackups(config)[0];
    if (latest && Date.now() - latest.created.getTime() < everyMs * 0.9) return;
    try {
      const b = await createBackup(db, config, { reason: 'scheduled' });
      log(`Backup written: ${b.name} (${Math.round(b.size / 1024)} KB)`);
    } catch (err) {
      console.error('Scheduled backup failed:', err);
    }
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, Math.min(everyMs, 3600 * 1000)).unref();
}

module.exports = { createBackup, listBackups, backupPath, scheduleBackups, writeTarGz, encryptFile, decryptFile, isEncrypted };
