// src/boot.ts
import { Agent, setGlobalDispatcher } from 'undici';

// Reuse TCP/TLS connections for ALL HTTP (Telegram + RPC)
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 128,
  pipelining: 1
}));
