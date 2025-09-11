// src/db.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ethers } from 'ethers';

let db: Database.Database;

export function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

function tryExec(sql: string) {
  try { db.exec(sql); } catch { /* ignore if already applied / old sqlite */ }
}

export async function initDb() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(path.join(dataDir, 'pulsebot.sqlite'));
  db.pragma('journal_mode = wal');

  // Core schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      active_wallet_id INTEGER DEFAULT NULL,
      token_address TEXT DEFAULT NULL,

      -- legacy
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

    -- Executed trades (for avg entry / PnL)
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
      pls_in_wei TEXT NOT NULL,
      token_out_wei TEXT NOT NULL,
      route TEXT,
      created_at INTEGER
    );

    -- Limit orders
    CREATE TABLE IF NOT EXISTS limit_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      wallet_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
      amount_pls_wei TEXT DEFAULT NULL,
      sell_pct REAL DEFAULT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('PLS','USD','MCAP','MULT')),
      trigger_value REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','FILLED','CANCELLED','ERROR')),
      last_error TEXT DEFAULT NULL,
      tx_hash TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Referrals (each user can have at most one referrer)
    CREATE TABLE IF NOT EXISTS referrals (
      telegram_id INTEGER PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

    -- Referral payout destination (1:1 user -> payout wallet)
    CREATE TABLE IF NOT EXISTS referral_payouts (
      telegram_id INTEGER PRIMARY KEY,
      payout_address TEXT NOT NULL
    );
  ");

  // ---------- Best-effort migrations (covers existing DBs) ----------
  tryExec(`ALTER TABLE users ADD COLUMN gwei_boost_gwei REAL DEFAULT 0.0;`);
  tryExec(`ALTER TABLE users ADD COLUMN gas_pct REAL DEFAULT 0.0;`);
  tryExec(`ALTER TABLE users ADD COLUMN default_gas_pct REAL DEFAULT 0.0;`);
  tryExec(`ALTER TABLE users ADD COLUMN buy_amount_pls REAL DEFAULT 0.01;`);
  tryExec(`ALTER TABLE users ADD COLUMN sell_pct REAL DEFAULT 100.0;`);
  tryExec(`ALTER TABLE users ADD COLUMN auto_buy_enabled INTEGER DEFAULT 0;`);
  tryExec(`ALTER TABLE users ADD COLUMN auto_buy_amount_pls REAL DEFAULT 0.01;`);

  tryExec(`ALTER TABLE trades ADD COLUMN route TEXT;`);
  tryExec(`ALTER TABLE trades ADD COLUMN created_at INTEGER;`);
  tryExec(`UPDATE trades SET created_at = COALESCE(created_at, strftime('%s','now')) WHERE created_at IS NULL;`);
}

/* ====================== TYPES ====================== */

export type Side = 'BUY' | 'SELL';
export type Trigger = 'PLS' | 'USD' | 'MCAP' | 'MULT';
export type LimitStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'ERROR';

export interface TradeRow {
  side: Side;
  pls_in_wei: string;
  token_out_wei: string;
}

export interface LimitOrderRow {
  id: number;
  telegram_id: number;
  wallet_id: number;
  token_address: string;
  side: Side;
  amount_pls_wei: string | null;
  sell_pct: number | null;
  trigger_type: Trigger;
  trigger_value: number;
  status: LimitStatus;
  last_error: string | null;
  tx_hash: string | null;
  created_at: number;
  updated_at: number;
}

/* ================ trades / avg entry ================= */

export function recordTrade(
  telegramId: number,
  walletAddress: string,
  tokenAddress: string,
  side: Side,
  plsInWei: bigint,
  tokenOutWei: bigint,
  route?: string
) {
  getDb().prepare(`
    INSERT INTO trades (telegram_id, wallet_address, token_address, side, pls_in_wei, token_out_wei, route, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(
    telegramId,
    walletAddress,
    tokenAddress.toLowerCase(),
    side,
    plsInWei.toString(),
    tokenOutWei.toString(),
    route ?? null
  );
}

/** Average entry (PLS/token).
 * BUY adds position; SELL reduces it proportionally.
 * Note: token_out_wei are in token's base units (decimals). We assume 18 if unknown in callers.
 */
export function getAvgEntry(
  telegramId: number,
  tokenAddress: string,
  tokenDecimals = 18
): { avgPlsPerToken: number, totalPlsIn: bigint, netTokens: bigint } | null {
  const rows = getDb().prepare(`
    SELECT side, pls_in_wei, token_out_wei
    FROM trades
    WHERE telegram_id = ? AND token_address = ?
    ORDER BY id ASC
  `).all(telegramId, tokenAddress.toLowerCase()) as any as TradeRow[];

  let totalPlsIn = 0n;
  let netTokens = 0n;

  for (const r of rows) {
    const pls = BigInt(r.pls_in_wei);
    const tok = BigInt(r.token_out_wei);
    if (r.side === 'BUY') {
      totalPlsIn += pls;
      netTokens += tok;
    } else {
      if (netTokens > 0n) {
        const reduce = tok > netTokens ? netTokens : tok;
        const plsReduce = (totalPlsIn * reduce) / netTokens;
        totalPlsIn -= plsReduce;
        netTokens -= reduce;
      }
    }
  }

  if (netTokens <= 0n) return null;

  const pls = Number(ethers.formatEther(totalPlsIn));
  const toks = Number(ethers.formatUnits(netTokens, tokenDecimals));
  const avg = toks > 0 ? pls / toks : 0;
  return { avgPlsPerToken: avg, totalPlsIn, netTokens };
}

export function getPosition(telegramId: number, tokenAddress: string): bigint {
  const rows = getDb().prepare(`
    SELECT side, token_out_wei FROM trades
    WHERE telegram_id = ? AND token_address = ?
  `).all(telegramId, tokenAddress.toLowerCase()) as any as TradeRow[];

  let net = 0n;
  for (const r of rows) {
    const tok = BigInt(r.token_out_wei);
    net += (r.side === 'BUY') ? tok : -tok;
  }
  return net;
}

/* =================== limit orders =================== */

export function addLimitOrder(o: {
  telegramId: number,
  walletId: number,
  token: string,
  side: Side,
  amountPlsWei?: bigint,
  sellPct?: number,
  trigger: Trigger,
  value: number
}) {
  const info = getDb().prepare(`
    INSERT INTO limit_orders
    (telegram_id, wallet_id, token_address, side, amount_pls_wei, sell_pct, trigger_type, trigger_value, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', strftime('%s','now'), strftime('%s','now'))
  `).run(
    o.telegramId,
    o.walletId,
    o.token.toLowerCase(),
    o.side,
    o.amountPlsWei ? o.amountPlsWei.toString() : null,
    o.sellPct ?? null,
    o.trigger,
    o.value
  );
  return Number(info.lastInsertRowid);
}

export function listLimitOrders(telegramId: number) {
  return getDb()
    .prepare(`SELECT * FROM limit_orders WHERE telegram_id = ? ORDER BY id DESC`)
    .all(telegramId) as any as LimitOrderRow[];
}

export function getOpenLimitOrders() {
  return getDb()
    .prepare(`SELECT * FROM limit_orders WHERE status = 'OPEN'`)
    .all() as any as LimitOrderRow[];
}

export function cancelLimitOrder(telegramId: number, id: number) {
  return getDb().prepare(`
    UPDATE limit_orders
    SET status = 'CANCELLED', updated_at = strftime('%s','now')
    WHERE id = ? AND telegram_id = ? AND status = 'OPEN'
  `).run(id, telegramId).changes;
}

export function markLimitFilled(id: number, txHash?: string | null) {
  return getDb().prepare(`
    UPDATE limit_orders
    SET status = 'FILLED', tx_hash = ?, updated_at = strftime('%s','now')
    WHERE id = ? AND status = 'OPEN'
  `).run(txHash ?? null, id).changes;
}

export function markLimitError(id: number, err: string) {
  return getDb().prepare(`
    UPDATE limit_orders
    SET status = 'ERROR', last_error = ?, updated_at = strftime('%s','now')
    WHERE id = ? AND status = 'OPEN'
  `).run(err.slice(0, 500), id).changes;
}

/* ==================== referrals ===================== */

/**
 * One-time assignment of a referrer for a user.
 * - Ignores if telegramId == referrerId (no self-referrals)
 * - Ignores if the user already has a referrer (PRIMARY KEY constraint + OR IGNORE)
 * Returns true if a row was inserted, false otherwise.
 */
export function setReferrerOnce(telegramId: number, referrerId: number): boolean {
  if (!Number.isFinite(telegramId) || !Number.isFinite(referrerId)) return false;
  if (telegramId === referrerId) return false;

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO referrals (telegram_id, referrer_id, created_at)
    VALUES (?, ?, strftime('%s','now'))
  `);
  const res = stmt.run(telegramId, referrerId);
  return res.changes > 0;
}

// (Optional) Helpers you may want later:
export function getReferrerOf(telegramId: number): number | null {
  const row = getDb().prepare(`SELECT referrer_id FROM referrals WHERE telegram_id = ?`).get(telegramId) as any;
  return row?.referrer_id ?? null;
}
export function countReferrals(referrerId: number): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = ?`).get(referrerId) as any;
  return Number(row?.c ?? 0);
}

/* ============== referral payout wallet ============== */

export function getReferralPayout(telegramId: number): string | null {
  const row = getDb()
    .prepare(`SELECT payout_address FROM referral_payouts WHERE telegram_id = ?`)
    .get(telegramId) as any;
  return row?.payout_address ?? null;
}

export function setReferralPayout(telegramId: number, addr: string): boolean {
  const clean = String(addr).toLowerCase();
  const res = getDb().prepare(`
    INSERT INTO referral_payouts (telegram_id, payout_address)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET payout_address = excluded.payout_address
  `).run(telegramId, clean);
  return res.changes > 0;
}
