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
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      active_wallet_id INTEGER DEFAULT NULL,
      token_address TEXT DEFAULT NULL,
      base_pair TEXT DEFAULT 'WPLS',
      max_priority_fee_gwei REAL DEFAULT 0.1,
      max_fee_gwei REAL DEFAULT 0.2,
      gas_limit INTEGER DEFAULT 250000
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      enc_privkey BLOB NOT NULL
    );
  `);
}
