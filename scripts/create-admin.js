'use strict';

// Usage: npm run create-admin -- you@example.com "a-long-password"
// Creates the admin account (or resets its password). Remember to set ADMIN_EMAIL to the
// same address, because on start-up only that account keeps admin rights.

const { openDatabase } = require('../src/db');
const { loadConfig } = require('../src/server');
const { hashPassword } = require('../src/auth');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run create-admin -- <email> <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const config = loadConfig();
const db = openDatabase(config.dbFile);
const normalized = email.trim().toLowerCase();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?").run(hashPassword(password), existing.id);
  console.log(`Password reset for ${normalized}.`);
} else {
  db.prepare("INSERT INTO users (email, name, agency_name, password_hash) VALUES (?, 'Administrator', ?, ?)")
    .run(normalized, config.appName, hashPassword(password));
  console.log(`Created ${normalized}.`);
}
if (config.adminEmail !== normalized) {
  console.log(`Now set ADMIN_EMAIL=${normalized} and restart the server to give this account the admin panel.`);
}
