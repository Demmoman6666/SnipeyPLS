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

export function ensureUserRow(telegramId: number) {
  const db = getDb();
  const row = db.prepare('SELECT telegram_id FROM users WHERE telegram_id=?').get(telegramId);
  if (!row) {
    db.prepare('INSERT INTO users (telegram_id) VALUES (?)').run(telegramId);
  }
}

export function listWallets(telegramId: number): WalletRow[] {
  const db = getDb();
  return db.prepare('SELECT id, telegram_id, name, address, enc_privkey FROM wallets WHERE telegram_id=? ORDER BY id').all(telegramId) as any;
}

export function createWallet(telegramId: number, name: string) {
  ensureUserRow(telegramId);
  const w = ethers.Wallet.createRandom();
  const enc = encryptPrivateKey(cfg.MASTER_KEY, w.privateKey);
  const db = getDb();
  const res = db.prepare('INSERT INTO wallets (telegram_id, name, address, enc_privkey) VALUES (?,?,?,?)')
    .run(telegramId, name, w.address, enc);
  if (!db.prepare('SELECT active_wallet_id FROM users WHERE telegram_id=?').get(telegramId)['active_wallet_id']) {
    db.prepare('UPDATE users SET active_wallet_id=? WHERE telegram_id=?').run(res.lastInsertRowid, telegramId);
  }
  return { id: Number(res.lastInsertRowid), address: w.address };
}

export function importWallet(telegramId: number, name: string, privKey: string) {
  ensureUserRow(telegramId);
  const w = new ethers.Wallet(privKey);
  const enc = encryptPrivateKey(cfg.MASTER_KEY, w.privateKey);
  const db = getDb();
  const res = db.prepare('INSERT INTO wallets (telegram_id, name, address, enc_privkey) VALUES (?,?,?,?)')
    .run(telegramId, name, w.address, enc);
  return { id: Number(res.lastInsertRowid), address: w.address };
}

export function setActiveWallet(telegramId: number, idOrName: string) {
  const db = getDb();
  let row: any;
  if (/^\d+$/.test(idOrName)) {
    row = db.prepare('SELECT id FROM wallets WHERE id=? AND telegram_id=?').get(Number(idOrName), telegramId);
  } else {
    row = db.prepare('SELECT id FROM wallets WHERE name=? AND telegram_id=?').get(idOrName, telegramId);
  }
  if (!row) throw new Error('Wallet not found');
  db.prepare('UPDATE users SET active_wallet_id=? WHERE telegram_id=?').run(row.id, telegramId);
  return row.id as number;
}

export function getActiveWallet(telegramId: number) {
  const db = getDb();
  const u = db.prepare('SELECT active_wallet_id FROM users WHERE telegram_id=?').get(telegramId) as any;
  if (!u || !u.active_wallet_id) return null;
  const w = db.prepare('SELECT * FROM wallets WHERE id=? AND telegram_id=?').get(u.active_wallet_id, telegramId) as WalletRow | undefined;
  return w ?? null;
}

export function getPrivateKey(row: WalletRow) {
  return decryptPrivateKey(cfg.MASTER_KEY, Buffer.from(row.enc_privkey));
}

export function setToken(telegramId: number, token: string) {
  const db = getDb();
  db.prepare('UPDATE users SET token_address=? WHERE telegram_id=?').run(token, telegramId);
}

export function setPair(telegramId: number, pair: 'WPLS' | 'STABLE') {
  const db = getDb();
  db.prepare('UPDATE users SET base_pair=? WHERE telegram_id=?').run(pair, telegramId);
}

export function setGas(telegramId: number, priorityGwei: number, maxGwei: number, gasLimit: number) {
  const db = getDb();
  db.prepare('UPDATE users SET max_priority_fee_gwei=?, max_fee_gwei=?, gas_limit=? WHERE telegram_id=?')
    .run(priorityGwei, maxGwei, gasLimit, telegramId);
}

export function getUserSettings(telegramId: number) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId) as any;
  return row;
}
