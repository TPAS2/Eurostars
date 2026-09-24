'use strict';

// Usage (with the server stopped): npm run restore-backup -- path/to/nexus-backup-....tar.gz
// The current database and uploads are moved to data/pre-restore-<time>/ first, never deleted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/server');

const archive = process.argv[2];
if (!archive || !fs.existsSync(archive)) {
  console.error('Usage: npm run restore-backup -- <backup .tar.gz file>');
  process.exit(1);
}

const config = loadConfig();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-'));
try {
  execFileSync('tar', ['-xzf', path.resolve(archive), '-C', work], { stdio: 'inherit' });
  // Backups made before the rename to Nexus call the database letwise.db.
  const restoredDb = ['nexus.db', 'letwise.db'].map((f) => path.join(work, f)).find((f) => fs.existsSync(f));
  if (!restoredDb) throw new Error('This file does not look like a Nexus backup (no database inside).');

  const check = new DatabaseSync(restoredDb, { readOnly: true });
  const ok = check.prepare('PRAGMA integrity_check').get();
  const users = check.prepare('SELECT COUNT(*) n FROM users').get().n;
  check.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('The database in this backup failed its integrity check.');

  const manifestFile = path.join(work, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    console.log(`Backup from ${m.created_at}: ${JSON.stringify(m.counts)}`);
  }

  // Move the current data aside.
  const aside = path.join(path.dirname(config.dbFile), `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(aside, { recursive: true });
  for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) {
    if (fs.existsSync(f)) fs.renameSync(f, path.join(aside, path.basename(f)));
  }
  if (fs.existsSync(config.uploadDir)) fs.renameSync(config.uploadDir, path.join(aside, 'uploads'));

  // Put the backup in place.
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  fs.copyFileSync(restoredDb, config.dbFile);
  const restoredUploads = path.join(work, 'uploads');
  if (fs.existsSync(restoredUploads)) fs.cpSync(restoredUploads, config.uploadDir, { recursive: true });
  else fs.mkdirSync(config.uploadDir, { recursive: true });

  console.log(`Restored ${users} user account(s). Previous data saved in ${aside}.`);
  console.log('Start the server again with: npm start');
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  console.error('Nothing was changed if this happened before the "Restored" message.');
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
