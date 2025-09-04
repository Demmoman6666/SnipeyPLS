// src/index.ts
import 'dotenv/config';
import './boot.js';                 // keep-alive / connection pooling (Undici), optional if you already import in bot.ts
import { bot } from './bot.js';
import { initDb } from './db.js';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  await initDb();

  const WEBHOOK_URL_RAW = process.env.WEBHOOK_URL;                 // e.g. https://your-app.up.railway.app
  const TG_WEBHOOK_PATH = process.env.TG_WEBHOOK_PATH || '/tg-webhook';
  const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';   // optional
  const PORT = Number(process.env.PORT || 8080);

  if (WEBHOOK_URL_RAW) {
    // --- Webhook mode (fastest) ---
    const domain = WEBHOOK_URL_RAW.replace(/\/+$/, ''); // no trailing slash
    await bot.launch({
      webhook: {
        domain,
        hookPath: TG_WEBHOOK_PATH,
        port: PORT,
        secretToken: TG_WEBHOOK_SECRET || undefined,
        // dropPendingUpdates: true, // enable if you want to drop backlog on deploys
      },
    });

    console.log(`[pulsebot] Webhook listening on :${PORT}${TG_WEBHOOK_PATH}`);
    console.log(`[pulsebot] Webhook domain set to ${domain}`);
    console.log(`[pulsebot] Chain=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);
  } else {
    // --- Polling mode (fallback) ---
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => null);
    console.log(`[pulsebot] Starting in polling mode`);
    console.log(`[pulsebot] Chain=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);
    await bot.launch();
  }

  // Graceful shutdown
  const stop = async (sig: string) => {
    console.log(`[pulsebot] Shutting down (${sig})…`);
    try { await bot.stop(sig); } finally { process.exit(0); }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
