import Database from 'better-sqlite3';
import { join } from 'node:path';

const DB_PATH = join(process.env.HOME, 'adbch', 'shared', 'accounts.db');

let _db = null;

export function getDB() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        url TEXT DEFAULT 'https://claimfreecoins.io/tether-faucet/',
        status TEXT DEFAULT 'active',
        last_claim_at TEXT,
        next_available_at TEXT,
        total_claims INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
      CREATE INDEX IF NOT EXISTS idx_accounts_next_available ON accounts(next_available_at);
    `);
  }
  return _db;
}

export function addAccount(email, url) {
  const db = getDB();
  const stmt = db.prepare('INSERT OR IGNORE INTO accounts (email, url) VALUES (?, ?)');
  const result = stmt.run(email, url || 'https://claimfreecoins.io/tether-faucet/');
  return result.changes > 0;
}

export function removeAccount(email) {
  const db = getDB();
  const stmt = db.prepare('DELETE FROM accounts WHERE email = ?');
  const result = stmt.run(email);
  return result.changes > 0;
}

export function listAccounts() {
  const db = getDB();
  return db.prepare('SELECT * FROM accounts ORDER BY id').all();
}

export function getAvailableAccount() {
  const db = getDB();
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM accounts
    WHERE status IN ('active', 'error')
    AND (next_available_at IS NULL OR next_available_at <= ?)
    ORDER BY next_available_at ASC NULLS FIRST, id ASC
    LIMIT 1
  `).get(now);
}

export function markClaimed(email) {
  const db = getDB();
  const now = new Date().toISOString();
  // Next available = tomorrow at 00:00 UTC (daily claim limit)
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const nextAvailable = tomorrow.toISOString();

  db.prepare(`
    UPDATE accounts
    SET status = 'cooldown',
        last_claim_at = ?,
        next_available_at = ?,
        total_claims = total_claims + 1,
        updated_at = ?
    WHERE email = ?
  `).run(now, nextAvailable, now, email);
}

export function markActive(email) {
  const db = getDB();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE accounts
    SET status = 'active',
        next_available_at = NULL,
        updated_at = ?
    WHERE email = ?
  `).run(now, email);
}

export function markError(email, errorMsg) {
  const db = getDB();
  const now = new Date().toISOString();
  // Retry in 5 minutes on error
  const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE accounts
    SET status = 'error',
        next_available_at = ?,
        updated_at = ?
    WHERE email = ?
  `).run(retryAt, now, email);
}

export function getAccountStats() {
  const db = getDB();
  const total = db.prepare('SELECT COUNT(*) as count FROM accounts').get().count;
  const active = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'active'").get().count;
  const cooldown = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'cooldown'").get().count;
  const errors = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'error'").get().count;
  const totalClaims = db.prepare('SELECT COALESCE(SUM(total_claims), 0) as count FROM accounts').get().count;
  return { total, active, cooldown, errors, totalClaims };
}

export function getNextRetryTime() {
  const db = getDB();
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT MIN(next_available_at) as next_retry
    FROM accounts
    WHERE status IN ('cooldown', 'error')
    AND next_available_at > ?
  `).get(now);
  return row?.next_retry || null;
}

export function resetAllAccounts() {
  const db = getDB();
  db.prepare("UPDATE accounts SET status = 'active', next_available_at = NULL, updated_at = datetime('now')").run();
}
