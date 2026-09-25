'use strict';

// Usage: npm run create-admin -- <username> <password> [name]
// Creates the admin account, or resets its password if it already exists.
// Set ADMIN_USERNAME to the same username, because on start-up only that account keeps
// admin rights.

const { openDatabase } = require('../src/db');
const { loadConfig } = require('../src/server');
const { hashPassword } = require('../src/auth');

const [rawUsername, password, rawName] = process.argv.slice(2);
if (!rawUsername || !password) {
  console.error('Usage: npm run create-admin -- <username> <password>');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters (10+ recommended).');
  process.exit(1);
}

const config = loadConfig();
const db = openDatabase(config.dbFile);
const username = rawUsername.trim();
const loginName = (rawName || config.adminLoginName).trim();
const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND company_id IS NULL').get(username);
if (existing) {
  db.prepare("UPDATE users SET username = ?, login_name = ?, password_hash = ?, status = 'active' WHERE id = ?").run(username, loginName, hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Password reset for ${username}.`);
} else {
  db.prepare("INSERT INTO users (username, login_name, name, agency_name, password_hash) VALUES (?, ?, 'Administrator', ?, ?)")
    .run(username, loginName, config.appName, hashPassword(password));
  console.log(`Created admin account: username ${username}, name ${loginName}.`);
}
if (config.adminUsername !== username) {
  console.log(`Now set ADMIN_USERNAME=${username} and restart the server to give this account the admin panel.`);
}
