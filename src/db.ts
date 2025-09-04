import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database;

export function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

function tryAlter(sql: string) {
  try { db.exec(sql); } catch { /* ignore if exists */ }
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

      -- legacy (kept)
      max_priority_fee_gwei REAL DEFAULT 0.1,
      max_fee_gwei REAL DEFAULT 0.2,

      -- current settings
      gas_limit INTEGER DEFAULT 250000,
      gwei_boost_gwei REAL DEFAULT 0.0,
      gas_pct REAL DEFAULT 0.0,
      default_gas_pct REAL DEFAULT 0.0,

      buy_amount_pls REAL DEFAULT 0.01,
      sell_pct REAL DEFAULT 100.0,

      auto_buy_enabled INTEGER DEFAULT 0,
      auto_buy_amount_pls REAL DEFAULT 0.01
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      enc_privkey BLOB NOT NULL
    );
  `);

  // -------- Trades tracking (for avg entry / PnL) --------
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL,                        -- 'BUY' | 'SELL'
      pls_in_wei TEXT NOT NULL,                  -- BUY: PLS spent;  SELL: PLS received
      token_out_wei TEXT NOT NULL,               -- BUY: tokens received; SELL: tokens spent
      route_key TEXT DEFAULT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_user_token ON trades (telegram_id, token_address);
    CREATE INDEX IF NOT EXISTS idx_trades_user_time  ON trades (telegram_id, ts);
  `);

  // best-effort migrations
  tryAlter(`ALTER TABLE users ADD COLUMN gwei_boost_gwei REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN gas_pct REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN default_gas_pct REAL DEFAULT 0.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN buy_amount_pls REAL DEFAULT 0.01;`);
  tryAlter(`ALTER TABLE users ADD COLUMN sell_pct REAL DEFAULT 100.0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN auto_buy_enabled INTEGER DEFAULT 0;`);
  tryAlter(`ALTER TABLE users ADD COLUMN auto_buy_amount_pls REAL DEFAULT 0.01;`);
}

/** Record a trade for PnL tracking */
export function recordTrade(
  telegramId: number,
  walletAddress: string,
  tokenAddress: string,
  side: 'BUY' | 'SELL',
  plsInWei: bigint,
  tokenOutWei: bigint,
  routeKey?: string
) {
  const stmt = getDb().prepare(`
    INSERT INTO trades (telegram_id, wallet_address, token_address, side, pls_in_wei, token_out_wei, route_key, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    telegramId,
    walletAddress.toLowerCase(),
    tokenAddress.toLowerCase(),
    side,
    plsInWei.toString(),
    tokenOutWei.toString(),
    routeKey ?? null,
    Math.floor(Date.now() / 1000)
  );
}

/** Average entry based on BUYs only */
export function getAvgEntry(telegramId: number, tokenAddress: string): {
  avgPlsPerToken: number; totalTokens: bigint; totalPlsIn: bigint;
} | null {
  const stmt = getDb().prepare(`
    SELECT pls_in_wei, token_out_wei FROM trades
    WHERE telegram_id = ? AND token_address = ? AND side = 'BUY'
  `);
  const rows = stmt.all(telegramId, tokenAddress.toLowerCase()) as Array<{ pls_in_wei: string; token_out_wei: string }>;
  if (!rows.length) return null;
  let sumPls = 0n, sumTok = 0n;
  for (const r of rows) {
    sumPls += BigInt(r.pls_in_wei);
    sumTok += BigInt(r.token_out_wei);
  }
  if (sumTok === 0n) return null;
  const avg = Number(sumPls) / Number(sumTok); // PLS per token (both wei, ratio is safe)
  return { avgPlsPerToken: avg, totalTokens: sumTok, totalPlsIn: sumPls };
}

/** Position totals: net tokens = buys - sells (in token wei) */
export function getPosition(telegramId: number, tokenAddress: string): {
  totalBuyTokens: bigint; totalSellTokens: bigint; netTokens: bigint;
} {
  const dbi = getDb();
  const buys = dbi.prepare(`
      SELECT COALESCE(SUM(CAST(token_out_wei AS TEXT)), '0') AS s FROM trades
      WHERE telegram_id = ? AND token_address = ? AND side = 'BUY'
    `).get(telegramId, tokenAddress.toLowerCase()) as { s: string };
  const sells = dbi.prepare(`
      SELECT COALESCE(SUM(CAST(token_out_wei AS TEXT)), '0') AS s FROM trades
      WHERE telegram_id = ? AND token_address = ? AND side = 'SELL'
    `).get(telegramId, tokenAddress.toLowerCase()) as { s: string };
  const buySum = BigInt(buys?.s ?? '0');
  const sellSum = BigInt(sells?.s ?? '0');
  return { totalBuyTokens: buySum, totalSellTokens: sellSum, netTokens: buySum - sellSum };
}

/** Optional: list recent trades */
export function listUserTrades(telegramId: number, tokenAddress?: string, limit = 20) {
  const dbi = getDb();
  if (tokenAddress) {
    return dbi.prepare(`
      SELECT * FROM trades WHERE telegram_id = ? AND token_address = ?
      ORDER BY ts DESC LIMIT ?
    `).all(telegramId, tokenAddress.toLowerCase(), limit);
  }
  return dbi.prepare(`
    SELECT * FROM trades WHERE telegram_id = ? ORDER BY ts DESC LIMIT ?
  `).all(telegramId, limit);
}
