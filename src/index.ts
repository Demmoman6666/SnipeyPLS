// src/index.ts
import 'dotenv/config';
import './boot.js';                 // keep-alive/pooling (Undici)
import { bot } from './bot.js';
import { initDb } from './db.js';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  await initDb();

  const WEBHOOK_URL = process.env.WEBHOOK_URL;                    // e.g. https://your-app.up.railway.app
  const TG_WEBHOOK_PATH = process.env.TG_WEBHOOK_PATH || '/tg-webhook';
  const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';  // optional
  const PORT = Number(process.env.PORT || 8080);

  if (WEBHOOK_URL) {
    // --- Webhook mode (fastest) ---
    const target = WEBHOOK_URL.replace(/\/+$/, '') + TG_WEBHOOK_PATH;

    // Register webhook with Telegram (secret header optional)
    await bot.telegram.setWebhook(
      target,
      TG_WEBHOOK_SECRET ? { secret_token: TG_WEBHOOK_SECRET, drop_pending_updates: true } : { drop_pending_updates: true }
    );

    // Telegraf's built-in HTTP server for webhooks
    bot.startWebhook(TG_WEBHOOK_PATH, undefined, PORT);

    console.log(`[pulsebot] Webhook listening on :${PORT}${TG_WEBHOOK_PATH}`);
    console.log(`[pulsebot] Webhook set to ${target}`);
    console.log(`[pulsebot] Chain=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);

    // Graceful shutdown
    const stop = async (sig: string) => {
      console.log(`[pulsebot] Shutting down (${sig})…`);
      try { await bot.telegram.deleteWebhook().catch(() => null); } finally {
        process.exit(0);
      }
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  } else {
    // --- Polling mode (fallback) ---
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => null);
    console.log(`[pulsebot] Starting in polling mode`);
    console.log(`[pulsebot] Chain=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);

    bot.launch();

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
