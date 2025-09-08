// src/bot.ts
import './boot.js';
import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import { mainMenu, buyMenu, buyGasPctMenu, sellMenu, settingsMenu, limitTriggerMenu } from './keyboards.js';
import {
  listWallets, createWallet, importWallet, setActiveWallet, getActiveWallet, setToken, setGasBase, setGasPercent,
  setDefaultGasPercent, getUserSettings, getPrivateKey, setBuyAmount, getWalletById, removeWallet, setSellPct,
  setAutoBuyEnabled, setAutoBuyAmount,
} from './wallets.js';
import { ethers } from 'ethers';
import {
  provider, erc20, tokenMeta, bestQuoteBuy, bestQuoteSell,
  buyAutoRoute, sellAutoRoute, clearPendingTransactions, withdrawPls,
  pingRpc, approveAllRouters,
} from './dex.js';
import {
  recordTrade, getAvgEntry, addLimitOrder, listLimitOrders,
  getOpenLimitOrders, cancelLimitOrder, markLimitFilled, markLimitError,
} from './db.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

/* ---------- helpers / formatting ---------- */
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });
const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const fmtInt = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDec = (s: string) => { const [i, d] = s.split('.'); return d ? `${fmtInt(i)}.${d}` : fmtInt(i); };
const fmtPls = (wei: bigint) => fmtDec(ethers.formatEther(wei));
const otter = (hash?: string) => (hash ? `https://otter.pulsechain.com/tx/${hash}` : '');
const STABLE = (process.env.USDC_ADDRESS || process.env.USDCe_ADDRESS || process.env.STABLE_ADDRESS || '').toLowerCase();

/* ---------- message lifecycle: delete previous menus, manage pin ---------- */
const lastMenuMsg = new Map<number, number>();  // user -> last (non-pinned) menu message id
const pinnedPosMsg = new Map<number, number>(); // user -> pinned "POSITION" message id

/** Show a menu: ALWAYS delete the previous non-pinned menu message, then send a fresh one. */
async function showMenu(ctx: any, text: string, extra?: any) {
  const uid = ctx.from.id;
  const pinned = pinnedPosMsg.get(uid);

  // delete previous menu (but never the pinned id)
  const prev = lastMenuMsg.get(uid);
  if (prev && (!pinned || prev !== pinned)) {
    try { await ctx.deleteMessage(prev); } catch { /* ignore */ }
  }

  const m = await ctx.reply(text, extra);
  lastMenuMsg.set(uid, m.message_id);
}

/** Post or replace a pinned "POSITION" card (delete + re-send to avoid edit overload typing) */
async function upsertPinnedPosition(ctx: any) {
  const uid = ctx.from.id;
  const u = getUserSettings(uid);
  const w = getActiveWallet(uid);
  if (!u?.token_address || !w) return;

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);

  try {
    const meta = await tokenMeta(u.token_address);
    const decimals = meta.decimals ?? 18;
    const c = erc20(u.token_address);
    const bal = await c.balanceOf(w.address);
    const q = bal > 0n ? await bestQuoteSell(bal, u.token_address) : null;

    const avg = getAvgEntry(uid, u.token_address, decimals);
    let pnlLine = '—';
    if (avg && q?.amountOut) {
      const curPls = Number(ethers.formatEther(q.amountOut));
      const curTok = Number(ethers.formatUnits(bal, decimals));
      const curAvg = curTok > 0 ? curPls / curTok : 0;
      const pnlPls = curPls - (avg.avgPlsPerToken * curTok);
      const pnlPct = avg.avgPlsPerToken > 0 ? (curAvg / avg.avgPlsPerToken - 1) * 100 : 0;
      pnlLine = `${pnlPls >= 0 ? '🟢' : '🔴'} ${NF.format(pnlPls)} PLS  (${NF.format(pnlPct)}%)`;
    }

    const text = [
      '📌 *POSITION*',
      `Token: ${u.token_address}${meta.symbol ? ` (${meta.symbol})` : ''}`,
      `Wallet: ${short(w.address)}`,
      `Holdings: ${fmtDec(ethers.formatUnits(bal, decimals))} ${meta.symbol || 'TOKEN'}`,
      q?.amountOut ? `Est. value: ${fmtPls(q.amountOut)} PLS  ·  Route: ${q.route.key}` : 'Est. value: —',
      avg ? `Entry: ${NF.format(avg.avgPlsPerToken)} PLS/token` : 'Entry: —',
      `Unrealized PnL: ${pnlLine}`,
    ].join('\n');

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Buy More', 'pin_buy'), Markup.button.callback('🔴 Sell', 'pin_sell')],
    ]);

    // delete old pinned message if we tracked one
    const existing = pinnedPosMsg.get(uid);
    if (existing) {
      try { await bot.telegram.deleteMessage(chatId, existing); } catch {}
    }

    const m = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...kb } as any);
    pinnedPosMsg.set(uid, m.message_id);
    try { await bot.telegram.pinChatMessage(chatId, m.message_id, { disable_notification: true } as any); } catch {}
  } catch { /* ignore */ }
}

/* ---------- utilities ---------- */
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

/* warm token meta + best route quote */
function warmTokenAsync(userId: number, address: string) {
  tokenMeta(address).catch(() => {});
  const amt = ethers.parseEther(String(getUserSettings(userId)?.buy_amount_pls ?? 0.01));
  bestQuoteBuy(amt, address).catch(() => {});
}

/* in-memory selections */
const selectedWallets = new Map<number, Set<number>>();
function getSelSet(uid: number) { let s = selectedWallets.get(uid); if (!s) { s = new Set<number>(); selectedWallets.set(uid, s); } return s; }
function chunk<T>(arr: T[], size = 6): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

/* --- parsing helpers --- */
function parseNumHuman(s: string): number | null {
  // accept $, spaces and commas
  const t = s.trim().toLowerCase().replace(/[\s,$]/g, '');
  const m = t.match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/);
  if (!m) return null;
  const n = Number(m[1]); if (!Number.isFinite(n)) return null;
  const suf = m[2];
  const mul = suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : 1;
  return n * mul;
}

/* ---------- pending prompts ---------- */
type Pending =
  | { type: 'set_amount' } | { type: 'set_token' } | { type: 'gen_name' } | { type: 'import_wallet' }
  | { type: 'withdraw'; walletId: number } | { type: 'set_gl' } | { type: 'set_gb' } | { type: 'set_defpct' }
  | { type: 'auto_amt' } | { type: 'lb_amt' } | { type: 'ls_pct' } | { type: 'limit_value' };
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
  await showMenu(ctx, lines, settingsMenu());
}

bot.action('settings', async (ctx) => { await ctx.answerCbQuery(); return renderSettings(ctx); });

bot.action('set_gl', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gl' });
  return showMenu(ctx, 'Send new Gas Limit (e.g., 300000).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]])
  });
});
bot.action('set_gb', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gb' });
  return showMenu(ctx, 'Send new Gwei Booster in gwei (e.g., 0.2).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]])
  });
});
bot.action('set_defpct', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_defpct' });
  return showMenu(ctx, 'Send Default Gas % over market (e.g., 10).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]])
  });
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
  return showMenu(ctx, 'Send Auto-buy amount in PLS (e.g., 0.5).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]])
  });
});

/* ---------- Wallets: list/manage ---------- */
async function renderWalletsList(ctx: any) {
  const rows = listWallets(ctx.from.id);
  if (!rows.length) {
    return showMenu(ctx, 'No wallets yet.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')],
        [Markup.button.callback('⬅️ Back', 'main_back')],
      ]));
  }
  const balances = await Promise.all(rows.map(w => getBalanceFast(w.address)));

  const lines = [
    'Your Wallets', '',
    'Address                              | Balance (PLS)',
    '-------------------------------------|----------------',
    ...rows.map((w, i) => `${w.address} | ${fmtPls(balances[i].value)}`),
    balances.some(b => !b.ok) ? '\n⚠️ Some balances didn’t load from the RPC. Use /rpc_check.' : ''
  ].filter(Boolean).join('\n');

  const kb = rows.map((w, i) => [
    Markup.button.callback(`${w.id}. ${short(w.address)}`, `wallet_manage:${w.id}`),
    Markup.button.callback(`${fmtPls(balances[i].value)} PLS`, 'noop'),
  ]);
  kb.push([Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')]);
  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);

  await showMenu(ctx, lines, Markup.inlineKeyboard(kb));
}

async function renderWalletManage(ctx: any, walletId: number) {
  const w = getWalletById(ctx.from.id, walletId);
  if (!w) return showMenu(ctx, 'Wallet not found.');
  const { value: bal, ok } = await getBalanceFast(w.address);
  const lines = [
    'Wallet', '',
    `ID: ${walletId}`,
    `Address: ${w.address}`,
    `Balance: ${fmtPls(bal)} PLS${ok ? '' : '  (RPC issue)'}`,
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Show Private Key', `wallet_pk:${walletId}`), Markup.button.callback('🔄 Refresh', `wallet_refresh:${walletId}`)],
    [Markup.button.callback('🧹 Clear Pending', `wallet_clear:${walletId}`), Markup.button.callback('🏧 Withdraw', `wallet_withdraw:${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove:${walletId}`), Markup.button.callback('⬅️ Back', 'wallets')],
  ]);

  await showMenu(ctx, lines, kb);
}

bot.action('wallets', async (ctx) => { await ctx.answerCbQuery(); return renderWalletsList(ctx); });
bot.action(/^wallet_manage:(\d+)$/, async (ctx: any) => { await ctx.answerCbQuery(); return renderWalletManage(ctx, Number(ctx.match[1])); });

/* PK */
bot.action(/^wallet_pk:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return showMenu(ctx, 'Wallet not found.');
  const masked = getPrivateKey(w).replace(/^(.{6}).+(.{4})$/, '$1…$2');
  return showMenu(ctx, `Private key (masked): ${masked}\nRevealing exposes full control of funds.`,
    Markup.inlineKeyboard([[Markup.button.callback('⚠️ Reveal', `wallet_pk_reveal:${id}`)], [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]));
});
bot.action(/^wallet_pk_reveal:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return showMenu(ctx, 'Wallet not found.');
  await ctx.reply(`PRIVATE KEY for ${short(w.address)}:\n\`${getPrivateKey(w)}\``, { parse_mode: 'Markdown' });
  return renderWalletManage(ctx, id);
});

/* Clear pending / Withdraw / Remove / Refresh */
bot.action(/^wallet_clear:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return showMenu(ctx, 'Wallet not found.');
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
  return showMenu(ctx, 'Reply with: `address amount_pls` (e.g., `0xabc... 0.5`)',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]));
});
bot.action(/^wallet_remove:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  return showMenu(ctx, `Remove wallet ID ${id}? This does NOT revoke keys on-chain.`,
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
  return showMenu(ctx, 'Send a name for the new wallet (e.g., `trader1`).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]])
  });
});
bot.action('wallet_add', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_wallet' });
  return showMenu(ctx, 'Reply: `name privkey` (e.g., `hot1 0x...`)', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]])
  });
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
    } catch {}
  }

  const lines = [
    'BUY MENU', '',
    `Wallet: ${aw ? aw.address : '— (Select)'}`,
    tokenLine, pairLine, '',
    `Amount in: ${fmtDec(String(amt))} PLS`,
    `Gas boost: +${NF.format(pct)}% over market`,
    `GL: ${fmtInt(String(gl))}  |  Booster: ${NF.format(gb)} gwei`, '',
    outLine,
  ].join('\n');

  const rows = listWallets(ctx.from.id);
  const sel = getSelSet(ctx.from.id);
  const walletButtons = chunk(
    rows.map((w, i) => Markup.button.callback(`${sel.has(w.id) ? '✅ ' : ''}W${i + 1}`, `wallet_toggle:${w.id}`)),
    6
  );

  await showMenu(ctx, lines, buyMenu(Math.round(pct), walletButtons));
}

bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });
bot.action('buy_refresh', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });

bot.action('buy_set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_amount' });
  return showMenu(ctx, 'Send amount in PLS (e.g., 0.05).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]])
  });
});
bot.action('buy_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_token' });
  return showMenu(ctx, 'Paste the token contract address (0x...).', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]])
  });
});

bot.action('gas_pct_open', async (ctx) => { await ctx.answerCbQuery(); return showMenu(ctx, 'Choose gas % over market:', buyGasPctMenu()); });
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

/* ----- Tx notifications: pending -> success (delete pending) ----- */
async function notifyPendingThenSuccess(ctx: any, kind: 'Buy'|'Sell', hash?: string) {
  if (!hash) return;
  const pendingMsg = await ctx.reply('✅ Transaction submitted');
  try {
    await provider.waitForTransaction(hash);
    try { await ctx.deleteMessage(pendingMsg.message_id); } catch {}
    const link = otter(hash);
    const title = kind === 'Buy' ? 'Buy Successfull' : 'Sell Successfull';
    await ctx.reply(`✅ ${title} ${link}`);
  } catch { /* leave pending if it fails/times out */ }
}

/* Buy using selected wallets (or active) + auto-approve + record entry + pin card */
bot.action('buy_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const active = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));

  const selIds = Array.from(getSelSet(ctx.from.id));
  const wallets = selIds.length
    ? listWallets(ctx.from.id).filter(w => selIds.includes(w.id))
    : (active ? [active] : []);
  if (!wallets.length) return showMenu(ctx, 'Select a wallet first (Wallets page).', buyMenu(u?.gas_pct ?? 0));

  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));
  const preQuote = await bestQuoteBuy(amountIn, u.token_address);

  for (const w of wallets) {
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      if (preQuote?.amountOut) recordTrade(ctx.from.id, w.address, u.token_address, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
      if (hash) notifyPendingThenSuccess(ctx, 'Buy', hash);

      if (u.token_address.toLowerCase() !== process.env.WPLS_ADDRESS!.toLowerCase()) {
        approveAllRouters(getPrivateKey(w), u.token_address, gas).catch(() => {});
      }
    } catch (e: any) {
      await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${e.message}`);
    }
  }

  await upsertPinnedPosition(ctx);
  return renderBuyMenu(ctx);
});

bot.action('buy_exec_all', async (ctx) => {
  await ctx.answerCbQuery();
  const rows = listWallets(ctx.from.id); const u = getUserSettings(ctx.from.id);
  if (!rows.length) return showMenu(ctx, 'No wallets.', buyMenu(u?.gas_pct ?? 0));
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));

  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));
  const preQuote = await bestQuoteBuy(amountIn, u.token_address);

  for (const row of rows) {
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(row), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      if (preQuote?.amountOut) recordTrade(ctx.from.id, row.address, u.token_address, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
      if (hash) notifyPendingThenSuccess(ctx, 'Buy', hash);

      if (u.token_address.toLowerCase() !== process.env.WPLS_ADDRESS!.toLowerCase()) {
        approveAllRouters(getPrivateKey(row), u.token_address, gas).catch(() => {});
      }
    } catch (e: any) {
      await ctx.reply(`❌ Buy failed for ${short(row.address)}: ${e.message}`);
    }
  }
  await upsertPinnedPosition(ctx);
  return renderBuyMenu(ctx);
});

/* ---------- LIMITS (create/list/cancel) ---------- */
type Draft = { side: 'BUY' | 'SELL'; walletId: number; token: string; amountPlsWei?: bigint; sellPct?: number; trigger?: 'PLS'|'USD'|'MCAP'|'MULT'; };
const draft = new Map<number, Draft>();

bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));
  if (!w) return showMenu(ctx, 'Select a wallet first.', buyMenu(u?.gas_pct ?? 0));
  draft.set(ctx.from.id, { side: 'BUY', walletId: w.id, token: u.token_address });
  pending.set(ctx.from.id, { type: 'lb_amt' });
  return showMenu(ctx, 'Send limit buy amount in PLS (e.g., 0.5, 1.2):');
});

bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', sellMenu());
  if (!w) return showMenu(ctx, 'Select a wallet first.', sellMenu());
  draft.set(ctx.from.id, { side: 'SELL', walletId: w.id, token: u.token_address });
  pending.set(ctx.from.id, { type: 'ls_pct' });
  return showMenu(ctx, 'What percent of your token to sell when triggered? (e.g., 25, 50, 100)');
});

bot.action(/^limit_trig:(PLS|USD|MCAP|MULT)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const d = draft.get(ctx.from.id);
  if (!d) return showMenu(ctx, 'Start a Limit Buy/Sell first.', mainMenu());
  const trig = ctx.match[1] as 'PLS'|'USD'|'MCAP'|'MULT';
  d.trigger = trig; draft.set(ctx.from.id, d);

  const ask = trig === 'PLS' ? 'Enter target PLS price per token (e.g., 0.0035):'
            : trig === 'USD' ? 'Enter target USD price per token (e.g., 0.0012):'
            : trig === 'MCAP' ? 'Enter target Market Cap in USD (supports k/m, e.g., 100k, 1m):'
            : 'Enter multiplier (e.g., 2 for 2× entry price):';
  pending.set(ctx.from.id, { type: 'limit_value' });
  return showMenu(ctx, ask);
});

bot.action('limit_list', async (ctx) => {
  await ctx.answerCbQuery();
  const rows = listLimitOrders(ctx.from.id);
  if (!rows.length) return showMenu(ctx, 'No limit orders yet.');
  const lines = rows.map((r: any) => {
    const base = `#${r.id} ${r.side} ${short(r.token_address)}  ${r.trigger_type}=${NF.format(r.trigger_value)}  [${r.status}]`;
    if (r.side === 'BUY' && r.amount_pls_wei) return `${base}  amt=${fmtDec(ethers.formatEther(BigInt(r.amount_pls_wei)))} PLS`;
    if (r.side === 'SELL' && r.sell_pct != null) return `${base}  ${r.sell_pct}%`;
    return base;
  });
  const kb = rows.filter((r: any) => r.status === 'OPEN')
    .map((r: any) => [Markup.button.callback(`❌ Cancel #${r.id}`, `limit_cancel:${r.id}`)]);
  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);
  return showMenu(ctx, lines.join('\n'), Markup.inlineKeyboard(kb));
});

bot.action(/^limit_cancel:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const changed = cancelLimitOrder(ctx.from.id, id);
  return showMenu(ctx, changed ? `Limit #${id} cancelled.` : `Couldn’t cancel #${id}.`, mainMenu());
});

/* ---------- SELL MENU (robust: no Markdown) ---------- */
async function renderSellMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  const pct = u?.sell_pct ?? 100;

  let header = '🟥 SELL MENU';
  let walletLine = `Wallet: ${w ? short(w.address) : '—'}`;
  let tokenLine  = `Token: ${u?.token_address ? short(u.token_address) : '—'}`;

  let balLine = '• Balance: —';
  let outLine = '• Est. Out: —';
  let entryLine = '• Entry: —';
  let pnlLine = '• Net PnL: —';
  let metaSymbol = 'TOKEN';

  if (w && u?.token_address) {
    try {
      const tokenAddr = u.token_address as string;

      const meta = await tokenMeta(tokenAddr);
      const dec = meta.decimals ?? 18;
      metaSymbol = meta.symbol || meta.name || 'TOKEN';

      const c = erc20(tokenAddr);
      const [bal, best] = await Promise.all([
        c.balanceOf(w.address),
        (async () => {
          const amt = await c.balanceOf(w.address);
          const sellAmt = (amt * BigInt(Math.round(pct))) / 100n;
          return (sellAmt > 0n) ? bestQuoteSell(sellAmt, tokenAddr) : null;
        })()
      ]);

      balLine = `• Balance: ${fmtDec(ethers.formatUnits(bal, dec))} ${metaSymbol}`;

      if (best) outLine = `• Est. Out: ${fmtPls(best.amountOut)} PLS  (Route: ${best.route.key})`;

      const avg = getAvgEntry(ctx.from.id, tokenAddr, dec);
      if (avg && best) {
        const amountIn = (bal * BigInt(Math.round(pct))) / 100n;
        const amtTok = Number(ethers.formatUnits(amountIn, dec));
        const curPls = Number(ethers.formatEther(best.amountOut));
        const curAvg = amtTok > 0 ? curPls / amtTok : 0;
        const pnlPls = curPls - (avg.avgPlsPerToken * amtTok);
        const pnlPct = avg.avgPlsPerToken > 0 ? (curAvg / avg.avgPlsPerToken - 1) * 100 : 0;

        entryLine = `• Entry: ${NF.format(avg.avgPlsPerToken)} PLS / ${metaSymbol}`;
        pnlLine   = `• Net PnL: ${pnlPls >= 0 ? '🟢' : '🔴'} ${NF.format(pnlPls)} PLS  (${NF.format(pnlPct)}%)`;
      }
    } catch { /* keep defaults */ }
  }

  const text = [
    header,
    '',
    `${walletLine}    |    ${tokenLine}`,
    `Sell %: ${NF.format(pct)}%`,
    '',
    balLine,
    outLine,
    entryLine,
    pnlLine,
  ].join('\n');

  await showMenu(ctx, text, sellMenu());
}

bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); return renderSellMenu(ctx); });
bot.action('sell_pct_25', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 25); return renderSellMenu(ctx); });
bot.action('sell_pct_50', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 50); return renderSellMenu(ctx); });
bot.action('sell_pct_75', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 75); return renderSellMenu(ctx); });
bot.action('sell_pct_100', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 100); return renderSellMenu(ctx); });

/* Sell ▸ Approve */
bot.action('sell_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id) || listWallets(ctx.from.id)[0];
  if (!w || !u?.token_address) return showMenu(ctx, 'Need a wallet and token set first.', sellMenu());
  if (u.token_address.toLowerCase() === process.env.WPLS_ADDRESS!.toLowerCase())
    return showMenu(ctx, 'WPLS doesn’t require approval.', sellMenu());
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
  if (!w || !u?.token_address) return showMenu(ctx, 'Need active wallet and token set.', sellMenu());
  try {
    const c = erc20(u.token_address);
    const bal = await c.balanceOf(w.address);
    const pct = u?.sell_pct ?? 100;
    const amount = (bal * BigInt(Math.round(pct))) / 100n;
    if (amount <= 0n) return showMenu(ctx, 'Nothing to sell.', sellMenu());

    const q = await bestQuoteSell(amount, u.token_address);      // for recording
    const gas = await computeGas(ctx.from.id);
    const r = await sellAutoRoute(getPrivateKey(w), u.token_address, amount, 0n, gas);
    const hash = (r as any)?.hash;

    if (q?.amountOut) recordTrade(ctx.from.id, w.address, u.token_address, 'SELL', q.amountOut, amount, q.route.key);
    if (hash) notifyPendingThenSuccess(ctx, 'Sell', hash);

  } catch (e: any) { await ctx.reply('Sell failed: ' + e.message); }
  await upsertPinnedPosition(ctx);
  return renderSellMenu(ctx);
});

/* ----- Pinned position: buttons ----- */
bot.action('pin_buy', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });
bot.action('pin_sell', async (ctx) => { await ctx.answerCbQuery(); return renderSellMenu(ctx); });

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

/* ---------- Quick MCAP debug ---------- */
const limitSkipNotified = new Set<number>();

async function pricePLSPerToken(token: string): Promise<number | null> {
  try {
    const meta = await tokenMeta(token);
    const dec = meta.decimals ?? 18;
    const one = ethers.parseUnits('1', dec);
    const q = await bestQuoteSell(one, token);
    if (!q) return null;
    return Number(ethers.formatEther(q.amountOut));
  } catch { return null; }
}

async function plsUSD(): Promise<number | null> {
  try {
    if (!STABLE || !/^0x[a-fA-F0-9]{40}$/.test(STABLE)) return null;
    const meta = await tokenMeta(STABLE);
    const q = await bestQuoteBuy(ethers.parseEther('1'), STABLE);
    if (!q) return null;
    return Number(ethers.formatUnits(q.amountOut, meta.decimals ?? 18));
  } catch { return null; }
}

async function totalSupply(token: string): Promise<bigint | null> {
  try { return await erc20(token).totalSupply(); } catch { return null; }
}

async function mcapFor(token: string): Promise<{
  ok: boolean;
  reason?: string;
  mcapUSD?: number;
  usdPerPLS?: number;
  plsPerToken?: number;
  supplyTokens?: number;
  decimals?: number;
}> {
  try {
    if (!STABLE || !/^0x[a-fA-F0-9]{40}$/.test(STABLE)) {
      return { ok: false, reason: 'No STABLE token address configured (USDC/USDCe). Set env USDC_ADDRESS/USDCe_ADDRESS/STABLE_ADDRESS.' };
    }
    const [usdPerPLS, plsPerToken, meta, sup] = await Promise.all([
      plsUSD(),
      pricePLSPerToken(token),
      tokenMeta(token),
      totalSupply(token),
    ]);

    if (usdPerPLS == null) return { ok: false, reason: 'Could not fetch USD/PLS (stable quote failed).' };
    if (plsPerToken == null) return { ok: false, reason: 'No sell route for token (price in PLS not available).' };
    if (!sup) return { ok: false, reason: 'Could not fetch totalSupply().' };

    const dec = meta.decimals ?? 18;
    const supplyTokens = Number(ethers.formatUnits(sup, dec));
    const usdPerToken = plsPerToken * usdPerPLS;
    const mcapUSD = supplyTokens * usdPerToken;

    return { ok: true, mcapUSD, usdPerPLS, plsPerToken, supplyTokens, decimals: dec };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

bot.command('mcap', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  const token = u?.token_address;
  if (!token) return ctx.reply('Set a token first.');
  const info = await mcapFor(token);
  if (!info.ok) return ctx.reply('MCAP check failed: ' + (info.reason ?? 'unknown'));
  const lines = [
    `Token: ${token}`,
    `Supply: ${NF.format(info.supplyTokens!)} tokens`,
    `Price: ${info.plsPerToken!.toFixed(8)} PLS / token`,
    `PLS→USD: ${info.usdPerPLS!.toFixed(6)} USD / PLS`,
    `MCAP: $${fmtInt(String(Math.round(info.mcapUSD!)))}`,
  ].join('\n');
  return ctx.reply(lines);
});

/* ---------- LIMIT ENGINE ---------- */
const LIMIT_CHECK_MS = Number(process.env.LIMIT_CHECK_MS ?? 15000);

async function checkLimitsOnce() {
  const rows = getOpenLimitOrders();
  if (!rows.length) return;

  const usd = await plsUSD();

  for (const r of rows) {
    try {
      const pPLS = await pricePLSPerToken(r.token_address);
      if (pPLS == null) continue;

      let should = false;

      if (r.trigger_type === 'PLS') {
        should = (r.side === 'BUY') ? (pPLS <= r.trigger_value) : (pPLS >= r.trigger_value);
      } else if (r.trigger_type === 'USD') {
        if (usd == null) continue;
        const pUSD = pPLS * usd;
        should = (r.side === 'BUY') ? (pUSD <= r.trigger_value) : (pUSD >= r.trigger_value);
      } else if (r.trigger_type === 'MCAP') {
        const info = await mcapFor(r.token_address);
        if (!info.ok) {
          if (!limitSkipNotified.has(r.id)) {
            limitSkipNotified.add(r.id);
            await bot.telegram.sendMessage(
              r.telegram_id,
              `ℹ️ Limit #${r.id} (MCAP) skipped: ${info.reason ?? 'unknown reason'}`
            );
          }
          continue;
        }
        const mcap = info.mcapUSD!;
        should = (r.side === 'BUY') ? (mcap <= r.trigger_value) : (mcap >= r.trigger_value);
      } else if (r.trigger_type === 'MULT') {
        const avg = getAvgEntry(r.telegram_id, r.token_address);
        if (!avg) continue;
        const target = avg.avgPlsPerToken * r.trigger_value;
        should = pPLS >= target;
      }

      if (!should) continue;

      const w = getWalletById(r.telegram_id, r.wallet_id);
      if (!w) { markLimitError(r.id, 'wallet missing'); continue; }
      const gas = await computeGas(r.telegram_id);

      if (r.side === 'BUY') {
        const amt = r.amount_pls_wei ? BigInt(r.amount_pls_wei) : 0n;
        if (amt <= 0n) { markLimitError(r.id, 'amount zero'); continue; }
        const rec = await buyAutoRoute(getPrivateKey(w), r.token_address, amt, 0n, gas);
        const hash = (rec as any)?.hash;
        markLimitFilled(r.id, hash);
        try {
          const pre = await bestQuoteBuy(amt, r.token_address);
          if (pre?.amountOut) recordTrade(r.telegram_id, w.address, r.token_address, 'BUY', amt, pre.amountOut, pre.route.key);
        } catch {}
        await bot.telegram.sendMessage(r.telegram_id, `✅ Limit BUY filled #${r.id}\n${hash ? otter(hash) : ''}`);
      } else {
        const c = erc20(r.token_address);
        const bal = await c.balanceOf(w.address);
        const pct = Math.max(1, Math.min(100, Number(r.sell_pct ?? 100)));
        const amount = (bal * BigInt(Math.round(pct))) / 100n;
        if (amount <= 0n) { markLimitError(r.id, 'balance zero'); continue; }

        const q = await bestQuoteSell(amount, r.token_address);
        const rec = await sellAutoRoute(getPrivateKey(w), r.token_address, amount, 0n, gas);
        const hash = (rec as any)?.hash;
        markLimitFilled(r.id, hash);
        if (q?.amountOut) recordTrade(r.telegram_id, w.address, r.token_address, 'SELL', q.amountOut, amount, q.route.key);
        await bot.telegram.sendMessage(r.telegram_id, `✅ Limit SELL filled #${r.id}\n${hash ? otter(hash) : ''}`);
      }
    } catch (e: any) {
      markLimitError(r.id, e?.message ?? String(e));
    }
  }
}

setInterval(() => { checkLimitsOnce().catch(() => {}); }, LIMIT_CHECK_MS);

/* ---------- shortcuts (Back + helpers) ---------- */
bot.action('main_back', async (ctx) => {
  await ctx.answerCbQuery();
  return showMenu(ctx, 'Main Menu', mainMenu());
});
bot.action('price', async (ctx) => {
  await ctx.answerCbQuery();
  return showMenu(ctx, 'Use /price after setting a token.', mainMenu());
});
bot.action('balances', async (ctx) => {
  await ctx.answerCbQuery();
  return showMenu(ctx, 'Use /balances after selecting a wallet.', mainMenu());
});

export {};
