import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database;

export function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

function tryAlter(sql: string) {
  try { db.exec(sql); } catch { /* column already exists or older sqlite */ }
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

      -- legacy (kept for compatibility)
      max_priority_fee_gwei REAL DEFAULT 0.1,
      max_fee_gwei REAL DEFAULT 0.2,

      -- current settings
      gas_limit INTEGER DEFAULT 250000,
      gwei_boost_gwei REAL DEFAULT 0.0,     -- absolute gwei added to base market gas
      gas_pct REAL DEFAULT 0.0,             -- current buy menu boost (+/- % over market)
      default_gas_pct REAL DEFAULT 0.0,     -- default boost used when opening buy menu

      buy_amount_pls REAL DEFAULT 0.01,     -- manual buy amount
      sell_pct REAL DEFAULT 100.0,          -- default sell percent in Sell menu

      auto_buy_enabled INTEGER DEFAULT 0,   -- 0/1
      auto_buy_amount_pls REAL DEFAULT 0.01 -- auto-buy amount when pasting token
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      enc_privkey BLOB NOT NULL
    );
  `);

  // best-effort migrations for older DBs
  tryAlter(`ALTER TABLE users ADD COLUMN gwei_boost_gwei REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN gas_pct REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN default_gas_pct REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN buy_amount_pls REAL DEFAULT 0.01;`);
  tryAlter(`ALTER TABLE users ADD COLUMN sell_pct REAL DEFAULT 100.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN auto_buy_enabled INTEGER DEFAULT 0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN auto_buy_amount_pls REAL DEFAULT 0.01;`);
}
