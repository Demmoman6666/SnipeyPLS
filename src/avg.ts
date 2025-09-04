// src/avg.ts
import { getDb } from './db.js';

/** Add a filled buy (aggregates amount over time). */
export function recordBuy(uid: number, token: string, tokenWei: bigint, plsWei: bigint) {
  const db = getDb();
  const row = db.prepare(
    'SELECT total_token_wei, total_pls_wei FROM avg_entry WHERE uid=? AND token=?'
  ).get(uid, token) as any;

  if (row) {
    const totTok = BigInt(row.total_token_wei) + tokenWei;
    const totPls = BigInt(row.total_pls_wei) + plsWei;
    db.prepare('UPDATE avg_entry SET total_token_wei=?, total_pls_wei=? WHERE uid=? AND token=?')
      .run(totTok.toString(), totPls.toString(), uid, token);
  } else {
    db.prepare('INSERT INTO avg_entry (uid, token, total_token_wei, total_pls_wei) VALUES (?,?,?,?)')
      .run(uid, token, tokenWei.toString(), plsWei.toString());
  }
}

/** Get running totals; null if no buys recorded. */
export function getAvg(uid: number, token: string):
  | { totalTokenWei: bigint; totalPlsWei: bigint }
  | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT total_token_wei, total_pls_wei FROM avg_entry WHERE uid=? AND token=?'
  ).get(uid, token) as any;
  if (!row) return null;
  return { totalTokenWei: BigInt(row.total_token_wei), totalPlsWei: BigInt(row.total_pls_wei) };
}

/** Optional helper to reset a position’s averages. */
export function clearAvg(uid: number, token: string) {
  getDb().prepare('DELETE FROM avg_entry WHERE uid=? AND token=?').run(uid, token);
}
