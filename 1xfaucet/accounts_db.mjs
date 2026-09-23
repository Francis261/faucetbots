import Database from 'better-sqlite3';
import { join } from 'node:path';

const DB_PATH = join(process.env.HOME, 'adbch', '1xfaucet', 'accounts.db');

let _db = null;

export function getDB() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        last_claim_at TEXT,
        next_available_at TEXT,
        total_claims INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }
  return _db;
}

export function addAccount(email, password) {
  const db = getDB();
  const stmt = db.prepare('INSERT OR IGNORE INTO accounts (email, password) VALUES (?, ?)');
  const result = stmt.run(email, password);
  return result.changes > 0;
}

export function removeAccount(email) {
  const db = getDB();
  return db.prepare('DELETE FROM accounts WHERE email = ?').run(email).changes > 0;
}

export function listAccounts() {
  return getDB().prepare('SELECT id, email, status, last_claim_at, next_available_at, total_claims FROM accounts ORDER BY id').all();
}

export function getAvailableAccount() {
  const now = new Date().toISOString();
  return getDB().prepare(`
    SELECT * FROM accounts
    WHERE status IN ('active', 'error')
    AND (next_available_at IS NULL OR next_available_at <= ?)
    ORDER BY next_available_at ASC NULLS FIRST, id ASC
    LIMIT 1
  `).get(now);
}

export function markClaimed(email) {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  getDB().prepare(`
    UPDATE accounts SET status='cooldown', last_claim_at=?, next_available_at=?, total_claims=total_claims+1, updated_at=? WHERE email=?
  `).run(now, next, now, email);
}

export function markCooldown(email, minutes) {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  getDB().prepare(`
    UPDATE accounts SET status='cooldown', next_available_at=?, updated_at=? WHERE email=?
  `).run(next, now, email);
}

export function markError(email) {
  const now = new Date().toISOString();
  const retry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  getDB().prepare(`
    UPDATE accounts SET status='error', next_available_at=?, updated_at=? WHERE email=?
  `).run(retry, now, email);
}

export function markActive(email) {
  const now = new Date().toISOString();
  getDB().prepare(`
    UPDATE accounts SET status='active', next_available_at=NULL, updated_at=? WHERE email=?
  `).run(now, email);
}

export function getNextRetryTime() {
  const now = new Date().toISOString();
  const row = getDB().prepare(`
    SELECT MIN(next_available_at) as next_retry FROM accounts
    WHERE status IN ('cooldown','error') AND next_available_at > ?
  `).get(now);
  return row?.next_retry || null;
}

export function getAccountStats() {
  const db = getDB();
  return {
    total: db.prepare('SELECT COUNT(*) as c FROM accounts').get().c,
    active: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE status='active'").get().c,
    cooldown: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE status='cooldown'").get().c,
    errors: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE status='error'").get().c,
    totalClaims: db.prepare('SELECT COALESCE(SUM(total_claims),0) as c FROM accounts').get().c,
  };
}

export function resetAll() {
  getDB().prepare("UPDATE accounts SET status='active', next_available_at=NULL").run();
}
