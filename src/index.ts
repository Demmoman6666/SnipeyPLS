// src/index.ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { webhookCallback } from 'telegraf';
import { bot } from './bot.js';
import { initDb } from './db.js';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  await initDb();

  const WEBHOOK_URL = process.env.WEBHOOK_URL;                    // e.g. https://your-app.up.railway.app
  const TG_WEBHOOK_PATH = process.env.TG_WEBHOOK_PATH || '/tg-webhook';
  const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';  // optional, but recommended
  const PORT = Number(process.env.PORT || 8080);                  // Railway provides PORT

  if (WEBHOOK_URL) {
    // --- Webhook mode ---
    const targetUrl = WEBHOOK_URL.replace(/\/+$/, '') + TG_WEBHOOK_PATH;

    // Register webhook with Telegram
    await bot.telegram.setWebhook(
      targetUrl,
      TG_WEBHOOK_SECRET ? { secret_token: TG_WEBHOOK_SECRET } : undefined
    );

    const handleUpdate = webhookCallback(bot, 'http');

    // Minimal HTTP server for Telegram callbacks + health check
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && req.url === TG_WEBHOOK_PATH) {
        if (TG_WEBHOOK_SECRET) {
          const hdr = req.headers['x-telegram-bot-api-secret-token'];
          if (hdr !== TG_WEBHOOK_SECRET) {
            res.writeHead(401);
            res.end('unauthorized');
            return;
          }
        }
        handleUpdate(req, res);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    server.listen(PORT, () => {
      console.log(`[pulsebot] Webhook listening on :${PORT}${TG_WEBHOOK_PATH}`);
      console.log(`[pulsebot] Webhook set to ${targetUrl}`);
      console.log(`[pulsebot] Chain=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);
    });

    // Graceful shutdown
    const stop = async (sig: string) => {
      console.log(`[pulsebot] Shutting down (${sig})…`);
      try { await bot.telegram.deleteWebhook().catch(() => null); } finally {
        server.close(() => process.exit(0));
      }
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  } else {
    // --- Polling mode (fallback) ---
    // Ensure webhook is removed if it was previously set
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
