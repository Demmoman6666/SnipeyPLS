// src/bot.ts
import './boot.js';
import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import { mainMenu, buyMenu, buyGasPctMenu, sellMenu, settingsMenu, limitTriggerMenu } from './keyboards.js';
import {
  listWallets, createWallet, importWallet, getActiveWallet, setToken, setGasBase, setGasPercent,
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
const WPLS = (process.env.WPLS_ADDRESS || '0xA1077a294dDE1B09bB078844df40758a5D0f9a27').toLowerCase(); // Pulse WPLS

/* ---- HTML escape + reply helper ---- */
const esc = (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function replyHTML(ctx: any, html: string, extra: any = {}) {
  return ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

/* ===== currency formatters ===== */
function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v >= 1e9)  return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6)  return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3)  return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}
function fmtUsdPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const maxDp = n < 0.01 ? 8 : 4;
  return '$' + n.toLocaleString('en-GB', { maximumFractionDigits: maxDp });
}

/* ===== Robust success card helpers (HTML-safe) ===== */
function groupThousands(intStr: string) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatUnitsDp(amount: bigint, decimals: number, dp: number): string {
  let s = ethers.formatUnits(amount, decimals);
  if (!s.includes('.')) return groupThousands(s);
  let [i, f] = s.split('.');
  if (dp < 0) dp = 0;
  if (f.length <= dp) return `${groupThousands(i)}.${f.padEnd(dp, '0')}`.replace(/\.$/, '');
  const keep = f.slice(0, dp);
  const next = Number(f[dp] ?? '0');
  if (next < 5) return dp ? `${groupThousands(i)}.${keep}` : groupThousands(i);
  if (dp === 0) return groupThousands((BigInt(i) + 1n).toString());
  let carry = 1;
  const arr = keep.split('').reverse();
  for (let idx = 0; idx < arr.length; idx++) {
    const d = Number(arr[idx]) + carry;
    if (d >= 10) { arr[idx] = '0'; carry = 1; } else { arr[idx] = String(d); carry = 0; break; }
  }
  let f2 = arr.reverse().join('');
  if (carry) i = (BigInt(i) + 1n).toString();
  return `${groupThousands(i)}.${f2}`;
}
function formatTinyDecimalStr(decStr: string): string {
  if (!decStr.includes('.')) return decStr;
  const [i, fRaw] = decStr.split('.');
  if (i !== '0') return decStr;
  const m = fRaw.match(/^(0+)(\d+)(.*)$/);
  if (!m) return decStr;
  const zeros = m[1].length;
  const firstRun = m[2];
  const first = firstRun[0];
  const subscriptDigits = '₀₁₂₃₄₅₆₇₈₉';
  const sub = String(zeros).replace(/\d/g, d => subscriptDigits[Number(d)]);
  return `0.0${sub}${first}`;
}
function bigDivToDecimal(n: bigint, d: bigint, precision = 20): string {
  if (d === 0n) return '0';
  const scale = 10n ** BigInt(precision);
  const q = (n * scale) / d;
  const intPart = q / scale;
  let frac = (q % scale).toString().padStart(precision, '0').replace(/0+$/, '');
  return frac ? `${intPart.toString()}.${frac}` : intPart.toString();
}

/* ---------- DexScreener helpers (price + liquidity + marketCap) ---------- */
const _fetchAny: any = (globalThis as any).fetch?.bind(globalThis);

type DSPair = {
  priceUsd?: string | number;
  liquidity?: { usd?: number | string };
  fdv?: number | string | null;
  marketCap?: number | string | null;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
};
type DSMetrics = { priceUSD: number | null; liquidityUSD: number | null; marketCapUSD: number | null };

async function fetchDexScreenerBestPair(token: string): Promise<DSPair | null> {
  if (!_fetchAny) return null;
  try {
    const resp = await _fetchAny(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!resp?.ok) return null;
    const j: any = await resp.json();
    const pairs: DSPair[] = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    // Pick highest-liquidity pair
    let best = pairs[0];
    for (const p of pairs) {
      const bL = Number((best?.liquidity as any)?.usd ?? 0);
      const pL = Number((p?.liquidity as any)?.usd ?? 0);
      if (pL > bL) best = p;
    }
    return best;
  } catch { return null; }
}

async function fetchDexScreener(token: string): Promise<DSMetrics> {
  const best = await fetchDexScreenerBestPair(token);
  if (!best) return { priceUSD: null, liquidityUSD: null, marketCapUSD: null };
  const priceUSD = best.priceUsd != null ? Number(best.priceUsd) : null;
  const liquidityUSD = (best.liquidity && (best.liquidity as any).usd != null)
    ? Number((best.liquidity as any).usd)
    : null;
  // DexScreener shows Market Cap when it knows circulating; otherwise FDV.
  let mcap = best.marketCap != null ? Number(best.marketCap) : null;
  if (mcap == null && best.fdv != null) mcap = Number(best.fdv);
  return { priceUSD, liquidityUSD, marketCapUSD: mcap };
}

// WPLS → USD via DexScreener (most liquid WPLS/* pair)
async function plsUSD_viaDex(): Promise<number | null> {
  const best = await fetchDexScreenerBestPair(WPLS);
  if (!best) return null;
  const v = best.priceUsd != null ? Number(best.priceUsd) : null;
  return Number.isFinite(v as any) ? (v as number) : null;
}

/* ---------- USD/PLS via stable route, with DexScreener fallback ---------- */
async function plsUSD(): Promise<number | null> {
  // Try on-chain route via configured stable
  try {
    if (STABLE && /^0x[a-fA-F0-9]{40}$/.test(STABLE)) {
      const meta = await tokenMeta(STABLE);
      const q = await bestQuoteBuy(ethers.parseEther('1'), STABLE); // 1 PLS -> stable
      if (q) return Number(ethers.formatUnits(q.amountOut, meta.decimals ?? 18));
    }
  } catch { /* fall through */ }
  // Fallback to DexScreener WPLS USD
  try { return await plsUSD_viaDex(); } catch { return null; }
}

/* ---------- trade success card ---------- */
type PostTradeArgs = {
  action: 'BUY' | 'SELL';
  spend: { amount: bigint; decimals: number; symbol: string };
  receive: { amount: bigint; decimals: number; symbol: string };
  tokenAddress: string;
  explorerUrl: string;
};

async function postTradeSuccess(ctx: any, args: PostTradeArgs) {
  const { action, spend, receive } = args;
  const nativeSymbol = 'PLS';
  const plsRaw18 = action === 'BUY'
    ? (spend.symbol === nativeSymbol ? spend.amount : 0n)
    : (receive.symbol === nativeSymbol ? receive.amount : 0n);
  const tokenRaw = action === 'BUY' ? receive.amount : spend.amount;
  const tokenDecimals = action === 'BUY' ? receive.decimals : spend.decimals;

  const pricePLS = (tokenRaw > 0n)
    ? bigDivToDecimal(plsRaw18 * (10n ** BigInt(tokenDecimals)), tokenRaw * (10n ** 18n), 20)
    : '0';

  let priceLine: string;
  const usdPerPls = await plsUSD().catch(() => null);
  if (usdPerPls != null) {
    const priceUSDnum = Number(pricePLS || '0') * usdPerPls;
    const priceUSDstr = priceUSDnum < 0.01
      ? formatTinyDecimalStr(String(priceUSDnum))
      : priceUSDnum.toLocaleString('en-GB', { maximumFractionDigits: 8 });
    priceLine = `📊 ${action[0]}${action.slice(1).toLowerCase()} Price: $${priceUSDstr}`;
  } else {
    const plsPretty = pricePLS.startsWith('0.')
      ? formatTinyDecimalStr(pricePLS)
      : pricePLS.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
    priceLine = `📊 ${action[0]}${action.slice(1).toLowerCase()} Price: ${plsPretty} PLS`;
  }

  const spendStr = `${formatUnitsDp(spend.amount, spend.decimals, 0)} ${spend.symbol}`;
  const receiveStr = `${formatUnitsDp(receive.amount, receive.decimals, 2)} ${receive.symbol}`;
  const line1 = action === 'BUY' ? '✅ Buy successful ✅' : '✅ Sell successful ✅';

  const body =
`${line1}

  💳 Spend: ${esc(spendStr)}
  💰 Received: ${esc(receiveStr)}
  ${priceLine}

🔗 <a href="${esc(args.explorerUrl)}">PulseScan</a>`;

  await replyHTML(ctx, body);
}
// === Branding + Home screen ===
const BRAND_NAME = process.env.BRAND_NAME || 'SNIPEY';
const BRAND_TWITTER = process.env.BRAND_TWITTER_URL || 'https://twitter.com/yourhandle';
const BRAND_TELEGRAM = process.env.BRAND_TELEGRAM_URL || 'https://t.me/yourchannel';

function homeScreenText() {
  const rule = '⎯'.repeat(34);
  return [
    `⚡️ <b>${esc(BRAND_NAME)} Bot</b>`,
    '',
    '🚀 Fastest Telegram trading bot on PulseChain network. Take advantage against other traders and snipe or trade tokens on PulseChain without leaving Telegram!',
    '',
    '<b>How To Start?</b>',
    '1️⃣ Generate a new wallet',
    '2️⃣ Fund your newly generated wallet with <b>$PLS</b>',
    '3️⃣ Trade or snipe tokens',
    '',
    `<a href="${esc(BRAND_TWITTER)}">Twitter</a>  •  <a href="${esc(BRAND_TELEGRAM)}">Telegram</a>`,
    rule,
    'You can also paste a <b>CA</b> to quickly interact with a token.',
    '',
    '<b>Features</b>',
    '• Super fast trading bot',
    '• Referral program',
    '• Limit orders',
    '• Auto-buy when contract address is pasted (toggle in Settings)',
  ].join('\n');
}

async function renderHome(ctx: any) {
  await showMenu(ctx, homeScreenText(), { parse_mode: 'HTML', disable_web_page_preview: true, ...mainMenu() });
}
/* ---------- message lifecycle ---------- */
const lastMenuMsg = new Map<number, number>();
const pinnedPosMsg = new Map<number, number>();
function canEdit(ctx: any) { return Boolean(ctx?.callbackQuery?.message?.message_id); }

async function showMenu(ctx: any, text: string, extra?: any) {
  const uid = ctx.from.id;
  const pinned = pinnedPosMsg.get(uid);
  const prev = lastMenuMsg.get(uid);

  if (prev && (!pinned || prev !== pinned)) {
    try { await ctx.deleteMessage(prev); } catch {}
  }

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const sourceId = ctx?.callbackQuery?.message?.message_id as number | undefined;
  if (sourceId && sourceId !== prev && (!pinned || sourceId !== pinned)) {
    try { await bot.telegram.deleteMessage(chatId, sourceId); } catch {}
  }

  const m = await ctx.reply(text, extra);
  lastMenuMsg.set(uid, m.message_id);
}

/** Pinned "POSITION" card */
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
      '📌 <b>POSITION</b>',
      `Token: <code>${esc(u.token_address)}</code>${meta.symbol ? ` (${esc(meta.symbol)})` : ''}`,
      `Wallet: <code>${esc(short(w.address))}</code>`,
      `Holdings: ${esc(fmtDec(ethers.formatUnits(bal, decimals)))} ${esc(meta.symbol || 'TOKEN')}`,
      q?.amountOut ? `Est. value: ${esc(fmtPls(q.amountOut))} PLS  ·  Route: ${esc(q.route.key)}` : 'Est. value: —',
      avg ? `Entry: ${esc(NF.format(avg.avgPlsPerToken))} PLS/token` : 'Entry: —',
      `Unrealized PnL: ${esc(pnlLine)}`,
    ].join('\n');

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Buy More', 'pin_buy'), Markup.button.callback('🔴 Sell', 'pin_sell')],
    ]);

    const existing = pinnedPosMsg.get(uid);
    if (existing) {
      try { await bot.telegram.deleteMessage(chatId, existing); } catch {}
    }

    const m = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...kb } as any);
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
  | { type: 'set_amount' } | { type: 'set_token' } | { type: 'set_token_sell' } | { type: 'gen_name' } | { type: 'import_wallet' }
  | { type: 'withdraw'; walletId: number } | { type: 'set_gl' } | { type: 'set_gb' } | { type: 'set_defpct' }
  | { type: 'auto_amt' } | { type: 'lb_amt' } | { type: 'ls_pct' } | { type: 'limit_value' };
const pending = new Map<number, Pending>();

/* ---------- /start ---------- */
bot.start(async (ctx) => { await showMenu(ctx, 'Main Menu', mainMenu()); });

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

bot.action('settings', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderSettings(ctx); });

bot.action('set_gl', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gl' });
  return showMenu(ctx, 'Send new *Gas Limit* (e.g., `300000`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});
bot.action('set_gb', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gb' });
  return showMenu(ctx, 'Send new *Gwei Booster* in gwei (e.g., `0.2`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
});
bot.action('set_defpct', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_defpct' });
  return showMenu(ctx, 'Send *Default Gas %* over market (e.g., `10`).', { parse_mode: 'Markdown',
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
  return showMenu(ctx, 'Send *Auto-buy amount* in PLS (e.g., `0.5`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) });
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

bot.action('wallets', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderWalletsList(ctx); });
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
  return showMenu(ctx, 'Send a name for the new wallet (e.g., `trader1`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});
bot.action('wallet_add', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_wallet' });
  return showMenu(ctx, 'Reply: `name privkey` (e.g., `hot1 0x...`)', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});

/* ---------- Price helpers used below ---------- */
async function pricePLSPerToken(token: string): Promise<number | null> {
  try {
    const meta = await tokenMeta(token);
    const dec = meta.decimals ?? 18;
    const one = ethers.parseUnits('1', dec);
    const q = await bestQuoteSell(one, token);
    if (!q) return null;
    return Number(ethers.formatEther(q.amountOut)); // PLS per 1 token
  } catch { return null; }
}
async function priceUSDPerToken(token: string): Promise<number | null> {
  // Prefer DexScreener price if available; fallback to on-chain PLS*USD
  const ds = await fetchDexScreener(token);
  if (ds.priceUSD != null) return ds.priceUSD;
  const [pPLS, usd] = await Promise.all([pricePLSPerToken(token), plsUSD()]);
  if (pPLS != null && usd != null) return pPLS * usd;
  return null;
}

/* ---------- BUY MENU ---------- */
async function renderBuyMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const aw = getActiveWallet(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  const pct = u?.gas_pct ?? (u?.default_gas_pct ?? 0);
  const gl = u?.gas_limit ?? 250000;
  const gb = u?.gwei_boost_gwei ?? 0;

  let tokenLine = 'Token: —';
  let pairLine = `Pair: ${process.env.WPLS_ADDRESS || '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'} (WPLS)`;
  let priceLine = '📈 Price: —';
  let mcapLine  = '💰 Market Cap: —';
  let liqLine   = '💧 Liquidity: —';
  let outLine = 'Amount out: unavailable';

  if (u?.token_address) {
    const tokenAddr = u.token_address as string;
    try {
      const meta = await tokenMeta(tokenAddr);
      tokenLine = `Token: ${tokenAddr} (${meta.symbol || meta.name || 'TOKEN'})`;

      const best = await bestQuoteBuy(ethers.parseEther(String(amt)), tokenAddr);
      if (best) {
        const dec = meta.decimals ?? 18;
        outLine = `Amount out: ${fmtDec(ethers.formatUnits(best.amountOut, dec))} ${meta.symbol || 'TOKEN'}   ·   Route: ${best.route.key}`;
      }

      const [ds, capFallback] = await Promise.all([
        fetchDexScreener(tokenAddr),
        mcapFor(tokenAddr),
      ]);

      const priceUsdVal = ds.priceUSD != null ? ds.priceUSD : await priceUSDPerToken(tokenAddr);
      priceLine = `📈 Price: ${fmtUsdPrice(priceUsdVal)}`;

      if (ds.marketCapUSD != null) {
        mcapLine = `💰 Market Cap: ${fmtUsdCompact(ds.marketCapUSD)} (DexScreener)`;
      } else if (capFallback.ok && capFallback.mcapUSD != null) {
        mcapLine = `💰 Market Cap: ${fmtUsdCompact(capFallback.mcapUSD)}`;
      }

      if (ds.liquidityUSD != null) {
        liqLine = `💧 Liquidity: ${fmtUsdCompact(ds.liquidityUSD)}`;
      }
    } catch {}
  }

  const lines = [
    'BUY MENU',
    '',
    `Wallet: ${aw ? aw.address : '— (Select)'}`,
    '',
    tokenLine,
    '',
    pairLine,
    '',
    priceLine,
    mcapLine,
    liqLine,
    '',
    `Amount in: ${fmtDec(String(amt))} PLS`,
    `Gas boost: +${NF.format(pct)}% over market`,
    `Gas limit: ${fmtInt(String(gl))}  |  Booster: ${NF.format(gb)} gwei`,
    '',
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

bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderBuyMenu(ctx); });
bot.action('buy_refresh', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });

bot.action('buy_set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_amount' });
  return showMenu(ctx, 'Send *amount in PLS* (e.g., `0.05`).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]) });
});
bot.action('buy_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_token' });
  return showMenu(ctx, 'Paste the *token contract address* (0x...).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]) });
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

/* ----- Tx notifications (kept for other flows) ----- */
async function notifyPendingThenSuccess(ctx: any, kind: 'Buy'|'Sell', hash?: string) {
  if (!hash) return;
  const pendingMsg = await ctx.reply('✅ Transaction submitted');
  try {
    await provider.waitForTransaction(hash);
    try { await ctx.deleteMessage(pendingMsg.message_id); } catch {}
    const link = otter(hash);
    const title = kind === 'Buy' ? 'Buy Successfull' : 'Sell Successfull';
    await ctx.reply(`✅ ${title} ${link}`);
  } catch {}
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

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));

  for (const w of wallets) {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);

    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(u.token_address);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, u.token_address);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, u.token_address, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (u.token_address.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), u.token_address, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: u.token_address!,   // assert non-null
            explorerUrl: link
          });
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent (no hash yet)`);
        } catch {}
      }
    } catch (e: any) {
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
      }
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

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const amountIn = ethers.parseEther(String(u?.buy_amount_pls ?? 0.01));

  for (const w of rows) {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), u.token_address, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(u.token_address);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, u.token_address);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, u.token_address, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (u.token_address.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), u.token_address, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: u.token_address!,   // assert non-null
            explorerUrl: link
          });
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent (no hash yet)`);
        } catch {}
      }
    } catch (e: any) {
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
      }
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
  return showMenu(ctx, 'Send *limit buy amount* in PLS (e.g., `0.5`, `1.2`):', { parse_mode: 'Markdown' });
});

bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', sellMenu());
  if (!w) return showMenu(ctx, 'Select a wallet first.', sellMenu());
  draft.set(ctx.from.id, { side: 'SELL', walletId: w.id, token: u.token_address });
  pending.set(ctx.from.id, { type: 'ls_pct' });
  return showMenu(ctx, 'What *percent* of your token to sell when triggered? (e.g., `25`, `50`, `100`)', { parse_mode: 'Markdown' });
});

bot.action(/^limit_trig:(PLS|USD|MCAP|MULT)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const d = draft.get(ctx.from.id);
  if (!d) return showMenu(ctx, 'Start a Limit Buy/Sell first.', mainMenu());
  const trig = ctx.match[1] as 'PLS'|'USD'|'MCAP'|'MULT';
  d.trigger = trig; draft.set(ctx.from.id, d);

  const ask = trig === 'PLS' ? 'Enter target **PLS price** per token (e.g., `0.0035`):'
            : trig === 'USD' ? 'Enter target **USD price** per token (e.g., `0.0012`):'
            : trig === 'MCAP' ? 'Enter target **Market Cap in USD** (supports `k`/`m`, e.g., `100k`, `1m`):'
            : 'Enter **multiplier** (e.g., `2` for 2× entry price):';
  pending.set(ctx.from.id, { type: 'limit_value' });
  return showMenu(ctx, ask, { parse_mode: 'Markdown' });
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

/* ---------- SELL MENU (HTML + metrics) ---------- */
async function renderSellMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  const pct = u?.sell_pct ?? 100;

  const tokenAddrFull: string | undefined = u?.token_address || undefined;

  const header = '🟥 <b>SELL MENU</b>';

  // Full addresses + line break between Wallet and Token
  let walletLine = `<b>Wallet:</b>\n<code>${w ? esc(w.address) : '—'}</code>`;
  let tokenLine  = `<b>Token:</b> ${tokenAddrFull ? `\n<code>${esc(tokenAddrFull)}</code>` : '—'}`;

  let priceLine = `📈 Price: —`;
  let mcapLine  = `💰 Market Cap: —`;
  let liqLine   = `💧 Liquidity: —`;

  let balLine = '• <b>Balance:</b> —';
  let outLine = '• <b>Est. Out:</b> —';
  let entryLine = '• <b>Entry:</b> —';
  let pnlLine = '• <b>Net PnL:</b> —';

  // We'll fill this so the header can show "(SYMBOL)" after the token address
  let metaSymbol = '';

  // Metrics (price/liquidity/mcap)
  if (tokenAddrFull) {
    try {
      const [ds, cap] = await Promise.all([
        fetchDexScreener(tokenAddrFull),
        mcapFor(tokenAddrFull),
      ]);
      const pUsd = await priceUSDPerToken(tokenAddrFull);
      priceLine = `📈 Price: ${fmtUsdPrice(pUsd)}`;
      if (ds.marketCapUSD != null) mcapLine = `💰 Market Cap: ${fmtUsdCompact(ds.marketCapUSD)} (DexScreener)`;
      else if (cap.ok && cap.mcapUSD != null) mcapLine = `💰 Market Cap: ${fmtUsdCompact(cap.mcapUSD)}`;
      if (ds.liquidityUSD != null) liqLine  = `💧 Liquidity: ${fmtUsdCompact(ds.liquidityUSD)}`;
    } catch { /* keep defaults */ }
  }

  // Balance, route, entry & PnL — also capture symbol for the header
  if (w && tokenAddrFull) {
    try {
      const meta = await tokenMeta(tokenAddrFull);
      const dec = meta.decimals ?? 18;
      metaSymbol = (meta.symbol || meta.name || '').toString();

      const c = erc20(tokenAddrFull);
      const [bal, best] = await Promise.all([
        c.balanceOf(w.address),
        (async () => {
          const amt = await c.balanceOf(w.address);
          const sellAmt = (amt * BigInt(Math.round(pct))) / 100n;
          return (sellAmt > 0n) ? bestQuoteSell(sellAmt, tokenAddrFull) : null;
        })()
      ]);

      balLine = `• <b>Balance:</b> ${esc(fmtDec(ethers.formatUnits(bal, dec)))} ${esc(metaSymbol || 'TOKEN')}`;

      if (best) outLine = `• <b>Est. Out:</b> ${esc(fmtPls(best.amountOut))} PLS  (Route: ${esc(best.route.key)})`;

      const avg = getAvgEntry(ctx.from.id, tokenAddrFull, dec);
      if (avg && best) {
        const amountIn = (bal * BigInt(Math.round(pct))) / 100n;
        const amtTok = Number(ethers.formatUnits(amountIn, dec));
        const curPls = Number(ethers.formatEther(best.amountOut));
        const curAvg = amtTok > 0 ? curPls / amtTok : 0;
        const pnlPls = curPls - (avg.avgPlsPerToken * amtTok);
        const pnlPct = avg.avgPlsPerToken > 0 ? (curAvg / avg.avgPlsPerToken - 1) * 100 : 0;

        entryLine = `• <b>Entry:</b> ${esc(NF.format(avg.avgPlsPerToken))} PLS / ${esc(metaSymbol || 'TOKEN')}`;
        pnlLine   = `• <b>Net PnL:</b> ${pnlPls >= 0 ? '🟢' : '🔴'} ${esc(NF.format(pnlPls))} PLS  (${esc(NF.format(pnlPct))}%)`;
      }
    } catch { /* keep defaults */ }
  }

  // Now that we know the symbol, update the token header line to include it
  if (tokenAddrFull) {
    tokenLine = `<b>Token:</b>\n<code>${esc(tokenAddrFull)}</code>${metaSymbol ? ` (${esc(metaSymbol)})` : ''}`;
  }

  // Compose — Wallet, blank line, Token, blank line, then metrics
  const text = [
    header,
    '',
    walletLine,
    '',
    tokenLine,
    '',               // ← extra blank line between TOKEN and PRICE (per your request)
    priceLine,
    mcapLine,
    liqLine,
    `<b>Sell %:</b> ${esc(NF.format(pct))}%`,
    '',
    balLine,
    outLine,
    entryLine,
    pnlLine,
  ].join('\n');

  await showMenu(ctx, text, { parse_mode: 'HTML', ...sellMenu() });
}

bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderSellMenu(ctx); });
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
  if (u.token_address.toLowerCase() === WPLS)
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

/* (optional button) Sell ▸ Set Token */
bot.action('sell_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_token_sell' });
  return showMenu(ctx, 'Paste the *token contract address* (0x...).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_sell')]]) });
});

/* ---------- SELL EXEC ---------- */
bot.action('sell_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!w || !u?.token_address) return showMenu(ctx, 'Need active wallet and token set.', sellMenu());

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const pendingMsg = await ctx.reply(`⏳ Sending sell for ${short(w.address)}…`);

  try {
    const c = erc20(u.token_address);
    const bal = await c.balanceOf(w.address);
    const pct = u?.sell_pct ?? 100;
    const amount = (bal * BigInt(Math.round(pct))) / 100n;

    if (amount <= 0n) {
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'Nothing to sell.');
      } catch {}
      await upsertPinnedPosition(ctx);
      return renderSellMenu(ctx);
    }

    const gas = await computeGas(ctx.from.id);
    const r = await sellAutoRoute(getPrivateKey(w), u.token_address, amount, 0n, gas);
    const hash = (r as any)?.hash;

    let outPls: bigint = 0n;
    let tokDec = 18;
    let tokSym = 'TOKEN';
    try {
      const meta = await tokenMeta(u.token_address);
      tokDec = meta.decimals ?? 18;
      tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
      const q = await bestQuoteSell(amount, u.token_address);
      if (q?.amountOut) {
        outPls = q.amountOut;
        recordTrade(ctx.from.id, w.address, u.token_address, 'SELL', q.amountOut, amount, q.route.key);
      }
    } catch {}

    if (hash) {
      const link = otter(hash);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
      } catch {
        await ctx.reply(`transaction sent ${link}`);
      }

      provider.waitForTransaction(hash).then(async () => {
        try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
        await postTradeSuccess(ctx, {
          action: 'SELL',
          spend:   { amount: amount,  decimals: tokDec, symbol: tokSym },
          receive: { amount: outPls,  decimals: 18,     symbol: 'PLS' },
          tokenAddress: u.token_address!,   // assert non-null
          explorerUrl: link
        });
      }).catch(() => {/* ignore */});
    } else {
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
      } catch {}
    }
  } catch (e: any) {
    try {
      await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Sell failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
    } catch {
      await ctx.reply(`❌ Sell failed for ${short(w.address)}: ${e?.message ?? String(e)}`);
    }
  }

  await upsertPinnedPosition(ctx);
  return renderSellMenu(ctx);
});

/* ---------- DIAGNOSTICS ---------- */
bot.command('rpc_check', async (ctx) => {
  const aw = getActiveWallet(ctx.from.id);
  const info = await pingRpc(aw?.address);
  const lines = [
    '<b>RPC Check</b>',
    `chainId: ${esc(String(info.chainId ?? '—'))}`,
    `block: ${esc(String(info.blockNumber ?? '—'))}`,
    `gasPrice(wei): ${esc(String(info.gasPrice ?? '—'))}`,
    `maxFeePerGas(wei): ${esc(String(info.maxFeePerGas ?? '—'))}`,
    `maxPriorityFeePerGas(wei): ${esc(String(info.maxPriorityFeePerGas ?? '—'))}`,
    `active wallet: ${esc(aw ? aw.address : '—')}`,
    `balance(wei): ${esc(String(info.balanceWei ?? '—'))}`,
    `${info.error ? 'error: ' + esc(String(info.error)) : ''}`,
  ].join('\n');
  await replyHTML(ctx, lines);
});

/* ---------- Explorer totalSupply fallbacks ---------- */
function explorerApiBase(): string | null {
  const b = (process.env.EXPLORER_API_BASE || '').trim();
  return b ? b.replace(/\/+$/, '') : null;
}
function withApiKey(url: string): string {
  const k = (process.env.EXPLORER_API_KEY || '').trim();
  return k ? url + (url.includes('?') ? '&' : '?') + 'apikey=' + encodeURIComponent(k) : url;
}
function explorerHeaders(): Record<string,string> {
  const k = (process.env.EXPLORER_API_KEY || '').trim();
  return k ? { 'X-API-KEY': k } : {};
}
async function fetchTotalSupplyViaExplorer(token: string): Promise<bigint | null> {
  if (!_fetchAny) return null;
  const baseIn = explorerApiBase();
  if (!baseIn) return null;

  const base = baseIn.replace(/\/+$/, '');
  const rootNoApi = base.replace(/\/api$/, '');

  // 1) Etherscan-style: /api?module=stats&action=tokensupply
  try {
    const url = withApiKey(`${base}?module=stats&action=tokensupply&contractaddress=${token}`);
    const r = await _fetchAny(url, { headers: explorerHeaders() });
    if (r?.ok) {
      const j: any = await r.json();
      const raw = j?.result ?? j?.data?.result;
      if (raw && /^\d+$/.test(String(raw))) return BigInt(String(raw));
    }
  } catch {}

  // 2) tokeninfo: /api?module=token&action=tokeninfo
  try {
    const url = withApiKey(`${base}?module=token&action=tokeninfo&contractaddress=${token}`);
    const r = await _fetchAny(url, { headers: explorerHeaders() });
    if (r?.ok) {
      const j: any = await r.json();
      const res = j?.result ?? j?.data?.result;
      const info = Array.isArray(res) ? res[0] : res;
      const raw = info?.totalSupply ?? info?.total_supply ?? info?.supply;
      if (raw && /^\d+$/.test(String(raw))) return BigInt(String(raw));
    }
  } catch {}

  // 3) modern REST: /api/v2/tokens/{token}
  try {
    const url = `${rootNoApi}/api/v2/tokens/${token}`;
    const r = await _fetchAny(url, { headers: explorerHeaders() });
    if (r?.ok) {
      const j: any = await r.json();
      const val =
        j?.total_supply ??
        j?.supply ??
        j?.data?.total_supply ??
        j?.data?.supply;

      if (typeof val === 'string') {
        if (/^0x[0-9a-fA-F]+$/.test(val)) return BigInt(val);
        if (/^\d+$/.test(val)) return BigInt(val);
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        return BigInt(Math.floor(val));
      }
    }
  } catch {}

  return null;
}
async function totalSupplyLowLevel(token: string): Promise<bigint | null> {
  try {
    const res = await provider.call({ to: token, data: '0x18160ddd' });
    if (!res || res === '0x') return null;
    return BigInt(res);
  } catch { return null; }
}
async function totalSupply(token: string): Promise<bigint | null> {
  try { return await erc20(token).totalSupply(); } catch {}
  try { const ll = await totalSupplyLowLevel(token); if (ll != null) return ll; } catch {}
  try { return await fetchTotalSupplyViaExplorer(token); } catch {}
  return null;
}

/* ---------- MCAP (on-chain) ---------- */
async function plsUSD_legacy(): Promise<number | null> { return plsUSD(); }

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
    // If STABLE not set, USD conversion will fall back to DexScreener via plsUSD()
    const [usdPerPLS, plsPerToken, meta, sup] = await Promise.all([
      plsUSD_legacy(),
      pricePLSPerToken(token),
      tokenMeta(token),
      totalSupply(token),
    ]);

    if (usdPerPLS == null) return { ok: false, reason: 'Could not fetch USD/PLS.' };
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

/* ---------- /mcap command (will match DexScreener when available) ---------- */
bot.command('mcap', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  const token = u?.token_address;
  if (!token) return ctx.reply('Set a token first.');

  // Prefer DexScreener’s marketCap/fdv for parity with their UI
  const ds = await fetchDexScreener(token);
  if (ds.marketCapUSD != null) {
    return ctx.reply(`DexScreener MCAP: ${fmtUsdCompact(ds.marketCapUSD)}  (raw: $${ds.marketCapUSD.toLocaleString()})`);
  }

  // Fallback to on-chain supply × price
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

// Tracks which limit ids have already been warned about MCAP unavailability
const limitSkipNotified = new Set<number>();
/* ---------- LIMIT ENGINE ---------- */
const LIMIT_CHECK_MS = Number(process.env.LIMIT_CHECK_MS ?? 15000);

// in-memory guards to prevent duplicate fills while a tx is in-flight
const limitProcessing = new Map<number, number>(); // id -> timestamp(ms)
function isProcessing(id: number) { return limitProcessing.has(id); }
function markProcessing(id: number) { limitProcessing.set(id, Date.now()); }
function unmarkProcessing(id: number) { limitProcessing.delete(id); }
// clean out old entries every minute (5-minute TTL safety)
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of limitProcessing) if (now - t > 5 * 60_000) limitProcessing.delete(id);
}, 60_000);

// Use DexScreener MCAP when present; fallback to on-chain
async function mcapUSDForTriggers(token: string): Promise<number | null> {
  const ds = await fetchDexScreener(token);
  if (ds.marketCapUSD != null) return ds.marketCapUSD;
  const on = await mcapFor(token);
  if (on.ok && on.mcapUSD != null) return on.mcapUSD;
  return null;
}

async function checkLimitsOnce() {
  const rows = getOpenLimitOrders();
  if (!rows.length) return;

  for (const r of rows) {
    // hard de-dupe: if we already started firing this id, skip
    if (isProcessing(r.id)) continue;

    try {
      const pPLS = await pricePLSPerToken(r.token_address);
      if (pPLS == null) continue;

      let should = false;

      if (r.trigger_type === 'PLS') {
        should = (r.side === 'BUY') ? (pPLS <= r.trigger_value) : (pPLS >= r.trigger_value);
      } else if (r.trigger_type === 'USD') {
        const pUSD = await priceUSDPerToken(r.token_address);
        if (pUSD == null) continue;
        should = (r.side === 'BUY') ? (pUSD <= r.trigger_value) : (pUSD >= r.trigger_value);
      } else if (r.trigger_type === 'MCAP') {
        const mcap = await mcapUSDForTriggers(r.token_address);
        if (mcap == null) {
          if (!limitSkipNotified.has(r.id)) {
            limitSkipNotified.add(r.id);
            await bot.telegram.sendMessage(
              r.telegram_id,
              `ℹ️ Limit #${r.id} (MCAP) skipped: Could not resolve Market Cap.`
            );
          }
          continue;
        }
        should = (r.side === 'BUY') ? (mcap <= r.trigger_value) : (mcap >= r.trigger_value);
      } else if (r.trigger_type === 'MULT') {
        const avg = getAvgEntry(r.telegram_id, r.token_address);
        if (!avg) continue;
        const target = avg.avgPlsPerToken * r.trigger_value;
        should = pPLS >= target;
      }

      if (!should) continue;

      // mark as processing so subsequent ticks don't fire again
      markProcessing(r.id);

      const w = getWalletById(r.telegram_id, r.wallet_id);
      if (!w) { unmarkProcessing(r.id); markLimitError(r.id, 'wallet missing'); continue; }

      const gas = await computeGas(r.telegram_id);

      // minimal ctx shim so we can reuse the same success card
      const ctxShim: any = {
        reply: (html: string, extra: any = {}) =>
          bot.telegram.sendMessage(r.telegram_id, html, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
      };

      if (r.side === 'BUY') {
        const amtIn = r.amount_pls_wei ? BigInt(r.amount_pls_wei) : 0n;
        if (amtIn <= 0n) { unmarkProcessing(r.id); markLimitError(r.id, 'amount zero'); continue; }

        // Pre-resolve some metadata for the success card & record
        let preOut: bigint = 0n;
        let tokDec = 18;
        let tokSym = 'TOKEN';
        try {
          const meta = await tokenMeta(r.token_address);
          tokDec = meta.decimals ?? 18;
          tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
          const pre = await bestQuoteBuy(amtIn, r.token_address);
          if (pre?.amountOut) {
            preOut = pre.amountOut;
            recordTrade(r.telegram_id, w.address, r.token_address, 'BUY', amtIn, pre.amountOut, pre.route.key);
          }
        } catch {}

        const rec = await buyAutoRoute(getPrivateKey(w), r.token_address, amtIn, 0n, gas);
        const hash = (rec as any)?.hash;

        // mark filled in DB immediately to avoid refiring
        markLimitFilled(r.id, hash);

        if (hash) {
          const link = otter(hash);
          const sentMsg = await bot.telegram.sendMessage(r.telegram_id, `transaction sent ${link}`);
          provider.waitForTransaction(hash).then(async () => {
            try { await bot.telegram.deleteMessage(r.telegram_id, sentMsg.message_id); } catch {}
            await postTradeSuccess(ctxShim, {
              action: 'BUY',
              spend:   { amount: amtIn, decimals: 18, symbol: 'PLS' },
              receive: { amount: preOut, decimals: tokDec, symbol: tokSym },
              tokenAddress: r.token_address,
              explorerUrl: link
            });
            unmarkProcessing(r.id);
          }).catch(() => { unmarkProcessing(r.id); });
        } else {
          await bot.telegram.sendMessage(r.telegram_id, `transaction sent (no hash yet)`);
          unmarkProcessing(r.id);
        }

      } else {
        // SELL
        const c = erc20(r.token_address);
        const bal = await c.balanceOf(w.address);
        const pct = Math.max(1, Math.min(100, Number(r.sell_pct ?? 100)));
        const amount = (bal * BigInt(Math.round(pct))) / 100n;
        if (amount <= 0n) { unmarkProcessing(r.id); markLimitError(r.id, 'balance zero'); continue; }

        // Pre-quote for record + success card fields
        let outPls: bigint = 0n;
        let tokDec = 18;
        let tokSym = 'TOKEN';
        try {
          const meta = await tokenMeta(r.token_address);
          tokDec = meta.decimals ?? 18;
          tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
          const q = await bestQuoteSell(amount, r.token_address);
          if (q?.amountOut) {
            outPls = q.amountOut;
            recordTrade(r.telegram_id, w.address, r.token_address, 'SELL', q.amountOut, amount, q.route.key);
          }
        } catch {}

        const rec = await sellAutoRoute(getPrivateKey(w), r.token_address, amount, 0n, gas);
        const hash = (rec as any)?.hash;

        markLimitFilled(r.id, hash);

        if (hash) {
          const link = otter(hash);
          const sentMsg = await bot.telegram.sendMessage(r.telegram_id, `transaction sent ${link}`);
          provider.waitForTransaction(hash).then(async () => {
            try { await bot.telegram.deleteMessage(r.telegram_id, sentMsg.message_id); } catch {}
            await postTradeSuccess(ctxShim, {
              action: 'SELL',
              spend:   { amount,  decimals: tokDec, symbol: tokSym },
              receive: { amount: outPls, decimals: 18,     symbol: 'PLS' },
              tokenAddress: r.token_address,
              explorerUrl: link
            });
            unmarkProcessing(r.id);
          }).catch(() => { unmarkProcessing(r.id); });
        } else {
          await bot.telegram.sendMessage(r.telegram_id, `transaction sent (no hash yet)`);
          unmarkProcessing(r.id);
        }
      }
    } catch (e: any) {
      unmarkProcessing(r.id);
      markLimitError(r.id, e?.message ?? String(e));
    }
  }
}

setInterval(() => { checkLimitsOnce().catch(() => {}); }, LIMIT_CHECK_MS);

/* ---------- TEXT: prompts + auto-detect address ---------- */
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

    if (p.type === 'set_token_sell') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(msg)) return ctx.reply('That does not look like a token address.');
      setToken(ctx.from.id, msg);
      warmTokenAsync(ctx.from.id, msg);
      pending.delete(ctx.from.id);
      return renderSellMenu(ctx);
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
      const w = getWalletById(ctx.from.id, (p as any).walletId); if (!w) { pending.delete(ctx.from.id); return ctx.reply('Wallet not found.'); }
      try {
        const gas = await computeGas(ctx.from.id);
        const receipt = await withdrawPls(getPrivateKey(w), to, ethers.parseEther(String(amount)), gas);
        const hash = (receipt as any)?.hash;
        await ctx.reply(hash ? `Withdraw sent! ${otter(hash)}` : 'Withdraw sent! (pending)');
      } catch (e: any) { await ctx.reply('Withdraw failed: ' + e.message); }
      pending.delete(ctx.from.id);
      return renderWalletManage(ctx, (p as any).walletId);
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

    // Limit order building
    if (p.type === 'lb_amt') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v <= 0) return ctx.reply('Send a positive number of PLS (e.g., 0.5).');
      const d = draft.get(ctx.from.id); if (!d) { pending.delete(ctx.from.id); return ctx.reply('Start again with Limit Buy.'); }
      d.amountPlsWei = ethers.parseEther(String(v));
      draft.set(ctx.from.id, d);
      pending.delete(ctx.from.id);
      return showMenu(ctx, 'Choose a trigger:', limitTriggerMenu('BUY'));
    }

    if (p.type === 'ls_pct') {
      const v = Number(msg);
      if (!Number.isFinite(v) || v <= 0 || v > 100) return ctx.reply('Send a percent between 1 and 100.');
      const d = draft.get(ctx.from.id); if (!d) { pending.delete(ctx.from.id); return ctx.reply('Start again with Limit Sell.'); }
      d.sellPct = v; draft.set(ctx.from.id, d);
      pending.delete(ctx.from.id);
      return showMenu(ctx, 'Choose a trigger:', limitTriggerMenu('SELL'));
    }

    if (p.type === 'limit_value') {
      const d = draft.get(ctx.from.id);
      if (!d || !d.trigger) { pending.delete(ctx.from.id); return ctx.reply('Start a Limit order first.'); }
      const val = parseNumHuman(msg);
      if (val == null || !(val > 0)) return ctx.reply('Send a positive number (supports `k`/`m`).');

      const id = addLimitOrder({
        telegramId: ctx.from.id,
        walletId: d.walletId,
        token: d.token,
        side: d.side,
        amountPlsWei: d.side === 'BUY' ? (d.amountPlsWei ?? ethers.parseEther('0')) : undefined,
        sellPct: d.side === 'SELL' ? (d.sellPct ?? 100) : undefined,
        trigger: d.trigger!,
        value: val
      });

      draft.delete(ctx.from.id);
      pending.delete(ctx.from.id);
      await ctx.reply(`Limit ${d.side} #${id} created: ${d.trigger} @ ${NF.format(val)} ${d.side === 'BUY' ? `for ${fmtDec(ethers.formatEther((d.amountPlsWei ?? 0n)))} PLS` : `${d.sellPct}%`}`);
      if (d.side === 'BUY') return renderBuyMenu(ctx);
      return renderSellMenu(ctx);
    }

    return;
  }

  // Auto-detect token address when no prompt is active (powers auto-buy)
  const text = String(ctx.message.text).trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    setToken(ctx.from.id, text);
    warmTokenAsync(ctx.from.id, text);

    const u = getUserSettings(ctx.from.id);
    if (u?.auto_buy_enabled) {
      const w = getActiveWallet(ctx.from.id);
      if (!w) { await ctx.reply('Select or create a wallet first.'); return renderBuyMenu(ctx); }

      const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
      const amountIn = ethers.parseEther(String(u.auto_buy_amount_pls ?? 0.01));

      const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);

      try {
        const gas = await computeGas(ctx.from.id);
        const r = await buyAutoRoute(getPrivateKey(w), text, amountIn, 0n, gas);
        const hash = (r as any)?.hash;

        let preOut: bigint = 0n;
        let tokDec = 18;
        let tokSym = 'TOKEN';

        if (hash) {
          const link = otter(hash);

          try {
            await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
          } catch {
            await ctx.reply(`transaction sent ${link}`);
          }

          try {
            const meta = await tokenMeta(text);
            tokDec = meta.decimals ?? 18;
            tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
            const preQuote = await bestQuoteBuy(amountIn, text);
            if (preQuote?.amountOut) {
              preOut = preQuote.amountOut;
              recordTrade(ctx.from.id, w.address, text, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
            }
          } catch {}

          try {
            if (text.toLowerCase() !== WPLS) {
              approveAllRouters(getPrivateKey(w), text, gas).catch(() => {});
            }
          } catch {}

          provider.waitForTransaction(hash).then(async () => {
            try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
            await postTradeSuccess(ctx, {
              action: 'BUY',
              spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
              receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
              tokenAddress: text,
              explorerUrl: link
            });
          }).catch(() => {/* ignore */});
        } else {
          try {
            await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
          } catch {}
        }
      } catch (e: any) {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Auto-buy failed: ${e?.message ?? String(e)}`);
        } catch {
          await ctx.reply(`❌ Auto-buy failed: ${e?.message ?? String(e)}`);
        }
      }

      await upsertPinnedPosition(ctx);
      return renderBuyMenu(ctx);
    } else {
      return renderBuyMenu(ctx);
    }
  }

  return next();
});

/* ---------- shortcuts ---------- */
bot.action('main_back', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return showMenu(ctx, 'Main Menu', mainMenu()); });
bot.action('price', async (ctx) => { await ctx.answerCbQuery(); return showMenu(ctx, 'Use /price after setting a token.', mainMenu()); });
bot.action('balances', async (ctx) => { await ctx.answerCbQuery(); return showMenu(ctx, 'Use /balances after selecting a wallet.', mainMenu()); });

// no-op
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

export {};
