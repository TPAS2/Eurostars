'use strict';

// Usage: npm run backup  (makes a backup immediately, e.g. from cron or before an upgrade)

const { openDatabase } = require('../src/db');
const { loadConfig } = require('../src/server');
const { createBackup } = require('../src/backup');

const config = loadConfig();
const db = openDatabase(config.dbFile);
createBackup(db, config, { reason: 'command line' })
  .then((b) => console.log(`Backup written: ${b.file} (${Math.round(b.size / 1024)} KB)`))
  .catch((err) => { console.error('Backup failed:', err); process.exitCode = 1; });
