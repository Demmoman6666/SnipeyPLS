// src/avg.ts
import { getDb } from './db.js';

const db = getDb();

// Table stores cumulative totals (bigints as TEXT) per user + token
db.exec(`
CREATE TABLE IF NOT EXISTS avg_entry (
  uid               INTEGER NOT NULL,
  token             TEXT    NOT NULL,
  total_token_wei   TEXT    NOT NULL,
  total_pls_wei     TEXT    NOT NULL,
  PRIMARY KEY (uid, token)
);
`);

const selStmt = db.prepare(`SELECT total_token_wei, total_pls_wei FROM avg_entry WHERE uid=? AND token=?`);
const insStmt = db.prepare(`INSERT INTO avg_entry (uid, token, total_token_wei, total_pls_wei) VALUES (?, ?, ?, ?)`);
const updStmt = db.prepare(`UPDATE avg_entry SET total_token_wei=?, total_pls_wei=? WHERE uid=? AND token=?`);

export function addBuyToAverage(uid: number, token: string, tokenWei: bigint, plsWei: bigint) {
  const t = token.toLowerCase();
  const row = selStmt.get(uid, t) as { total_token_wei: string; total_pls_wei: string } | undefined;
  if (!row) {
    insStmt.run(uid, t, tokenWei.toString(), plsWei.toString());
  } else {
    const newTok = (BigInt(row.total_token_wei) + tokenWei).toString();
    const newPls = (BigInt(row.total_pls_wei) + plsWei).toString();
    updStmt.run(newTok, newPls, uid, t);
  }
}

export function getAverageTotals(uid: number, token: string): { totalTokenWei: bigint; totalPlsWei: bigint } | null {
  const row = selStmt.get(uid, token.toLowerCase()) as { total_token_wei: string; total_pls_wei: string } | undefined;
  if (!row) return null;
  return { totalTokenWei: BigInt(row.total_token_wei), totalPlsWei: BigInt(row.total_pls_wei) };
}
