import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database;

export function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

export async function initDb() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(path.join(dataDir, 'pulsebot.sqlite'));
  db.pragma('journal_mode = wal');

  // Base schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      active_wallet_id INTEGER DEFAULT NULL,
      token_address TEXT DEFAULT NULL,
      base_pair TEXT DEFAULT 'WPLS',
      max_priority_fee_gwei REAL DEFAULT 0.1,
      max_fee_gwei REAL DEFAULT 0.2,
      gas_limit INTEGER DEFAULT 250000
      -- buy_amount_pls will be added via migration below
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      enc_privkey BLOB NOT NULL
    );
  `);

  // ---- Lightweight migrations ----
  // Add per-user default buy amount (PLS) if it doesn't exist.
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  const hasBuyAmt = cols.some(c => c.name === 'buy_amount_pls');
  if (!hasBuyAmt) {
    db.prepare(`ALTER TABLE users ADD COLUMN buy_amount_pls REAL DEFAULT 0.01`).run();
    db.prepare(`UPDATE users SET buy_amount_pls = 0.01 WHERE buy_amount_pls IS NULL`).run();
  }
}
