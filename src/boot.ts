// src/boot.ts
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import { initDb } from './db.js';

// Reuse TCP/TLS connections for ALL HTTP (Telegram + RPC)
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 128,
  pipelining: 1
}));

// Ensure global fetch is available (for DexScreener, etc.) on Node < 18
// Node 18+ already has globalThis.fetch; this is a no-op there.
if (!(globalThis as any).fetch) {
  (globalThis as any).fetch = undiciFetch as any;
}

// Initialize the database before the bot starts
await initDb();
