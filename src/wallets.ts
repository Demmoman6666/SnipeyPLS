import { ethers } from 'ethers';
import { getDb } from './db.js';
import { encryptPrivateKey, decryptPrivateKey } from './crypto.js';
import { getConfig } from './config.js';

const cfg = getConfig();

export type WalletRow = {
  id: number;
  telegram_id: number;
  name: string;
  address: string;
  enc_privkey: Buffer;
};

type ActiveIdRow = { active_wallet_id: number | null } | undefined;

export function ensureUserRow(telegramId: number) {
  const db = getDb();
  const row = db
    .prepare('SELECT telegram_id FROM users WHERE telegram_id=?')
    .get(telegramId) as { telegram_id: number } | undefined;
  if (!row) db.prepare('INSERT INTO users (telegram_id) VALUES (?)').run(telegramId);
}

export function listWallets(telegramId: number): WalletRow[] {
  const db = getDb();
  return db
    .prepare('SELECT id, telegram_id, name, address, enc_privkey FROM wallets WHERE telegram_id=? ORDER BY id')
    .all(telegramId) as unknown as WalletRow[];
}

export function getWalletById(telegramId: number, walletId: number): WalletRow | null {
  const db = getDb();
  const w = db
    .prepare('SELECT id, telegram_id, name, address, enc_privkey FROM wallets WHERE id=? AND telegram_id=?')
    .get(walletId, telegramId) as WalletRow | undefined;
  return w ?? null;
}

export function createWallet(telegramId: number, name: string) {
  ensureUserRow(telegramId);
  const w = ethers.Wallet.createRandom();
  const enc = encryptPrivateKey(cfg.MASTER_KEY, w.privateKey);

  const db = getDb();
  const res = db
    .prepare('INSERT INTO wallets (telegram_id, name, address, enc_privkey) VALUES (?,?,?,?)')
    .run(telegramId, name, w.address, enc);
  const newId = Number(res.lastInsertRowid);

  const current: ActiveIdRow = db
    .prepare('SELECT active_wallet_id FROM users WHERE telegram_id=?')
    .get(telegramId) as ActiveIdRow;

  if (!current || !current.active_wallet_id) {
    db.prepare('UPDATE users SET active_wallet_id=? WHERE telegram_id=?').run(newId, telegramId);
  }

  return { id: newId, address: w.address };
}

export function importWallet(telegramId: number, name: string, privKey: string) {
  ensureUserRow(telegramId);
  const w = new ethers.Wallet(privKey);
  const enc = encryptPrivateKey(cfg.MASTER_KEY, w.privateKey);

  const db = getDb();
  const res = db
    .prepare('INSERT INTO wallets (telegram_id, name, address, enc_privkey) VALUES (?,?,?,?)')
    .run(telegramId, name, w.address, enc);
  const newId = Number(res.lastInsertRowid);

  return { id: newId, address: w.address };
}

export function removeWallet(telegramId: number, walletId: number) {
  const db = getDb();
  const wasActive = db
    .prepare('SELECT active_wallet_id FROM users WHERE telegram_id=?')
    .get(telegramId) as { active_wallet_id: number | null } | undefined;

  db.prepare('DELETE FROM wallets WHERE id=? AND telegram_id=?').run(walletId, telegramId);

  if (wasActive?.active_wallet_id === walletId) {
    const next = db
      .prepare('SELECT id FROM wallets WHERE telegram_id=? ORDER BY id LIMIT 1')
      .get(telegramId) as { id: number } | undefined;
    db.prepare('UPDATE users SET active_wallet_id=? WHERE telegram_id=?')
      .run(next ? next.id : null, telegramId);
  }
}

export function setActiveWallet(telegramId: number, idOrName: string) {
  const db = getDb();
  let row: { id: number } | undefined;

  if (/^\d+$/.test(idOrName)) {
    row = db
      .prepare('SELECT id FROM wallets WHERE id=? AND telegram_id=?')
      .get(Number(idOrName), telegramId) as { id: number } | undefined;
  } else {
    row = db
      .prepare('SELECT id FROM wallets WHERE name=? AND telegram_id=?')
      .get(idOrName, telegramId) as { id: number } | undefined;
  }

  if (!row) throw new Error('Wallet not found');

  db.prepare('UPDATE users SET active_wallet_id=? WHERE telegram_id=?').run(row.id, telegramId);
  return row.id;
}

export function getActiveWallet(telegramId: number): WalletRow | null {
  const db = getDb();
  const u = db
    .prepare('SELECT active_wallet_id FROM users WHERE telegram_id=?')
    .get(telegramId) as ActiveIdRow;
  if (!u || !u.active_wallet_id) return null;

  const w = db
    .prepare('SELECT id, telegram_id, name, address, enc_privkey FROM wallets WHERE id=? AND telegram_id=?')
    .get(u.active_wallet_id, telegramId) as WalletRow | undefined;
  return w ?? null;
}

export function getPrivateKey(row: WalletRow) {
  return decryptPrivateKey(cfg.MASTER_KEY, row.enc_privkey);
}

export function setToken(telegramId: number, token: string) {
  const db = getDb();
  db.prepare('UPDATE users SET token_address=? WHERE telegram_id=?').run(token, telegramId);
}

export function setGas(telegramId: number, priorityGwei: number, maxGwei: number, gasLimit: number) {
  const db = getDb();
  db.prepare(
    'UPDATE users SET max_priority_fee_gwei=?, max_fee_gwei=?, gas_limit=? WHERE telegram_id=?',
  ).run(priorityGwei, maxGwei, gasLimit, telegramId);
}

export function setBuyAmount(telegramId: number, amountPls: number) {
  const db = getDb();
  db.prepare('UPDATE users SET buy_amount_pls=? WHERE telegram_id=?').run(amountPls, telegramId);
}

export function getUserSettings(telegramId: number) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId) as
    | {
        telegram_id: number;
        active_wallet_id: number | null;
        token_address: string | null;
        base_pair?: string | null;
        max_priority_fee_gwei: number | null;
        max_fee_gwei: number | null;
        gas_limit: number | null;
        buy_amount_pls: number | null;
      }
    | undefined;
  return row;
}
