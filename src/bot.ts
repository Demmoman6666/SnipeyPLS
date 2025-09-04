// src/bot.ts
import './boot.js';
import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import { mainMenu, buyMenu, buyGasPctMenu, sellMenu, settingsMenu } from './keyboards.js';
import {
  listWallets,
  createWallet,
  importWallet,
  setActiveWallet,
  getActiveWallet,
  setToken,
  setGasBase,
  setGasPercent,
  setDefaultGasPercent,
  getUserSettings,
  getPrivateKey,
  setBuyAmount,
  getWalletById,
  removeWallet,
  setSellPct,
  setAutoBuyEnabled,
  setAutoBuyAmount,
} from './wallets.js';
import { ethers } from 'ethers';
import {
  provider,
  erc20,
  tokenMeta,
  bestQuoteBuy,
  bestQuoteSell,
  buyAutoRoute,
  sellAutoRoute,
  clearPendingTransactions,
  withdrawPls,
  pingRpc,
  approveAllRouters,            // ⬅️ used for auto-approve + Sell ▸ Approve
} from './dex.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

/* ---------- helpers ---------- */
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });
const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const fmtInt = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDec = (s: string) => { const [i, d] = s.split('.'); return d ? `${fmtInt(i)}.${d}` : fmtInt(i); };
const fmtPls = (wei: bigint) => fmtDec(ethers.formatEther(wei));
const otter = (hash?: string) => (hash ? `https://otter.pulsechain.com/tx/${hash}` : '');

function canEdit(ctx: any) { return Boolean(ctx?.callbackQuery?.message?.message_id); }
async function sendOrEdit(ctx: any, text: string, extra?: any) {
  if (canEdit(ctx)) {
    try { return await ctx.editMessageText(text, extra); }
    catch { try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch {} return await ctx.reply(text, extra); }
  } else return await ctx.reply(text, extra);
}

/* balances with timeout */
const BAL_TIMEOUT_MS = 8000;
function withTimeout<T>(p: Promise<T>, ms = BAL_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
async function getBalanceFast(address: string): Promise<{ value: bigint; ok: boolean }> {
  try { const v = await withTimeout(provider.getBalance(address)); return { value: v, ok: true }; }
  catch { return { value: 0n, ok: false }; }
}

/* compute effective gas from market + settings */
async function computeGas(telegramId: number, extraPct = 0): Promise<{
  maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gasLimit: bigint;
}> {
  const u = getUserSettings(telegramId);
  const fee = await provider.getFeeData();
  const baseMax = Number(ethers.formatUnits((fee.maxFeePerGas ?? fee.gasPrice ?? 0n), 'gwei'));
  const basePri = Number(ethers.formatUnits((fee.maxPriorityFeePerGas ?? 0n), 'gwei'));
  const boost = u?.gwei_boost_gwei ?? 0;
  const pct = (u?.gas_pct ?? 0) + extraPct;
  const mul = 1 + (pct / 100);
  const effMax = (baseMax + boost) * mul;
  const effPri = (basePri + boost) * mul;
  return {
    maxPriorityFeePerGas: ethers.parseUnits(effPri.toFixed(9), 'gwei'),
    maxFeePerGas: ethers.parseUnits(effMax.toFixed(9), 'gwei'),
    gasLimit: BigInt(u?.gas_limit ?? 250000),
  };
}

/* warm token meta + best route quote (fire-and-forget after setToken) */
function warmTokenAsync(userId: number, address: string) {
  tokenMeta(address).catch(() => {});
  const amt = ethers.parseEther(String(getUserSettings(userId)?.buy_amount_pls ?? 0.01));
  bestQuoteBuy(amt, address).catch(() => {});
}

/* --- track last buy for Net PnL (session memory) --- */
type LastBuy = { avgPlsPerToken: number; lastPlsIn: number; ts: number };
const lastBuy = new Map<string, LastBuy>();
const keyLT = (uid: number, token: string) => `${uid}:${token.toLowerCase()}`;
function setLastBuy(uid: number, token: string, amountInWei: bigint, amountOutWei: bigint, dec = 18) {
  if (amountOutWei <= 0n) return;
  const pls = Number(ethers.formatEther(amountInWei));
  const tok = Number(ethers.formatUnits(amountOutWei, dec));
  if (tok > 0) lastBuy.set(keyLT(uid, token), { avgPlsPerToken: pls / tok, lastPlsIn: pls, ts: Math.floor(Date.now()/1000) });
}
function getLastBuy(uid: number, token?: string) {
  if (!token) return undefined;
  return lastBuy.get(keyLT(uid, token));
}

/* --- Multi-wallet selection state (in-memory) --- */
const selectedWallets = new Map<number, Set<number>>();
function getSelSet(uid: number) {
  let s = selectedWallets.get(uid);
  if (!s) { s = new Set<number>(); selectedWallets.set(uid, s); }
  return s;
}
function chunk<T>(arr: T[], size = 6): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* pending prompts */
type Pending =
  | { type: 'set_amount' }
  | { type: 'set_token' }
  | { type: 'gen_name' }
  | { type: 'import_wallet' }
  | { type: 'withdraw'; walletId: number }
  | { type: 'set_gl' }
  | { type: 'set_gb' }
  | { type: 'set_defpct' }
  | { type: 'auto_amt' };
const pending = new Map<number, Pending>();

/* ---------- /start ---------- */
bot.start(async (ctx) => { await ctx.reply('Main Menu', mainMenu()); });

/* ---------- SETTINGS ---------- */
async function renderSettings(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const lines = [
    'SETTINGS',
    '',
    `Gas Limit: ${fmtInt(String(u?.gas_limit ?? 250000))}`,
    `Gwei Booster: ${NF.format(u?.gwei_boost_gwei ?? 0)} gwei`,
    `Default Gas % over market: ${NF.format(u?.default_gas_pct ?? 0)}%`,
    `Auto-buy: ${(u?.auto_buy_enabled ? 'ON' : 'OFF')}  |  Amount: ${fmtDec(String(u?.auto_buy_amount_pls ?? 0.01))} PLS`,
  ].join('\n');
  return sendOrEdit(ctx, lines, settingsMenu());
}

bot.action('settings', async (ctx) => { await ctx.answerCbQuery(); return renderSettings(ctx); });

bot.action('set_gl', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gl' });
  return sendOrEdit(ctx, 'Send new *Gas Limit* (e.g., `300000`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});
bot.action('set_gb', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gb' });
  return sendOrEdit(ctx, 'Send new *Gwei Booster* in gwei (e.g., `0.2`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});
bot.action('set_defpct', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_defpct' });
  return sendOrEdit(ctx, 'Send *Default Gas %* over market (e.g., `10`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});
bot.action('auto_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  setAutoBuyEnabled(ctx.from.id, !(u?.auto_buy_enabled ?? 0));
  return renderSettings(ctx);
});
bot.action('auto_amt', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'auto_amt' });
  return sendOrEdit(ctx, 'Send *Auto-buy amount* in PLS (e.g., `0.5`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});

/* ---------- Wallets: list/manage ---------- */
async function renderWalletsList(ctx: any) {
  const rows = listWallets(ctx.from.id);
  if (!rows.length) {
    return sendOrEdit(ctx, 'No wallets yet.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')],
        [Markup.button.callback('⬅️ Back', 'main_back')],
      ]));
  }
  const balances = await Promise.all(rows.map(w => getBalanceFast(w.address)));

  const lines = [
    'Your Wallets',
    '',
    'Address                              | Balance (PLS)',
    '-------------------------------------|----------------',
    ...rows.map((w, i) => `${w.address} | ${fmtPls(balances[i].value)}`),
    balances.some(b => !b.ok) ? '\n⚠️ Some balances didn’t load from the RPC. Use /rpc_check.' : ''
  ].filter(Boolean);

  // Each row: [ Manage, "<X PLS>" (unclickable) ]
  const kb = rows.map((w, i) => [
    Markup.button.callback(`${w.id}. ${short(w.address)}`, `wallet_manage:${w.id}`),
    Markup.button.callback(`${fmtPls(balances[i].value)} PLS`, 'noop'),
  ]);
  kb.push([Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')]);
  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);

  return sendOrEdit(ctx, lines.join('\n'), Markup.inlineKeyboard(kb));
}

async function renderWalletManage(ctx: any, walletId: number) {
  const w = getWalletById(ctx.from.id, walletId);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  const { value: bal, ok } = await getBalanceFast(w.address);
  const lines = [
    'Wallet',
    '',
    `ID: ${walletId}`,
    `Address: ${w.address}`,
    `Balance: ${fmtPls(bal)} PLS${ok ? '' : '  (RPC issue)'}`,
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Show Private Key', `wallet_pk:${walletId}`), Markup.button.callback('🔄 Refresh', `wallet_refresh:${walletId}`)],
    [Markup.button.callback('🧹 Clear Pending', `wallet_clear:${walletId}`), Markup.button.callback('🏧 Withdraw', `wallet_withdraw:${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove:${walletId}`), Markup.button.callback('⬅️ Back', 'wallets')],
  ]);

  return sendOrEdit(ctx, lines, kb);
}

bot.action('wallets', async (ctx) => { await ctx.answerCbQuery(); return renderWalletsList(ctx); });
bot.action(/^wallet_manage:(\d+)$/, async (ctx: any) => { await ctx.answerCbQuery(); return renderWalletManage(ctx, Number(ctx.match[1])); });

// (removed wallet_set_active action)

/* PK (masked + reveal) */
bot.action(/^wallet_pk:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  const masked = getPrivateKey(w).replace(/^(.{6}).+(.{4})$/, '$1…$2');
  return sendOrEdit(ctx, `Private key (masked): ${masked}\nRevealing exposes full control of funds.`,
    Markup.inlineKeyboard([[Markup.button.callback('⚠️ Reveal', `wallet_pk_reveal:${id}`)], [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]));
});
bot.action(/^wallet_pk_reveal:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  await ctx.reply(`PRIVATE KEY for ${short(w.address)}:\n\`${getPrivateKey(w)}\``, { parse_mode: 'Markdown' });
  return renderWalletManage(ctx, id);
});

/* Clear pending / Withdraw / Remove / Refresh */
bot.action(/^wallet_clear:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  try {
    const gas = await computeGas(ctx.from.id, 10);
    const res = await clearPendingTransactions(getPrivateKey(w), gas);
    await ctx.reply(`Cleared ${res.cleared} pending transactions.`);
  } catch (e: any) {
    await ctx.reply('Clear pending failed: ' + (e?.message ?? String(e)));
  }
  return renderWalletManage(ctx, id);
});
bot.action(/^wallet_withdraw:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  pending.set(ctx.from.id, { type: 'withdraw', walletId: id });
  return sendOrEdit(ctx, 'Reply with: `address amount_pls` (e.g., `0xabc... 0.5`)',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]));
});
bot.action(/^wallet_remove:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  return sendOrEdit(ctx, `Remove wallet ID ${id}? This does NOT revoke keys on-chain.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Confirm Remove', `wallet_remove_confirm:${id}`)],
      [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)],
    ]));
});
bot.action(/^wallet_remove_confirm:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  removeWallet(ctx.from.id, Number(ctx.match[1]));
  await ctx.reply(`Wallet removed.`);
  return renderWalletsList(ctx);
});
bot.action(/^wallet_refresh:(\d+)$/, async (ctx: any) => { await ctx.answerCbQuery(); return renderWalletManage(ctx, Number(ctx.match[1])); });

/* Generate / Import prompts */
bot.action('wallet_generate', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'gen_name' });
  return sendOrEdit(ctx, 'Send a name for the new wallet (e.g., `trader1`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});
bot.action('wallet_add', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_wallet' });
  return sendOrEdit(ctx, 'Reply: `name privkey` (e.g., `hot1 0x...`)', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});

/* ---------- BUY MENU ---------- */

async function renderBuyMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const aw = getActiveWallet(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  const pct = u?.gas_pct ?? (u?.default_gas_pct ?? 0);
  const gl = u?.gas_limit ?? 250000;
  const gb = u?.gwei_boost_gwei ?? 0;

  let tokenLine = 'Token: —';
  let pairLine = `Pair: ${process.env.WPLS_ADDRESS} (WPLS)`;
  let outLine = 'Amount out: unavailable';

  if (u?.token_address) {
    try {
      const meta = await tokenMeta(u.token_address);
      tokenLine = `Token: ${u.token_address} (${meta.symbol || meta.name || 'TOKEN'})`;

      const best = await bestQuoteBuy(ethers.parseEther(String(amt)), u.token_address);
      if (best) {
        const dec = meta.decimals ?? 18;
        outLine = `Amount out: ${fmtDec(ethers.formatUnits(best.amountOut, dec))} ${meta.symbol || 'TOKEN'}   ·   Route: ${best.route.key}`;
      }
    } catch { /* keep defaults */ }
  }

  const lines = [
    'BUY MENU',
    '',
    `Wallet: ${aw ? aw.address : '— (Select)'}`,
    tokenLine,
    pairLine,
    '',
    `Amount in: ${fmtDec(String(amt))} PLS`,
    `Gas boost: +${NF.format(pct)}% over market`,
    `GL: ${fmtInt(String(gl))}  |  Booster: ${NF.format(gb)} gwei`,
    '',
    outLine,
  ].join('\n');

  // Wallet toggles (W1..Wn)
  const rows = listWallets(ctx.from.id);
  const sel = getSelSet(ctx.from.id);
  const walletButtons = chunk(
    rows.map((w, i) =>
      Markup.button.callback(`${sel.has(w.id) ? '✅ ' : ''}W${i + 1}`, `wallet_toggle:${w.id}`)
    ),
    6
  );

  return sendOrEdit(ctx, lines, buyMenu(Math.round(pct), walletButtons));
}

bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });
bot.action('buy_refresh', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });

bot.action('buy_set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_amount' });
  return sendOrEdit(ctx, 'Send *amount in PLS* (e.g., `0.05`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]) });
});
bot.action('buy_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_token' });
  return sendOrEdit(ctx, 'Paste the *token contract address* (0x...).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]) });
});

bot.action('gas_pct_open', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Choose gas % over market:', buyGasPctMenu()); });
bot.action(/^gas_pct_set:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const v = Number(ctx.match[1]);
  setGasPercent(ctx.from.id, v);
  return renderBuyMenu(ctx);
});

bot.action('pair_info', async (ctx) => {
  await ctx.answerCbQuery();
  const W = process.env.WPLS_ADDRESS!;
  return ctx.reply(`Base pair is WPLS:\n${W}`);
});

/* Toggle wallet in selection set */
bot.action(/^wallet_toggle:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const s = getSelSet(ctx.from.id);
  if (s.has(id)) s.delete(id); else s.add(id);
  return renderBuyMenu(ctx);
});

/* Buy using selected wallets (or active if none selected) + auto-approve + record entry price */
bot.action('buy_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const active = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return sendOrEdit(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));

  // Selected wallets if any, else active wallet
  const selIds = Array.from(getSelSet(ctx.from.id));
  let wallets = selIds.length
    ? listWallets(ctx.from.id).filter(w => selIds.includes(w.id))
    : (active ? [active] : []);
  if (!wallets.length) return sendOrEdit(ctx, 'Select a wallet first (Wallets page).', buyMenu(u?.gas_pct ?? 0));

  const res: string[] = [];
  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));
  const meta = await tokenMeta(u.token_address);
  const preQuote = await bestQuoteBuy(amountIn, u.token_address);

  for (const w of wallets) {
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;
      res.push(`✅ ${w.name ?? ''} ${w.address.slice(0,6)}…${w.address.slice(-4)} → ${hash ?? '(pending)'}${hash ? `  ${otter(hash)}` : ''}`);

      // record last buy (user+token)
      if (preQuote?.amountOut) setLastBuy(ctx.from.id, u.token_address, amountIn, preQuote.amountOut, meta.decimals ?? 18);

      // background infinite approve for all routers (skip WPLS)
      if (u.token_address.toLowerCase() !== process.env.WPLS_ADDRESS!.toLowerCase()) {
        approveAllRouters(getPrivateKey(w), u.token_address, gas).catch(() => {});
      }
    } catch (e: any) {
      res.push(`❌ ${w.name ?? ''} ${w.address.slice(0,6)}…${w.address.slice(-4)} → ${e.message}`);
    }
  }
  await ctx.reply(res.join('\n'));
  return renderBuyMenu(ctx);
});

bot.action('buy_exec_all', async (ctx) => {
  await ctx.answerCbQuery();
  const rows = listWallets(ctx.from.id); const u = getUserSettings(ctx.from.id);
  if (!rows.length) return sendOrEdit(ctx, 'No wallets.', buyMenu(u?.gas_pct ?? 0));
  if (!u?.token_address) return sendOrEdit(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));

  const res: string[] = [];
  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));
  const meta = await tokenMeta(u.token_address);
  const preQuote = await bestQuoteBuy(amountIn, u.token_address);

  for (const row of rows) {
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(row), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;
      res.push(`✅ ${short(row.address)} -> ${hash ?? '(pending)'}${hash ? `  ${otter(hash)}` : ''}`);

      if (preQuote?.amountOut) setLastBuy(ctx.from.id, u.token_address, amountIn, preQuote.amountOut, meta.decimals ?? 18);
      if (u.token_address.toLowerCase() !== process.env.WPLS_ADDRESS!.toLowerCase()) {
        approveAllRouters(getPrivateKey(row), u.token_address, gas).catch(() => {});
      }
    } catch (e: any) { res.push(`❌ ${short(row.address)} -> ${e.message}`); }
  }
  await ctx.reply(res.join('\n'));
  return renderBuyMenu(ctx);
});

/* ---------- SELL MENU ---------- */
async function renderSellMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  const pct = u?.sell_pct ?? 100;
  let balLine = 'Token balance: —';
  let outLine = 'Amount out: —';
  let pnlLine = '';
  let infoLine = '';

  if (w && u?.token_address) {
    try {
      const meta = await tokenMeta(u.token_address);
      const dec = meta.decimals ?? 18;
      const c = erc20(u.token_address);
      const [bal, fee, block] = await Promise.all([
        c.balanceOf(w.address),
        provider.getFeeData(),
        provider.getBlockNumber(),
      ]);

      const gasGwei = Number(ethers.formatUnits(fee.gasPrice ?? fee.maxFeePerGas ?? 0n, 'gwei'));
      infoLine = `Block: ${fmtInt(String(block))}  |  Gas: ${NF.format(gasGwei)} gwei`;

      balLine = `Token balance: ${fmtDec(ethers.formatUnits(bal, dec))} ${meta.symbol || 'TOKEN'}`;
      const amountIn = (bal * BigInt(Math.round(pct))) / 100n;
      if (amountIn > 0n) {
        const best = await bestQuoteSell(amountIn, u.token_address);
        if (best) {
          outLine = `Amount out: ${fmtPls(best.amountOut)} PLS   ·   Route: ${best.route.key}`;

          // Net PnL against last buy
          const entry = getLastBuy(ctx.from.id, u.token_address);
          if (entry && entry.avgPlsPerToken > 0) {
            const amtTok = Number(ethers.formatUnits(amountIn, dec)); // tokens to sell
            const curPls = Number(ethers.formatEther(best.amountOut)); // PLS received
            const curAvg = curPls / Math.max(amtTok, 1e-18);
            const diffPerTok = curAvg - entry.avgPlsPerToken;
            const pnlPls = diffPerTok * amtTok;
            const pnlPct = (curAvg / entry.avgPlsPerToken - 1) * 100;
            pnlLine = `Net PnL: ${pnlPls >= 0 ? '🟢' : '🔴'} ${NF.format(pnlPls)} PLS  (${NF.format(pnlPct)}%)`;
          } else {
            pnlLine = `Net PnL: — (no entry recorded yet)`;
          }
        }
      } else {
        outLine = 'Amount out: 0';
      }

      // Show last buy size if known
      const entry = getLastBuy(ctx.from.id, u.token_address);
      if (entry) {
        pnlLine += `${pnlLine ? '\n' : ''}Last buy: ${NF.format(entry.lastPlsIn)} PLS  ·  Entry: ${NF.format(entry.avgPlsPerToken)} PLS/token`;
      }
    } catch { /* keep defaults */ }
  }

  const lines = [
    'SELL MENU',
    '',
    `Wallet: ${w ? short(w.address) : '— (Select)'} | Token: ${u?.token_address ? short(u.token_address) : '—'}`,
    `Sell percent: ${NF.format(pct)}%`,
    balLine,
    outLine,
    pnlLine,
    infoLine,
  ].filter(Boolean).join('\n');
  return sendOrEdit(ctx, lines, sellMenu());
}

bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); return renderSellMenu(ctx); });
bot.action('sell_pct_25', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 25); return renderSellMenu(ctx); });
bot.action('sell_pct_50', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 50); return renderSellMenu(ctx); });
bot.action('sell_pct_75', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 75); return renderSellMenu(ctx); });
bot.action('sell_pct_100', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 100); return renderSellMenu(ctx); });

/* Sell ▸ Approve button */
bot.action('sell_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id) || listWallets(ctx.from.id)[0];
  if (!w || !u?.token_address) return sendOrEdit(ctx, 'Need a wallet and token set first.', sellMenu());
  if (u.token_address.toLowerCase() === process.env.WPLS_ADDRESS!.toLowerCase())
    return sendOrEdit(ctx, 'WPLS doesn’t require approval.', sellMenu());
  try {
    const gas = await computeGas(ctx.from.id);
    const results = await approveAllRouters(getPrivateKey(w), u.token_address, gas);
    await ctx.reply(`Approve sent:\n${results.join('\n')}`);
  } catch (e: any) {
    await ctx.reply('Approve failed: ' + (e?.message ?? String(e)));
  }
  return renderSellMenu(ctx);
});

bot.action('sell_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id); const w = getActiveWallet(ctx.from.id);
  if (!w || !u?.token_address) return sendOrEdit(ctx, 'Need active wallet and token set.', sellMenu());
  try {
    const c = erc20(u.token_address);
    const bal = await c.balanceOf(w.address);
    const pct = u?.sell_pct ?? 100;
    const amount = (bal * BigInt(Math.round(pct))) / 100n;
    if (amount <= 0n) return sendOrEdit(ctx, 'Nothing to sell.', sellMenu());
    const gas = await computeGas(ctx.from.id);
    const r = await sellAutoRoute(getPrivateKey(w), u.token_address, amount, 0n, gas);
    const hash = (r as any)?.hash;
    await ctx.reply(hash ? `Sell sent! ${otter(hash)}` : 'Sell sent! (pending)');
  } catch (e: any) { await ctx.reply('Sell failed: ' + e.message); }
  return renderSellMenu(ctx);
});

/* ---------- DIAGNOSTICS ---------- */
bot.command('rpc_check', async (ctx) => {
  const aw = getActiveWallet(ctx.from.id);
  const info = await pingRpc(aw?.address);
  const lines = [
    '*RPC Check*',
    `chainId: ${info.chainId ?? '—'}`,
    `block: ${info.blockNumber ?? '—'}`,
    `gasPrice(wei): ${info.gasPrice ?? '—'}`,
    `maxFeePerGas(wei): ${info.maxFeePerGas ?? '—'}`,
    `maxPriorityFeePerGas(wei): ${info.maxPriorityFeePerGas ?? '—'}`,
    `active wallet: ${aw ? aw.address : '—'}`,
    `balance(wei): ${info.balanceWei ?? '—'}`,
    `${info.error ? 'error: ' + info.error : ''}`,
  ].join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

/* ---------- Classic commands (kept) ---------- */
bot.command('wallets', async (ctx) => renderWalletsList(ctx));
bot.command('wallet_new', async (ctx) => {
  const [_, name] = ctx.message.text.split(/\s+/, 2);
  if (!name) return ctx.reply('Usage: /wallet_new <name>');
  const w = createWallet(ctx.from.id, name);
  return ctx.reply(`Created wallet "${name}": ${w.address}`);
});
bot.command('wallet_import', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 3) return ctx.reply('Usage: /wallet_import <name> <privkey>');
  const name = parts[1], pk = parts[2];
  try { const w = importWallet(ctx.from.id, name, pk); return ctx.reply(`Imported wallet "${name}": ${w.address}`); }
  catch (e: any) { return ctx.reply('Import failed: ' + e.message); }
});
bot.command('wallet_select', async (ctx) => {
  const [_, idOrName] = ctx.message.text.split(/\s+/, 2);
  if (!idOrName) return ctx.reply('Usage: /wallet_select <id|name>');
  try { const id = setActiveWallet(ctx.from.id, idOrName); return ctx.reply('Active wallet set to ID ' + id); }
  catch (e: any) { return ctx.reply('Select failed: ' + e.message); }
});
bot.command('set_token', async (ctx) => {
  const [_, address] = ctx.message.text.split(/\s+/, 2);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return ctx.reply('Usage: /set_token <0xAddress>');
  setToken(ctx.from.id, address);
  warmTokenAsync(ctx.from.id, address);
  return renderBuyMenu(ctx);
});
bot.command('set_gas', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 3) return ctx.reply('Usage: /set_gas <gwei_booster> <gas_limit>');
  const booster = Number(parts[1]), limit = Number(parts[2]);
  if (!Number.isFinite(booster) || !Number.isFinite(limit)) return ctx.reply('Invalid numbers.');
  setGasBase(ctx.from.id, Math.max(21000, Math.floor(limit)), booster);
  return ctx.reply(`Gas updated. Booster=${booster} gwei, GasLimit=${limit}`);
});
bot.command('price', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  try {
    const best = await bestQuoteBuy(ethers.parseEther('1'), u.token_address);
    if (!best) return ctx.reply('No route available for price.');
    const meta = await tokenMeta(u.token_address);
    return ctx.reply(`1 WPLS -> ${fmtDec(ethers.formatUnits(best.amountOut, meta.decimals ?? 18))} ${meta.symbol || 'TOKEN'}   ·   Route: ${best.route.key}`);
  } catch (e: any) { return ctx.reply('Price failed: ' + e.message); }
});
bot.command('balances', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.reply('Select a wallet first.');
  const addr = w.address;
  const u = getUserSettings(ctx.from.id);
  const { value: plsBal } = await getBalanceFast(addr);
  let token = 'N/A';
  if (u?.token_address) {
    try {
      const meta = await tokenMeta(u.token_address);
      const c = erc20(u.token_address);
      const bal = await c.balanceOf(addr);
      token = `${fmtDec(ethers.formatUnits(bal, meta.decimals ?? 18))} ${meta.symbol || 'TOKEN'}`;
    } catch { token = 'N/A'; }
  }
  return ctx.reply(`Wallet ${addr}\n\nPLS: ${fmtPls(plsBal)}\nToken: ${token}`);
});

/* ---------- TEXT: prompts + auto-buy ---------- */
bot.on('text', async (ctx, next) => {
  const p = pending.get(ctx.from.id);
  if (p) {
    const msg = String(ctx.message.text).trim();

    if (p.type === 'set_amount') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v <= 0) return ctx.reply('Send a positive number (e.g., 0.02).');
      setBuyAmount(ctx.from.id, v); pending.delete(ctx.from.id);
      await ctx.reply(`Buy amount set to ${fmtDec(String(v))} PLS.`);
      return renderBuyMenu(ctx);
    }

    if (p.type === 'set_token') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(msg)) return ctx.reply('That does not look like a token address.');
      setToken(ctx.from.id, msg);
      warmTokenAsync(ctx.from.id, msg);
      pending.delete(ctx.from.id);
      return renderBuyMenu(ctx);
    }

    if (p.type === 'gen_name') {
      const name = msg; if (!name) return ctx.reply('Please send a non-empty name.');
      const w = createWallet(ctx.from.id, name); pending.delete(ctx.from.id);
      await ctx.reply(`Created wallet "${name}": ${w.address}`);
      return renderWalletsList(ctx);
    }

    if (p.type === 'import_wallet') {
      const parts = msg.split(/\s+/); if (parts.length < 2) return ctx.reply('Expected: `name privkey`');
      const name = parts[0], pk = parts[1];
      try { const w = importWallet(ctx.from.id, name, pk); pending.delete(ctx.from.id); await ctx.reply(`Imported "${name}": ${w.address}`); }
      catch (e: any) { pending.delete(ctx.from.id); return ctx.reply('Import failed: ' + e.message); }
      return renderWalletsList(ctx);
    }

    if (p.type === 'withdraw') {
      const [to, amtStr] = msg.split(/\s+/);
      if (!/^0x[a-fA-F0-9]{40}$/.test(to) || !amtStr) return ctx.reply('Expected: `address amount_pls`');
      const amount = Number(amtStr);
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Amount must be positive.');
      const w = getWalletById(ctx.from.id, p.walletId); if (!w) { pending.delete(ctx.from.id); return ctx.reply('Wallet not found.'); }
      try {
        const gas = await computeGas(ctx.from.id);
        const receipt = await withdrawPls(getPrivateKey(w), to, ethers.parseEther(String(amount)), gas);
        const hash = (receipt as any)?.hash;
        await ctx.reply(hash ? `Withdraw sent! ${otter(hash)}` : 'Withdraw sent! (pending)');
      } catch (e: any) { await ctx.reply('Withdraw failed: ' + e.message); }
      pending.delete(ctx.from.id);
      return renderWalletManage(ctx, p.walletId);
    }

    if (p.type === 'set_gl') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v < 21000) return ctx.reply('Gas Limit must be ≥ 21000.');
      const u = getUserSettings(ctx.from.id); setGasBase(ctx.from.id, Math.floor(v), u?.gwei_boost_gwei ?? 0);
      pending.delete(ctx.from.id); return renderSettings(ctx);
    }

    if (p.type === 'set_gb') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v < 0) return ctx.reply('Gwei Booster must be ≥ 0.');
      const u = getUserSettings(ctx.from.id); setGasBase(ctx.from.id, u?.gas_limit ?? 250000, v);
      pending.delete(ctx.from.id); return renderSettings(ctx);
    }

    if (p.type === 'set_defpct') {
      const v = Number(msg);
      if (!Number.isFinite(v)) return ctx.reply('Send a number (percent).');
      setDefaultGasPercent(ctx.from.id, v); setGasPercent(ctx.from.id, v);
      pending.delete(ctx.from.id); return renderSettings(ctx);
    }

    if (p.type === 'auto_amt') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v <= 0) return ctx.reply('Send a positive number (PLS).');
      setAutoBuyAmount(ctx.from.id, v);
      pending.delete(ctx.from.id); return renderSettings(ctx);
    }

    return;
  }

  // Auto-detect token address
  const text = String(ctx.message.text).trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    setToken(ctx.from.id, text);
    warmTokenAsync(ctx.from.id, text);

    const u = getUserSettings(ctx.from.id);
    if (u?.auto_buy_enabled) {
      const w = getActiveWallet(ctx.from.id);
      if (!w) { await ctx.reply('Select or create a wallet first.'); return renderBuyMenu(ctx); }
      try {
        const gas = await computeGas(ctx.from.id);
        const receipt = await buyAutoRoute(getPrivateKey(w), text, ethers.parseEther(String(u.auto_buy_amount_pls ?? 0.01)), 0n, gas);
        const hash = (receipt as any)?.hash;
        await ctx.reply(hash ? `Auto-buy sent! ${otter(hash)}` : 'Auto-buy sent! (pending)');
      } catch (e: any) {
        await ctx.reply('Auto-buy failed: ' + e.message);
      }
      return renderBuyMenu(ctx);
    } else {
      return renderBuyMenu(ctx);
    }
  }

  return next();
});

/* ---------- shortcuts from main ---------- */
bot.action('main_back', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Main Menu', mainMenu()); });
bot.action('price', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /price after setting a token.', mainMenu()); });
bot.action('balances', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /balances after selecting a wallet.', mainMenu()); });

// no-op pill handler
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

export {};
