import 'dotenv/config';
import { bot } from './bot.js';
import { initDb } from './db.js';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  await initDb();
  console.log(`[pulsebot] Starting with CHAIN_ID=${cfg.CHAIN_ID} RPC=${cfg.RPC_URL}`);
  // Long polling — easiest way to stay 24/7 on hosts like Railway/Render/Fly
  bot.launch();
  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
