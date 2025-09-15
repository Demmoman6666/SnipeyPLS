// src/bot.ts
import './boot.js';
import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import {
  mainMenu,
  buyMenu,
  buyGasPctMenu,
  sellMenu,
  settingsMenu,
  limitTriggerMenu,
  // ✅ added this:
  snipeMenu,
} from './keyboards.js';
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
  setReferrerOnce,
  // ✅ NEW imports for referral payout storage
  getReferralPayout, setReferralPayout,
} from './db.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

/* ---------- helpers / formatting ---------- */
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });
const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const fmtInt = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDec = (s: string) => {
  const [i, d] = s.split('.');
  return d ? `${fmtInt(i)}.${d}` : fmtInt(i);
};
const fmtPls = (wei: bigint) => fmtDec(ethers.formatEther(wei));
const otter = (hash?: string) => (hash ? `https://otter.pulsechain.com/tx/${hash}` : '');
const STABLE = (process.env.USDC_ADDRESS || process.env.USDCe_ADDRESS || process.env.STABLE_ADDRESS || '').toLowerCase();
const WPLS = (process.env.WPLS_ADDRESS || '0xA1077a294dDE1B09bB078844df40758a5D0f9a27').toLowerCase(); // Pulse WPLS

/* ---------- Step 1: Avg Entry overlay (instant PnL after buy) ---------- */
/**
 * We keep a lightweight, in-memory overlay of average entry for (user, token)
 * so the Sell menu can show Entry + PnL immediately after a buy — even before
 * any async DB readers catch up.
 */
type AvgOverlayRec = {
  tokens: number;          // cumulative tokens bought (since process start)
  plsSpent: number;        // cumulative PLS spent for those tokens
  avgPlsPerToken: number;  // derived = plsSpent / tokens
};

// uid -> (tokenLower -> rec)
const _avgEntryOverlay = new Map<number, Map<string, AvgOverlayRec>>();

function _overlayMap(uid: number) {
  let m = _avgEntryOverlay.get(uid);
  if (!m) { m = new Map<string, AvgOverlayRec>(); _avgEntryOverlay.set(uid, m); }
  return m;
}
function _overlayGet(uid: number, token: string) {
  return _overlayMap(uid).get(token.toLowerCase()) || null;
}
function _overlaySet(uid: number, token: string, rec: AvgOverlayRec) {
  _overlayMap(uid).set(token.toLowerCase(), rec);
}

/* --- Avg entry cache helper (wraps getAvgEntry) ---
   (Adds a tiny Map cache behind the overlay to avoid repeated DB work.) */
const _avgEntryCache = new Map<string, { avgPlsPerToken: number }>();
function _avgKey(uid: number, token: string, dec?: number) {
  return `${uid}:${token.toLowerCase()}:${dec ?? 'd'}`;
}

/**
 * Bump the overlay immediately after a BUY.
 * Also invalidates the small cache for this (uid, token, dec).
 * @param uid        Telegram user id
 * @param token      token address
 * @param plsInWei   PLS spent (wei)
 * @param outTokWei  tokens received (token units, wei with token decimals)
 * @param dec        token decimals
 */
function bumpAvgAfterBuy(uid: number, token: string, plsInWei: bigint, outTokWei: bigint, dec: number) {
  // convert to JS numbers for quick math (display precision use-case)
  const addPls = Number(ethers.formatEther(plsInWei));
  const addTok = Number(ethers.formatUnits(outTokWei, dec));
  if (!(addPls > 0) || !(addTok > 0)) return;

  const prev = _overlayGet(uid, token);
  const tokens = (prev?.tokens ?? 0) + addTok;
  const plsSpent = (prev?.plsSpent ?? 0) + addPls;
  const avgPlsPerToken = tokens > 0 ? (plsSpent / tokens) : 0;

  _overlaySet(uid, token, { tokens, plsSpent, avgPlsPerToken });

  // Invalidate cached DB aggregate for this key so future reads stay fresh
  _avgEntryCache.delete(_avgKey(uid, token, dec));
}

/**
 * Wrapper you can use instead of raw recordTrade in BUY flows.
 * - Writes the trade to DB
 * - Updates the in-memory avg-entry overlay so PnL shows instantly
 */
async function recordBuyAndCache(
  telegramId: number,
  walletAddress: string,
  token: string,
  amountInPlsWei: bigint,
  amountOutTokenWei: bigint,
  routeKey: string,
  tokenDecimals: number
) {
  try {
    // Persist (same shape as before)
    recordTrade(telegramId, walletAddress, token, 'BUY', amountInPlsWei, amountOutTokenWei, routeKey);
  } finally {
    // Always bump overlay so UI reflects the new average immediately
    bumpAvgAfterBuy(telegramId, token, amountInPlsWei, amountOutTokenWei, tokenDecimals);
  }
}

/**
 * Preferred getter for Avg Entry.
 * 1) Return the live overlay if present (instant after-buy view)
 * 2) Else return a cached DB aggregate if present
 * 3) Else compute via getAvgEntry(...) and cache it
 */
function getAvgEntryCached(uid: number, token: string, decimals?: number) {
  const overlay = _overlayGet(uid, token);
  if (overlay) return { avgPlsPerToken: overlay.avgPlsPerToken };

  const key = _avgKey(uid, token, decimals);
  const hit = _avgEntryCache.get(key);
  if (hit) return hit;

  const v = getAvgEntry(uid, token, decimals ?? 18);
  if (v) _avgEntryCache.set(key, v);
  return v;
}

// 🔗 Address helpers
const addrExplorer = (addr: string) => `https://otter.pulsechain.com/address/${addr}`;

// Primary: paste address into the input field (tap = ready to copy/send)
const copyAddrBtn = (addr: string, label = '📋 Copy') =>
  Markup.button.switchToCurrentChat(label, addr);

// Explorer button (open address on the block explorer)
const explorerAddrBtn = (addr: string, label = '🔍 Explorer') =>
  Markup.button.url(label, addrExplorer(addr));

// Fallback copy (used automatically if you keep it in keyboards or want both)
const copyAddrFallbackBtn = (addr: string, label = '📋 Copy') =>
  Markup.button.callback(label, `copy:${addr.toLowerCase()}`);

// Fallback handler: sends a copyable code block (no link previews)
bot.action(/^copy:(0x[a-fA-F0-9]{40})$/, async (ctx: any) => {
  await ctx.answerCbQuery('Address sent below');
  const addr = ctx.match[1];
  return ctx.reply(`Address:\n\`${addr}\``, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true }
  } as any);
});
/* ---------- Referral: config + helpers ---------- */
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const REF_PREFIX = 'ref_';
function buildRefLink(telegramId: number): string {
  if (!BOT_USERNAME) return '';
  return `https://t.me/${BOT_USERNAME}?start=${REF_PREFIX}${telegramId}`;
}
function parseRefPayload(payload?: string | null): number | null {
  if (!payload) return null;
  const p = payload.trim();
  let m = p.match(new RegExp(`^${REF_PREFIX}(\\d{4,15})$`, 'i'));
  if (!m) m = p.match(/^(\d{4,15})$/); // allow bare number too
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}
async function sendRefNudgeTo(telegramId: number) {
  const link = buildRefLink(telegramId);
  if (!link) return;
  const kb = Markup.inlineKeyboard([[Markup.button.url('🔗 Your Referral Link', link)]]);
  try {
    await bot.telegram.sendMessage(
      telegramId,
      `🤝 Referral program\nShare your personal invite link:\n${link}`,
      kb as any
    );
  } catch { /* ignore */ }
}

/* ---- HTML escape + reply helper ---- */
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function replyHTML(ctx: any, html: string, extra: any = {}) {
  return ctx.reply(html, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra
  } as any);
}

/* ===== currency formatters ===== */
function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v >= 1e9) return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
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
    rule,
    'You can also paste a <b>CA</b> to quickly interact with a token.',
    '',
    '<b>Features</b>',
    '⚡️ Super fast trading bot',
    '🤝 Referral program',
    '🎯 Limit orders',
    '🤖 Auto-buy when contract address is pasted (toggle in Settings)',
    '',
    rule,
    `<a href="${esc(BRAND_TWITTER)}">Twitter</a>  •  <a href="${esc(BRAND_TELEGRAM)}">Telegram</a>`,
  ].join('\n');
}

async function renderHome(ctx: any) {
  await showMenu(ctx, homeScreenText(), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...mainMenu()
  } as any);
}

/* ---------- REFERRALS MENU ---------- */
async function renderReferrals(ctx: any) {
  const link = buildRefLink(ctx.from.id);
  const payout = (await getReferralPayout(ctx.from.id)) || '— not set —';

  const lines = [
    '🤝 <b>REFERRALS</b>',
    '',
    '<b>Your invite link</b>',
    link ? `<code>${esc(link)}</code>` : '— set BOT_USERNAME in env to enable links —',
    '',
    '<b>Rewards payout wallet</b>',
    `<code>${esc(payout)}</code>`,
    '',
    'Rewards are sent to your payout wallet. You can change it any time.',
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    ...(link ? [[Markup.button.url('🔗 Open Link', link)]] : []),
    [Markup.button.callback('🏦 Set Payout Wallet', 'ref_set_payout')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);

  await showMenu(ctx, lines, {   parse_mode: 'HTML',   link_preview_options: { is_disabled: true },   ...kb } as any);
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
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

async function getBalanceFast(address: string): Promise<{ value: bigint; ok: boolean }> {
  try {
    const v = await withTimeout(provider.getBalance(address));
    return { value: v, ok: true };
  } catch {
    return { value: 0n, ok: false };
  }
}

async function computeGas(
  telegramId: number,
  extraPct = 0
): Promise<{ maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gasLimit: bigint }> {
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

/* ➕ Per-user wallet numbering helper (shows 1,2,3… for each user's list) */
function displayNumberForWallet(uid: number, walletId: number): number {
  const rows = listWallets(uid);
  const idx = rows.findIndex(w => w.id === walletId);
  return idx >= 0 ? idx + 1 : walletId; // fallback to DB id if not found
}

/* warm token meta + best route quote */
function warmTokenAsync(userId: number, address: string) {
  tokenMeta(address).catch(() => {});
  const amt = ethers.parseEther(String(getUserSettings(userId)?.buy_amount_pls ?? 0.01));
  bestQuoteBuy(amt, address).catch(() => {});
}

/* in-memory selections */
const selectedWallets = new Map<number, Set<number>>();
function getSelSet(uid: number) {
  let s = selectedWallets.get(uid);
  if (!s) { s = new Set<number>(); selectedWallets.set(uid, s); }
  return s;
}

/* ---------- SNIPE UI state (menu-only; not persisted) ---------- */
type SnipeUIState = {
  /** Trigger type chosen in the Snipe menu */
  trigger: 'ADD_LIQUIDITY' | 'METHOD' | null;
  /** Optional function selector to watch when trigger === 'METHOD' (e.g., "0xf305d719") */
  methodSelector?: string;
  /** Single tx per selected wallet vs batch strategy */
  mode: 'single' | 'batch';
  /** Selected wallet IDs for this user in the Snipe menu */
  wallets: Set<number>;
};

const snipeUIState = new Map<number, SnipeUIState>();

function getSnipeState(uid: number): SnipeUIState {
  let st = snipeUIState.get(uid);
  if (!st) {
    st = { trigger: null, mode: 'single', wallets: new Set<number>() };
    snipeUIState.set(uid, st);
  }
  return st;
}

function getSnipeSelSet(uid: number): Set<number> {
  return getSnipeState(uid).wallets;
}

function toggleSnipeWallet(uid: number, walletId: number) {
  const set = getSnipeState(uid).wallets;
  if (set.has(walletId)) set.delete(walletId); else set.add(walletId);
}

function clearSnipeWallets(uid: number) {
  getSnipeState(uid).wallets.clear();
}

function setSnipeMode(uid: number, mode: 'single' | 'batch') {
  getSnipeState(uid).mode = mode;
}

function setSnipeTrigger(uid: number, trig: 'ADD_LIQUIDITY' | 'METHOD' | null) {
  getSnipeState(uid).trigger = trig;
  if (trig !== 'METHOD') getSnipeState(uid).methodSelector = undefined;
}

function setSnipeMethodSelector(uid: number, selector?: string) {
  // Accept 4-byte selector like "0xdeadbeef"
  if (selector && /^0x[0-9a-fA-F]{8}$/.test(selector)) {
    getSnipeState(uid).methodSelector = selector.toLowerCase();
  } else if (!selector) {
    getSnipeState(uid).methodSelector = undefined;
  } else {
    // leave invalid input untouched; caller can validate before calling
  }
}

/* small array chunker for laying out inline keyboards */
function chunk<T>(arr: T[], size = 6): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  | { type: 'set_amount' }
  | { type: 'set_token' }
  | { type: 'set_token_sell' }
  | { type: 'gen_name' }
  | { type: 'import_wallet' }
  | { type: 'withdraw'; walletId: number }
  | { type: 'set_gl' }
  | { type: 'set_gb' }
  | { type: 'set_defpct' }
  | { type: 'auto_amt' }
  | { type: 'lb_amt' }
  | { type: 'ls_pct' }
  | { type: 'limit_value' }
  // ✅ NEW pending type for referral payout wallet input
  | { type: 'ref_payout' }
  // ✅ NEW: edit menus
  | { type: 'edit_qb'; idx: number }   // editing Quick-Buy button at index 0..5
  | { type: 'edit_sp'; idx: number }   // editing Sell % preset at index 0..3
  // ✅ NEW: custom slippage input (Step 2)
  | { type: 'slip_custom' }
  // ✅ Snipe wizard steps
  | { type: 'snipe_token' }
  | { type: 'snipe_amt' }
  | { type: 'snipe_liq' }
  // ✅ NEW: Snipe "Method" selector input (expects 4-byte selector like 0xf305d719)
  | { type: 'snipe_method' }
  | { type: 'auto_slip_custom' };

const pending = new Map<number, Pending>();

/* ---------- /start (capture referrer) ---------- */
bot.start(async (ctx) => {
  // Extract payload after /start
  const raw = String(ctx.message?.text ?? '');
  const m = raw.match(/^\/start(?:@[\w_]+)?\s+(.+)$/i);
  const payload = (m ? m[1] : '').trim();
  const refId = parseRefPayload(payload);

  if (refId && refId !== ctx.from.id) {
    try { await setReferrerOnce(ctx.from.id, refId); } catch { /* ignore */ }
  }

  // Just render home — no auto referral message here anymore
  await renderHome(ctx);
});

/* ---------- Handy: /ref shows the personal link ---------- */
bot.command('ref', async (ctx) => {
  const link = buildRefLink(ctx.from.id);
  if (!link) return ctx.reply('Set BOT_USERNAME in env to enable referral links.');
  const kb = Markup.inlineKeyboard([[Markup.button.url('🔗 Open Link', link)]]);
  return ctx.reply(`Your personal referral link:\n${link}`, kb as any);
});

/* ---------- REFERRALS: actions ---------- */
// Open the referrals menu from the main menu button (callback data must be 'referrals')
bot.action('referrals', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  return renderReferrals(ctx);
});

// Start "set payout wallet" flow from the referrals menu
bot.action('ref_set_payout', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'ref_payout' });
  return showMenu(
    ctx,
    'Send the <b>PLS wallet address</b> to receive referral rewards (format: <code>0x...</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'referrals')]]) }
  );
});

// Optional: refresh button inside referrals menu (prevents callback timeout)
bot.action('ref_refresh', async (ctx) => {
  await ctx.answerCbQuery();
  return renderReferrals(ctx);
});

/* ---------- SETTINGS (with ON/OFF emoji) ---------- */

// Per-user Auto-Buy wallet selection (in-memory)
const autoBuySelected = new Map<number, Set<number>>();
function getAutoSelSet(uid: number) {
  let s = autoBuySelected.get(uid);
  if (!s) { s = new Set<number>(); autoBuySelected.set(uid, s); }
  return s;
}

async function renderSettings(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const defPct  = u?.default_gas_pct ?? 0;
  const curGL   = u?.gas_limit ?? 250000;
  const curGB   = u?.gwei_boost_gwei ?? 0;
  const autoOn  = !!u?.auto_buy_enabled;
  const autoAmt = u?.auto_buy_amount_pls ?? 0.01;
  const autoEmoji = autoOn ? '🟢' : '🔴';

  // NEW: show current Auto-Buy slippage label (uses helpers from your slippage row)
  const autoSlipLabel = fmtAutoSlipLabel(ctx.from.id);

  const lines = [
    '⚙️ <b>SETTINGS</b>',
    '',
    '<b>Gas Settings</b>',
    `• Default Gas %: <code>${NF.format(defPct)}</code>%`,
    `• Gas Limit: <code>${fmtInt(String(curGL))}</code>`,
    `• Gwei Booster: <code>${NF.format(curGB)}</code> gwei`,
    '',
    '<b>Auto Buy</b>',
    `• Status: <b>${autoEmoji} ${autoOn ? 'ON' : 'OFF'}</b>`,
    `• Amount: <code>${fmtDec(String(autoAmt))}</code> PLS`,
    `• Auto-Buy Slippage: <b>${autoSlipLabel}</b>`,
    '',
    '<b>Auto-Buy Wallets</b>',
    'Select wallets that should participate when Auto-Buy triggers.',
  ].join('\n');

  // Wallet toggles: ✅ W1, W2 … (per-user list order)
  const rows = listWallets(ctx.from.id);
  const sel = getAutoSelSet(ctx.from.id);
  const walletButtons = chunk(
    rows.map((w, i) =>
      Markup.button.callback(`${sel.has(w.id) ? '✅ ' : ''}W${i + 1}`, `auto_wallet_toggle:${w.id}`)
    ),
    6
  );

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Back', 'main_back')],

    [Markup.button.callback('— Gas Settings —', 'noop')],
    [Markup.button.callback('Default Gas %', 'set_defpct')],
    [Markup.button.callback('Gas Limit', 'set_gl'), Markup.button.callback('Gwei Booster', 'set_gb')],

    [Markup.button.callback('— Auto Buy —', 'noop')],
    [Markup.button.callback(`${autoEmoji} Auto-Buy: ${autoOn ? 'ON' : 'OFF'}`, 'auto_toggle')],
    [Markup.button.callback('Auto Buy Amount', 'auto_amt')],
    // NEW: Auto-Buy Slippage picker (opens the same-style slippage menu just for auto-buys)
    [Markup.button.callback(`Auto-Buy Slippage (${fmtAutoSlipLabel(ctx.from.id)})`, 'auto_slip_open')],

    // 👇 Quick Buy / Sell editor section
    [Markup.button.callback('— Edit Quick Buy / Sell —', 'noop')],
    [Markup.button.callback('🟢 Edit Buy Buttons', 'edit_qb_open'), Markup.button.callback('🔴 Edit Sell %', 'edit_sellpct_open')],

    [Markup.button.callback('— Wallets —', 'noop')],
    ...walletButtons,
  ]);

  await showMenu(ctx, lines, { parse_mode: 'HTML', ...kb });
}

// Open Settings
bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  return renderSettings(ctx);
});

// Gas: set gas limit
bot.action('set_gl', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gl' });
  return showMenu(
    ctx,
    'Send new <b>Gas Limit</b> (e.g., <code>300000</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) }
  );
});

// Gas: set gwei booster
bot.action('set_gb', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_gb' });
  return showMenu(
    ctx,
    'Send new <b>Gwei Booster</b> in gwei (e.g., <code>0.2</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) }
  );
});

// Gas: set default gas %
bot.action('set_defpct', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_defpct' });
  return showMenu(
    ctx,
    'Send <b>Default Gas %</b> over market (e.g., <code>10</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) }
  );
});

// Auto-Buy: toggle
bot.action('auto_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  setAutoBuyEnabled(ctx.from.id, !(u?.auto_buy_enabled ?? 0));
  return renderSettings(ctx);
});

// Auto-Buy: amount
bot.action('auto_amt', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'auto_amt' });
  return showMenu(
    ctx,
    'Send <b>Auto-Buy amount</b> in PLS (e.g., <code>0.5</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings')]]) }
  );
});

// Auto-Buy: wallet selection toggles
bot.action(/^auto_wallet_toggle:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const s = getAutoSelSet(ctx.from.id);
  if (s.has(id)) s.delete(id); else s.add(id);
  return renderSettings(ctx);
});

/* ---------- Wallets: list/manage ---------- */
async function renderWalletsList(ctx: any) {
  const rows = listWallets(ctx.from.id);
  if (!rows.length) {
    return showMenu(
      ctx,
      '<b>No wallets yet.</b>',
      { parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')],
          [Markup.button.callback('⬅️ Back', 'main_back')],
        ])
      }
    );
  }

  const balances = await Promise.all(rows.map(w => getBalanceFast(w.address)));
  const lines = [
    '👛 <b>Your Wallets</b>',
    '',
    ...rows.map((w, i) => `W${i + 1} • <code>${w.address}</code>\nBalance: ${fmtPls(balances[i].value)} PLS`),
    balances.some(b => !b.ok) ? '\n⚠️ Some balances didn’t load from the RPC. Use /rpc_check.' : ''
  ].filter(Boolean).join('\n');

  const kb = rows.map((w, i) => [
    Markup.button.callback(`W${i + 1} • Manage`, `wallet_manage:${w.id}`),
    Markup.button.callback('📋 Copy', `copy:${w.address.toLowerCase()}`),
    Markup.button.url('🔍 Explorer', addrExplorer(w.address)),
  ]);

  kb.push([Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')]);
  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);

  await showMenu(ctx, lines, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
}

async function renderWalletManage(ctx: any, walletId: number) {
  const w = getWalletById(ctx.from.id, walletId);
  if (!w) return showMenu(ctx, 'Wallet not found.');
  const { value: bal, ok } = await getBalanceFast(w.address);

  const lines = [
    '👛 <b>Wallet</b>',
    '',
    `<b>ID:</b> ${walletId}`,
    `<b>Address:</b>\n<code>${w.address}</code>`,
    `<b>Balance:</b> ${fmtPls(bal)} PLS${ok ? '' : '  (RPC issue)'}`,
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Show Private Key', `wallet_pk:${walletId}`), Markup.button.callback('🔄 Refresh', `wallet_refresh:${walletId}`)],
    [Markup.button.callback('🧹 Clear Pending', `wallet_clear:${walletId}`), Markup.button.callback('🏧 Withdraw', `wallet_withdraw:${walletId}`)],
    // Copy + Explorer row (reliable copy via callback)
    [Markup.button.callback('📋 Copy', `copy:${w.address.toLowerCase()}`), Markup.button.url('🔍 Explorer', addrExplorer(w.address))],
    [Markup.button.callback('🗑 Remove', `wallet_remove:${walletId}`), Markup.button.callback('⬅️ Back', 'wallets')],
  ]);

  await showMenu(ctx, lines, { parse_mode: 'HTML', ...kb });
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
  return showMenu(
    ctx,
    `Private key (masked): ${masked}\nRevealing exposes full control of funds.`,
    Markup.inlineKeyboard([[Markup.button.callback('⚠️ Reveal', `wallet_pk_reveal:${id}`)], [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]])
  );
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
  return showMenu(ctx, 'Reply with: address amount_pls (e.g., 0xabc... 0.5)',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]));
});
bot.action(/^wallet_remove:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  return showMenu(
    ctx,
    `Remove wallet ID ${id}? This does NOT revoke keys on-chain.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Confirm Remove', `wallet_remove_confirm:${id}`)],
      [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)],
    ])
  );
});

bot.action(/^wallet_remove_confirm:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);

  try {
    removeWallet(ctx.from.id, id);

    // also unselect this wallet if it was selected in the multi-buy UI
    const sel = selectedWallets.get(ctx.from.id);
    if (sel) sel.delete(id);

    await ctx.reply('Wallet removed.');
  } catch (e: any) {
    await ctx.reply('Failed to remove wallet: ' + (e?.message ?? 'unknown error'));
  }

  return renderWalletsList(ctx);
});
bot.action(/^wallet_refresh:(\d+)$/, async (ctx: any) => { await ctx.answerCbQuery(); return renderWalletManage(ctx, Number(ctx.match[1])); });

/* Generate / Import prompts */
bot.action('wallet_generate', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'gen_name' });
  return showMenu(ctx, 'Send a name for the new wallet (e.g., trader1).', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});
bot.action('wallet_add', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_wallet' });
  return showMenu(ctx, 'Reply: name privkey (e.g., hot1 0x...)', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]) });
});

/* ---------- Error compactor (short, human-friendly) ---------- */
function conciseError(err: any): string {
  const code = String(err?.code ?? '').toUpperCase();

  const raw =
    err?.error?.message ||
    err?.info?.error?.message ||
    err?.shortMessage ||
    err?.reason ||
    err?.message ||
    '';

  const msg = String(raw).toLowerCase();

  if (code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds')) return 'insufficient funds';
  if (msg.includes('nonce too low') || msg.includes('already been used') || code === 'NONCE_EXPIRED')
    return 'nonce too low / already used';
  if ((msg.includes('replacement') && (msg.includes('underpriced') || msg.includes('fee too low'))) ||
      code === 'REPLACEMENT_UNDERPRICED')
    return 'replacement underpriced (raise gas)';
  if (code === 'UNPREDICTABLE_GAS_LIMIT' || msg.includes('cannot estimate gas') || msg.includes('gas required exceeds allowance'))
    return 'cannot estimate gas';
  if (msg.includes('intrinsic gas too low')) return 'gas limit too low';
  if (msg.includes('insufficient allowance')) return 'insufficient allowance (approve first)';
  if (msg.includes('execution reverted')) return 'execution reverted';
  if (msg.includes('user rejected') || code === 'ACTION_REJECTED') return 'user rejected';

  const firstLine = String(raw).split('\n')[0].trim();
  return firstLine ? firstLine.slice(0, 140) : 'failed';
}

/* ---------- Quick-Buy helpers (labels + parser) ---------- */
const QB_DEFAULTS = ['250K','500K','1M','2M','4M','5M'];
const quickBuyLabels = new Map<number, string[]>(); // uid -> 6 labels

function getQuickLabels(uid: number): string[] {
  const v = quickBuyLabels.get(uid);
  return (v && v.length === 6) ? v : QB_DEFAULTS;
}

/** Turn "250k"/"1m" into a plain PLS number string (no decimals) */
function kmbToPls(label: string): string {
  const t = (label || '').trim().toLowerCase().replace(/[, _]/g, '');
  const m = t.match(/^(\d+)(k|m|b)?$/i);
  if (!m) return '0';
  const num = BigInt(m[1]);
  const suf = (m[2] || '').toLowerCase();
  const mul = suf === 'k' ? 1_000n : suf === 'm' ? 1_000_000n : suf === 'b' ? 1_000_000_000n : 1n;
  return (num * mul).toString();
}

/* ---------- Editable Quick-Buy labels & Sell % presets ---------- */

// Update a single Quick-Buy label for a user (keeps K/M/B visible in UI)
function setQuickLabel(uid: number, idx: number, label: string) {
  const norm = String(label).trim().toUpperCase();
  const cur = [...getQuickLabels(uid)];
  if (idx >= 0 && idx < 6) cur[idx] = norm;
  quickBuyLabels.set(uid, cur);
}

// Sell % presets (per user)
const SELL_PRESETS_DEFAULT = [25, 50, 75, 100];
const sellPctPresets = new Map<number, number[]>();

function getSellPresets(uid: number): number[] {
  const v = sellPctPresets.get(uid);
  return (v && v.length === 4) ? v : SELL_PRESETS_DEFAULT;
}

function setSellPreset(uid: number, idx: number, pct: number) {
  const cur = [...getSellPresets(uid)];
  if (idx >= 0 && idx < 4) cur[idx] = Math.max(1, Math.min(100, Math.round(pct)));
  sellPctPresets.set(uid, cur);
}

/* ---------- Settings ▸ Edit menus ---------- */

// Open: Edit Quick Buy buttons
bot.action('edit_qb_open', async (ctx) => {
  await ctx.answerCbQuery();
  const labels = getQuickLabels(ctx.from.id);
  const title = '🟢 <b>Edit Quick Buy Buttons</b>\nTap a button to change its label (supports K/M/B).';
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${labels[0]} PLS`, 'edit_qb_idx:0'),
      Markup.button.callback(`${labels[1]} PLS`, 'edit_qb_idx:1'),
      Markup.button.callback(`${labels[2]} PLS`, 'edit_qb_idx:2'),
    ],
    [
      Markup.button.callback(`${labels[3]} PLS`, 'edit_qb_idx:3'),
      Markup.button.callback(`${labels[4]} PLS`, 'edit_qb_idx:4'),
      Markup.button.callback(`${labels[5]} PLS`, 'edit_qb_idx:5'),
    ],
    [Markup.button.callback('⬅️ Back', 'settings')],
  ]);
  return showMenu(ctx, title, { parse_mode: 'HTML', ...kb });
});

// Choose which quick-buy button to edit → ask for new label
bot.action(/^edit_qb_idx:(\d)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  pending.set(ctx.from.id, { type: 'edit_qb', idx });
  return showMenu(
    ctx,
    `Send new label for button #${idx + 1} (e.g., <code>250k</code>, <code>1m</code>, <code>500000</code>).`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'edit_qb_open')]]) }
  );
});

// Open: Edit Sell % presets
bot.action('edit_sellpct_open', async (ctx) => {
  await ctx.answerCbQuery();
  const arr = getSellPresets(ctx.from.id);
  const title = '🔴 <b>Edit Sell % Presets</b>\nTap a preset to change it (1–100).';
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${arr[0]}%`, 'edit_sp_idx:0'),
      Markup.button.callback(`${arr[1]}%`, 'edit_sp_idx:1'),
      Markup.button.callback(`${arr[2]}%`, 'edit_sp_idx:2'),
      Markup.button.callback(`${arr[3]}%`, 'edit_sp_idx:3'),
    ],
    [Markup.button.callback('⬅️ Back', 'settings')],
  ]);
  return showMenu(ctx, title, { parse_mode: 'HTML', ...kb });
});

// Choose which Sell % to edit → ask for number
bot.action(/^edit_sp_idx:(\d)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  pending.set(ctx.from.id, { type: 'edit_sp', idx });
  return showMenu(
    ctx,
    `Send new percent for preset #${idx + 1} (1–100).`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'edit_sellpct_open')]]) }
  );
});

/* swallow clicks for "unclickable" labels */
bot.action('noop', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} });

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

  // Wallet line with tap-to-copy (HTML)
  const walletLine = `Wallet: ${aw
    ? `<a href="tg://copy?text=${encodeURIComponent(aw.address)}"><code>${esc(aw.address)}</code></a>`
    : '— (Select)'}`;

  const lines = [
    'BUY MENU',
    '',
    walletLine,
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

  // Base keyboard + HTML
  const base = buyMenu(Math.round(pct), walletButtons) as any;
  const extra: any = { parse_mode: 'HTML', ...(base || {}) };

  // Ensure inline keyboard present
  extra.reply_markup = extra.reply_markup || {};
  const kb: any[][] = (extra.reply_markup.inline_keyboard || []) as any[][];

  // 🎯 Insert Slippage row (near the Gas % row if found, else at top)
  const slipRow = [Markup.button.callback(`🎯 Slippage (${fmtSlipLabel(ctx.from.id)})`, 'slip_open_buy')];
  const gasRowIdx = kb.findIndex(row =>
    row?.some?.((b: any) => String(b?.text || '').toLowerCase().includes('gas %'))
  );
  if (gasRowIdx >= 0) {
    kb.splice(gasRowIdx + 1, 0, slipRow);
  } else {
    kb.unshift(slipRow);
  }

  // Inject the Quick-Buy section just above the "Amount" row if present
  const amountRowIdx = kb.findIndex(row =>
    row?.some?.((b: any) =>
      String(b?.text || '').toLowerCase().includes('amount') ||
      String(b?.callback_data || '').startsWith('buy_set_amount')
    )
  );

  const labels = getQuickLabels(ctx.from.id).map(l => `${l} PLS`);
  const qbLabelRow = [Markup.button.callback('BUY AMOUNT / METHOD', 'noop')];
  const qbRow1 = [
    Markup.button.callback(labels[0], 'buy_qb:0'),
    Markup.button.callback(labels[1], 'buy_qb:1'),
    Markup.button.callback(labels[2], 'buy_qb:2'),
  ];
  const qbRow2 = [
    Markup.button.callback(labels[3], 'buy_qb:3'),
    Markup.button.callback(labels[4], 'buy_qb:4'),
    Markup.button.callback(labels[5], 'buy_qb:5'),
  ];

  if (amountRowIdx >= 0) {
    kb.splice(amountRowIdx, 0, qbLabelRow, qbRow1, qbRow2);
  } else {
    // fallback: put it near the top if we can't find the Amount row
    kb.unshift(qbLabelRow, qbRow1, qbRow2);
  }
  extra.reply_markup.inline_keyboard = kb;

  await showMenu(ctx, lines, extra);
}

/* ---------- SNIPE: models, state, helpers ---------- */
type SnipeDraft = {
  token?: string;
  amountPlsWei?: bigint;
  minLiqUsd?: number | null;

  // NEW
  onAddLiquidity?: boolean;          // if true, only fire when liquidity appears for the first time
  method?: string | null;            // optional function signature or 4-byte selector (not enforced by engine here)
  txMode?: 'single' | 'batch';       // UI preference only (engine currently fans out to all selected wallets)
};

type SnipeJob = {
  id: number;
  telegramId: number;
  token: string;
  amountPlsWei: bigint;
  minLiqUsd: number | null;
  armed: boolean;
  createdAt: number;

  // NEW (persisted on job)
  onAddLiquidity: boolean;
  method?: string | null;
  txMode?: 'single' | 'batch';
};

let snipeIdSeq = 1;
const snipeDraft = new Map<number, SnipeDraft>(); // uid -> draft
const snipeJobs  = new Map<number, SnipeJob[]>(); // uid -> jobs

// NEW: per-job baseline liquidity snapshot to detect “first appearance”
const snipeBaseLiqUSD = new Map<number, number | null>(); // jobId -> baseline (null/0 means "no route/liquidity" at baseline)

function jobsFor(uid: number): SnipeJob[] {
  const arr = snipeJobs.get(uid) ?? [];
  snipeJobs.set(uid, arr);
  return arr;
}
function addSnipe(
  job: Omit<SnipeJob, 'id' | 'createdAt' | 'armed'> & { armed?: boolean }
): SnipeJob {
  // pull out the possibly-conflicting keys so they don't appear in ...rest
  const { onAddLiquidity, method, txMode, armed, ...rest } = job as any;

  const full: SnipeJob = {
    id: snipeIdSeq++,
    createdAt: Date.now(),
    armed: armed ?? true,

    // everything else from the caller
    ...rest,

    // set the normalized values exactly once
    onAddLiquidity: !!onAddLiquidity,
    method: method ?? null,
    txMode: txMode ?? 'single',
  };

  jobsFor(full.telegramId).push(full);
  return full;
}
function removeSnipe(uid: number, id: number): boolean {
  const arr = jobsFor(uid);
  const idx = arr.findIndex(j => j.id === id);
  if (idx >= 0) {
    arr.splice(idx, 1);
    // clean baseline snapshot to avoid leaks
    snipeBaseLiqUSD.delete(id);
    return true;
  }
  return false;
}
function briefAddr(a: string) { return a.slice(0, 6) + '…' + a.slice(-4); }
function snipeSummary(j: SnipeJob) {
  const trig = j.onAddLiquidity ? 'onAddLiq' : 'route';
  const liq  = j.minLiqUsd != null ? `minLiq ${fmtUsdCompact(j.minLiqUsd)}` : 'no liq req';
  const meth = j.method ? ` • meth(${j.method.startsWith('0x') ? j.method : 'sig'})` : '';
  return `#${j.id} ${briefAddr(j.token)}  •  ${fmtDec(ethers.formatEther(j.amountPlsWei))} PLS  •  ${liq}  •  ${trig}${meth}  •  ${j.armed ? '🟢 ARMED' : '🟡 PAUSED'}`;
}

/* ---------- SNIPE MENU ---------- */
async function renderSnipeMenu(ctx: any) {
  const uid = ctx.from.id;
  const count = jobsFor(uid).length;

  // show current draft (if any) to surface the UI state
  const dAny: any = snipeDraft.get(uid) || {};
  const token = dAny.token as (string | undefined);
  const amountStr = dAny.amountPlsWei ? fmtDec(ethers.formatEther(dAny.amountPlsWei as bigint)) + ' PLS' : '—';
  const minLiqStr = dAny.minLiqUsd != null ? fmtUsdCompact(Number(dAny.minLiqUsd)) : '—';
  const addLiqOn = !!dAny.onAddLiquidity;
  const methodTxt = (dAny.method && String(dAny.method).trim()) || '—';
  const txMode = (dAny.txMode === 'batch') ? 'Batch' : 'Single';

  const u = getUserSettings(uid);
  const gasPct = Math.round(u?.gas_pct ?? (u?.default_gas_pct ?? 0));

  const text = [
    '🎯 <b>SNIPE</b>',
    '',
    'Create a rule that automatically buys when a token becomes tradable and/or hits a minimum liquidity.',
    '',
    `Active rules: <b>${count}</b>`,
    '',
    '<b>Current Draft (for quick edits)</b>',
    `• Token: ${token ? `<code>${esc(token)}</code>` : '—'}`,
    `• Amount: ${esc(amountStr)}`,
    `• Min Liquidity: ${esc(minLiqStr)}`,
    `• On AddLiquidity: ${addLiqOn ? '🟢 ON' : '🟡 OFF'}`,
    `• Method: ${esc(methodTxt)}`,
    `• Tx Mode: ${esc(txMode)}`,
  ].join('\n');

  // Wallet multi-select (reuse Auto-Buy selection set, but keep snipe-local handler)
  const rows = listWallets(uid);
  const sel = getAutoSelSet(uid);
  const walletButtons = chunk(
    rows.map((w, i) =>
      Markup.button.callback(`${sel.has(w.id) ? '✅ ' : ''}W${i + 1}`, `snipe_wallet_toggle:${w.id}`)
    ),
    6
  );

  const kb = Markup.inlineKeyboard([
    // Back / Refresh
    [Markup.button.callback('⬅️ Back', 'main_back'), Markup.button.callback('🔄 Refresh', 'snipe_refresh')],

    // Unclickable section header
    [Markup.button.callback('EDIT SNIPEY DATA', 'noop')],

    // Amount / Contract / Pair
    [
      Markup.button.callback('Amount', 'snipe_w_amt'),
      Markup.button.callback('Contract', 'snipe_w_token'),
      Markup.button.callback('Pair', 'pair_info'),
    ],

    // Gas %
    [Markup.button.callback(`⛽️ Gas % (+${NF.format(gasPct)}%)`, 'snipe_gas_pct_open')],

    // On AddLiquidity + Method
    [
      Markup.button.callback(`${addLiqOn ? '🟢' : '🟡'} On AddLiquidity`, 'snipe_toggle_addliq'),
      Markup.button.callback(`Method (${methodTxt === '—' ? 'set…' : 'edit'})`, 'snipe_method'),
    ],

    // Tx mode
    [
      Markup.button.callback(`${txMode === 'Single' ? '✅ ' : ''}Single Transaction`, 'snipe_txmode:single'),
      Markup.button.callback(`${txMode === 'Batch'  ? '✅ ' : ''}Batch Transaction`,  'snipe_txmode:batch'),
    ],

    // Wallet selector (multi-select)
    [Markup.button.callback('Wallet Selector', 'noop')],
    ...walletButtons,

    // Actions
    [Markup.button.callback('➕ New Snipe', 'snipe_new')],
    [
      Markup.button.callback('📜 Rules', 'snipe_list'),
      Markup.button.callback('❓ Help', 'snipe_help'),
    ],
  ]);

  return showMenu(ctx, text, { parse_mode: 'HTML', ...kb } as any);
}

/** List all snipe rules for the current user */
async function renderSnipeList(ctx: any) {
  const arr = jobsFor(ctx.from.id);
  if (!arr.length) {
    return showMenu(
      ctx,
      'No snipe rules yet.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ New Snipe', 'snipe_new')],
        [Markup.button.callback('⬅️ Back', 'menu_snipe')],
      ])
    );
  }

  const text = ['<b>Your Snipe Rules</b>', '', ...arr.map(snipeSummary)].join('\n');
  const kb: any[][] = arr.map(j => ([
    Markup.button.callback(j.armed ? `⏸ Pause #${j.id}` : `▶️ Arm #${j.id}`, `snipe_toggle:${j.id}`),
    Markup.button.callback(`❌ Remove #${j.id}`, `snipe_cancel:${j.id}`)
  ]));
  kb.push([Markup.button.callback('⬅️ Back', 'menu_snipe')]);

  return showMenu(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
}

bot.action('menu_snipe', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  return renderSnipeMenu(ctx);
});

bot.action('snipe_refresh', async (ctx) => {
  await ctx.answerCbQuery();
  return renderSnipeMenu(ctx);
});

bot.action('snipe_help', async (ctx) => {
  await ctx.answerCbQuery();
  const lines = [
    '<b>How it works</b>',
    '• You choose a token + spend amount in PLS.',
    '• (Optional) Require a minimum USD liquidity before buying.',
    '• Bot polls for a valid route/liquidity and fires the buy automatically.',
    '',
    'Wallets used: your <i>Auto-Buy Wallets</i> from Settings (or the active wallet if none selected).',
    'Slippage: uses your <i>Auto-Buy Slippage</i> setting.',
  ].join('\n');
  return showMenu(
    ctx,
    lines,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_snipe')]]) }
  );
});

bot.action('snipe_new', async (ctx) => {
  await ctx.answerCbQuery();
  snipeDraft.set(ctx.from.id, {});
  pending.set(ctx.from.id, { type: 'snipe_token' } as any);
  return showMenu(
    ctx,
    'Paste the <b>token contract address</b> (0x…40 hex).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Cancel', 'menu_snipe')]]) }
  );
});

// Quick-jump to token input from the menu
bot.action('snipe_w_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'snipe_token' } as any);
  return showMenu(
    ctx,
    'Paste the <b>token contract address</b> (0x…40 hex).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_snipe')]]) }
  );
});

bot.action('snipe_list', async (ctx) => {
  await ctx.answerCbQuery();
  return renderSnipeList(ctx);
});

bot.action(/^snipe_toggle:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const arr = jobsFor(ctx.from.id);
  const j = arr.find(x => x.id === id);
  if (!j) {
    return showMenu(
      ctx,
      `Snipe #${id} not found.`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'snipe_list')]])
    );
  }
  j.armed = !j.armed;
  return bot.telegram.sendMessage(ctx.from.id, `${j.armed ? '🟢 Armed' : '🟡 Paused'} ${snipeSummary(j)}`);
});

bot.action(/^snipe_cancel:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const ok = removeSnipe(ctx.from.id, id);
  await ctx.reply(ok ? `Removed snipe #${id}.` : `Couldn’t remove #${id}.`);

  const arr = jobsFor(ctx.from.id);
  if (!arr.length) return renderSnipeMenu(ctx);
  return renderSnipeList(ctx);
});

/* Optional wizard convenience buttons (you can link to these from the UI later) */
bot.action('snipe_w_amt', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'snipe_amt' } as any);
  return showMenu(
    ctx,
    'How much <b>PLS</b> to spend when it triggers? (e.g., <code>0.25</code>)',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_snipe')]]) }
  );
});

bot.action('snipe_w_liq', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'snipe_liq' } as any);
  return showMenu(
    ctx,
    'Optional: minimum <b>USD liquidity</b> required (supports k/m). Send <code>50k</code> or <code>skip</code>.',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_snipe')]]) }
  );
});

/* === NEW: gas % picker that returns to Snipe menu === */
bot.action('snipe_gas_pct_open', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const u = getUserSettings(uid);
  const cur = Math.round(u?.gas_pct ?? (u?.default_gas_pct ?? 0));

  const choices = [-25, 0, 5, 10, 15, 25, 50, 100];
  const rows = chunk(
    choices.map(v =>
      Markup.button.callback(`${cur === v ? '✅ ' : ''}${v > 0 ? '+' : ''}${v}%`, `snipe_gas_set:${v}`)
    ),
    4
  );
  rows.push([Markup.button.callback('⬅️ Back', 'menu_snipe')]);

  return showMenu(
    ctx,
    'Choose <b>Gas %</b> over market:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/^snipe_gas_set:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const v = Number(ctx.match[1]);
  setGasPercent(ctx.from.id, v);
  return renderSnipeMenu(ctx);
});

/* === NEW: On AddLiquidity toggle === */
bot.action('snipe_toggle_addliq', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const dAny: any = snipeDraft.get(uid) || {};
  dAny.onAddLiquidity = !dAny.onAddLiquidity;
  snipeDraft.set(uid, dAny);
  return renderSnipeMenu(ctx);
});

/* === NEW: Method capture (pending text input) === */
bot.action('snipe_method', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'snipe_method' } as any); // make sure you added this union member in step 2
  return showMenu(
    ctx,
    'Send the <b>function name</b> or 4-byte selector to watch for (e.g., <code>enableTrading()</code> or <code>0xabcdef01</code>).',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_snipe')]]) }
  );
});

/* === NEW: Tx mode (Single / Batch) === */
bot.action(/^snipe_txmode:(single|batch)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const mode = ctx.match[1] as 'single' | 'batch';
  const dAny: any = snipeDraft.get(uid) || {};
  dAny.txMode = mode; // currently informational; engine treats both as fan-out
  snipeDraft.set(uid, dAny);
  return renderSnipeMenu(ctx);
});

/* === NEW: Wallet multi-select just for Snipe screen (reuses Auto-Buy selection set) === */
bot.action(/^snipe_wallet_toggle:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const s = getAutoSelSet(ctx.from.id);
  if (s.has(id)) s.delete(id); else s.add(id);
  return renderSnipeMenu(ctx);
});

bot.action('snipe_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const d = snipeDraft.get(ctx.from.id) as SnipeDraft | undefined;
  if (!d?.token || !d?.amountPlsWei) {
    return showMenu(ctx, 'Draft incomplete. Start again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ New Snipe', 'snipe_new')],
        [Markup.button.callback('⬅️ Back', 'menu_snipe')]
      ])
    );
  }

  const job = addSnipe({
    telegramId: ctx.from.id,
    token: d.token,
    amountPlsWei: d.amountPlsWei,
    minLiqUsd: d.minLiqUsd ?? null,

    // NEW: persist UI options onto the job
    onAddLiquidity: !!d.onAddLiquidity,
    method: d.method ? String(d.method) : undefined,
    txMode: d.txMode === 'batch' ? 'batch' : 'single',
  });

  // NEW: snapshot current liquidity as baseline so “On AddLiquidity” won’t
  // immediately fire on already-liquid tokens.
  try {
    const dsNow = await fetchDexScreener(d.token);
    const liqNow = dsNow.liquidityUSD != null ? Number(dsNow.liquidityUSD) : null;
    snipeBaseLiqUSD.set(job.id, liqNow);
  } catch {
    snipeBaseLiqUSD.set(job.id, null);
  }

  snipeDraft.delete(ctx.from.id);
  await ctx.reply(`✅ Snipe created and armed:\n${snipeSummary(job)}`, {
    link_preview_options: { is_disabled: true }
  } as any);
  return renderSnipeMenu(ctx);
});

/* ---------- SNIPE engine ---------- */
const SNIPER_TICK_MS = Number(process.env.SNIPER_TICK_MS ?? 8000);

async function runSniperTick() {
  // flatten all armed jobs
  const all: SnipeJob[] = [];
  for (const [, arr] of snipeJobs) for (const j of arr) if (j.armed) all.push(j);
  if (!all.length) return;

  for (const j of all) {
    try {
      // --- NEW: fetch DS metrics once for this job (liq used by multiple gates)
      const ds = await fetchDexScreener(j.token);
      const curLiq = ds.liquidityUSD != null ? Number(ds.liquidityUSD) : null;

      // optional minimum-liquidity gate
      if (j.minLiqUsd != null) {
        if (curLiq == null || curLiq < j.minLiqUsd) continue;
      }

      // --- NEW: “On AddLiquidity” gate (fire only when liquidity/route appears after baseline)
      if (j.onAddLiquidity) {
        const base = snipeBaseLiqUSD.get(j.id);
        if (base === undefined) {
          // first-ever tick after a reload; seed baseline and wait
          snipeBaseLiqUSD.set(j.id, curLiq ?? null);
          continue;
        }
        const hadNone = (base == null || base <= 0);
        const nowHas  = (curLiq != null && curLiq > 0);
        if (!(hadNone && nowHas)) {
          // no fresh add-liquidity event yet
          continue;
        }
        // If we reach here, this tick is the first time liquidity exists after a no-liquidity baseline.
        // (We don't update baseline because the job disarms after firing.)
      }

      // route/quote existence for configured spend
      let pre: any = null;
      try { pre = await bestQuoteBuy(j.amountPlsWei, j.token); } catch {}
      if (!pre?.amountOut) continue;

      // choose wallets: Auto-Buy selection (if any) else active
      const selectedIds = Array.from(getAutoSelSet(j.telegramId) ?? []);
      const wallets = selectedIds.length
        ? listWallets(j.telegramId).filter(w => selectedIds.includes(w.id))
        : (getActiveWallet(j.telegramId) ? [getActiveWallet(j.telegramId)!] : []);

      if (!wallets.length) {
        await bot.telegram.sendMessage(j.telegramId, `Snipe #${j.id}: no wallet selected. Go to Settings ▸ Auto-Buy Wallets.`);
        continue;
      }

      // slippage (Auto-Buy slippage)
      const autoBps = getAutoBuySlipBps(j.telegramId);
      const minOut =
        pre.amountOut > 0n
          ? (autoBps === SLIP_AUTO
              ? (pre.amountOut * 99n) / 100n
              : (pre.amountOut * BigInt(10000 - autoBps)) / 10000n)
          : 0n;

      // gas, token, fire buys concurrently ... (unchanged below)
      const gas = await computeGas(j.telegramId);
      const token = j.token;

      const tasks = wallets.map(async (w) => {
        const pendingMsg = await bot.telegram.sendMessage(j.telegramId, `⏳ Snipe #${j.id}: sending buy for ${briefAddr(w.address)}…`);
        // (body unchanged)
        // ...
      });

      await Promise.allSettled(tasks);

      // disarm after first fire so we don’t keep buying
      j.armed = false;
      snipeBaseLiqUSD.delete(j.id); // NEW: cleanup baseline
      await bot.telegram.sendMessage(j.telegramId, `Snipe #${j.id} completed and paused.`);
    } catch {
      // ignore this tick for this job
    }
  }
}

setInterval(() => { runSniperTick().catch(() => {}); }, SNIPER_TICK_MS);

/* ---------- (unchanged) BUY actions below — keep these) ---------- */
bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderBuyMenu(ctx); });
bot.action('buy_refresh', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });

bot.action('buy_set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_amount' });
  return showMenu(ctx, 'Send *amount in PLS* (e.g., 0.05).', { parse_mode: 'Markdown',
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
/* 🎯 BUY Slippage picker (presets only; returns to BUY menu) */
bot.action('slip_open_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const cur = getSlipBps(ctx.from.id);
  const opts = [
    { t: 'Auto', v: SLIP_AUTO },
    { t: '0.5%', v: 50 },
    { t: '1%',   v: 100 },
    { t: '2%',   v: 200 },
    { t: '3%',   v: 300 },
    { t: '5%',   v: 500 },
  ];
  const rows = chunk(
    opts.map(o => Markup.button.callback(`${cur === o.v ? '✅ ' : ''}${o.t}`, `slip_set_buy:${o.v}`)),
    3
  );
  rows.push([Markup.button.callback('⬅️ Back', 'menu_buy')]);
  return showMenu(ctx, 'Choose *Slippage*:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});
bot.action(/^slip_set_buy:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const bps = Number(ctx.match[1]);
  setSlipBps(ctx.from.id, bps);
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

/* ----- Quick Buy actions (instant PLS spends) ----- */
bot.action(/^buy_qb:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1] ?? -1);
  if (idx < 0 || idx > 5) return;

  const u = getUserSettings(ctx.from.id);
  const token = u?.token_address;
  if (!token) return showMenu(ctx, 'Set token first.', buyMenu(u?.gas_pct ?? 0));

  const selIds = Array.from(getSelSet(ctx.from.id));
  const active = getActiveWallet(ctx.from.id);
  const wallets = selIds.length
    ? listWallets(ctx.from.id).filter((w) => selIds.includes(w.id))
    : (active ? [active] : []);

  if (!wallets.length) return showMenu(ctx, 'Select a wallet first (Wallets page).', buyMenu(u?.gas_pct ?? 0));

  // Parse label -> PLS (e.g., "250K" -> "250000")
  const label = getQuickLabels(ctx.from.id)[idx] || '0';
  const plsStr = kmbToPls(label);
  let amountIn: bigint;
  try {
    amountIn = ethers.parseEther(plsStr);
  } catch {
    return showMenu(ctx, `Bad amount: ${label} PLS`, buyMenu(u?.gas_pct ?? 0));
  }
  if (amountIn <= 0n) return showMenu(ctx, `Bad amount: ${label} PLS`, buyMenu(u?.gas_pct ?? 0));

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);

  const tasks = wallets.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy (${label} PLS) for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);

      // 🔎 Pre-quote for slippage + success card/logging
      let pre: any = null;
      try { pre = await bestQuoteBuy(amountIn, token!); } catch {}
      const slipBps = getSlipBps(ctx.from.id);
      const minOut =
        pre?.amountOut
          ? (slipBps === SLIP_AUTO
              ? (pre.amountOut * 99n) / 100n
              : (pre.amountOut * BigInt(10000 - slipBps)) / 10000n)
          : 0n;

      const r = await buyAutoRoute(getPrivateKey(w), token!, amountIn, minOut, gas);
      const hash = (r as any)?.hash;

// For success card + logging
let preOut: bigint = pre?.amountOut ?? 0n, tokDec = 18, tokSym = 'TOKEN';
try {
  const meta = await tokenMeta(token!);
  tokDec = meta.decimals ?? 18;
  tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
  if (pre?.amountOut) {
    try {
      await recordBuyAndCache(
        ctx.from.id,
        w.address,
        token!,
        amountIn,
        pre.amountOut,
        pre.route?.key ?? 'AUTO',
        tokDec
      );
    } catch {}
  }
} catch {}

      if (hash) {
        const link = otter(hash);
        try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`); }
        catch { await ctx.reply(`transaction sent ${link}`); }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token!,
            explorerUrl: link
          });
        }).catch(() => {});
      } else {
        try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)'); }
        catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`); }
      catch { await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`); }
    }
  });

  await Promise.allSettled(tasks);
  await upsertPinnedPosition(ctx);
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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = wallets.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          try { recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key); } catch {}
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          try { recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key); } catch {}
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

  await upsertPinnedPosition(ctx);
  return renderBuyMenu(ctx);
});

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = wallets.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          await sendRefNudgeTo(ctx.from.id);
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

  await upsertPinnedPosition(ctx);
  return renderBuyMenu(ctx);
});

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = wallets.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          // (referral nudge removed)
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  const token = u.token_address!;

  // 🔁 Fire all transactions simultaneously
  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
    try {
      const gas = await computeGas(ctx.from.id);
      const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, 0n, gas);
      const hash = (r as any)?.hash;

      let preOut: bigint = 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        const preQuote = await bestQuoteBuy(amountIn, token);
        if (preQuote?.amountOut) {
          preOut = preQuote.amountOut;
          recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`);
        } catch {
          await ctx.reply(`transaction sent ${link}`);
        }

        if (token.toLowerCase() !== WPLS) {
          approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
        }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'BUY',
            spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
            receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
            tokenAddress: token,
            explorerUrl: link
          });
          await sendRefNudgeTo(ctx.from.id);
        }).catch(() => {/* ignore */});
      } else {
        try {
          await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)');
        } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Buy failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Buy failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

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
  draft.set(ctx.from.id, { side: 'BUY', walletId: w.id, token: u.token_address! });
  pending.set(ctx.from.id, { type: 'lb_amt' });
  return showMenu(ctx, 'Send *limit buy amount* in PLS (e.g., `0.5`, `1.2`):', { parse_mode: 'Markdown' });
});

bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', sellMenu());
  if (!w) return showMenu(ctx, 'Select a wallet first.', sellMenu());
  draft.set(ctx.from.id, { side: 'SELL', walletId: w.id, token: u.token_address! });
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

  // Show per-user numbering (1..n) while keeping real DB ids internally
  const lines = rows.map((r: any, i: number) => {
    const base = `#${i + 1} ${r.side} ${short(r.token_address)}  ${r.trigger_type}=${NF.format(r.trigger_value)}  [${r.status}]`;
    if (r.side === 'BUY' && r.amount_pls_wei) {
      return `${base}  amt=${fmtDec(ethers.formatEther(BigInt(r.amount_pls_wei)))} PLS`;
    }
    if (r.side === 'SELL' && r.sell_pct != null) {
      return `${base}  ${r.sell_pct}%`;
    }
    return base;
  });

  // Buttons display per-user numbers, callbacks carry true DB id
  const kb = rows
    .map((r: any, i: number) =>
      r.status === 'OPEN'
        ? [Markup.button.callback(`❌ Cancel #${i + 1}`, `limit_cancel:${r.id}`)]
        : null
    )
    .filter(Boolean) as any[];

  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);

  return showMenu(ctx, lines.join('\n'), Markup.inlineKeyboard(kb));
});

bot.action(/^limit_cancel:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]); // real DB id

  // Work out the user-visible number for this row
  const rows = listLimitOrders(ctx.from.id);
  const idx = rows.findIndex((r: any) => r.id === id);
  const disp = idx >= 0 ? `#${idx + 1}` : `#${id}`;

  const changed = cancelLimitOrder(ctx.from.id, id);
  return showMenu(ctx, changed ? `Limit ${disp} cancelled.` : `Couldn’t cancel ${disp}.`, mainMenu());
});

/* ===== Sell menu wallet selection (state + handlers) ===== */
const sellWalletSel = new Map<number, number>(); // uid -> walletId

bot.action(/^sell_wallet_select:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  sellWalletSel.set(ctx.from.id, id);
  return renderSellMenu(ctx);
});

bot.action('sell_wallet_clear', async (ctx: any) => {
  await ctx.answerCbQuery();
  sellWalletSel.delete(ctx.from.id);
  return renderSellMenu(ctx);
});

/* helper: best-effort unpin if app exposes a remover */
async function safeRemovePinnedPosition(ctx: any, token?: string) {
  try {
    const g: any = globalThis as any;
    if (typeof g.removePinnedPosition === 'function') {
      await g.removePinnedPosition(ctx, token);
    }
  } catch { /* ignore */ }
}

/* small inline picker for sell % (shows ✅ on current) */
bot.action('sell_pct_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const cur = u?.sell_pct ?? 100;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${cur === 25  ? '✅ ' : ''}25%`,  'sell_pct_25'),
      Markup.button.callback(`${cur === 50  ? '✅ ' : ''}50%`,  'sell_pct_50'),
      Markup.button.callback(`${cur === 75  ? '✅ ' : ''}75%`,  'sell_pct_75'),
      Markup.button.callback(`${cur === 100 ? '✅ ' : ''}100%`, 'sell_pct_100'),
    ],
    [Markup.button.callback('⬅️ Back', 'menu_sell')],
  ]);
  return showMenu(ctx, 'Choose *Sell %*:', { parse_mode: 'Markdown', ...kb });
});

/* quick setters */
bot.action('sell_refresh', async (ctx) => { await ctx.answerCbQuery(); return renderSellMenu(ctx); });
bot.action('sell_pct_25', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 25); return renderSellMenu(ctx); });
bot.action('sell_pct_50', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 50); return renderSellMenu(ctx); });
bot.action('sell_pct_75', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 75); return renderSellMenu(ctx); });
bot.action('sell_pct_100', async (ctx) => { await ctx.answerCbQuery(); setSellPct(ctx.from.id, 100); return renderSellMenu(ctx); });

/* NEW: generic setter used by the "Edit Sell %" screen (supports any 1–100 value) */
bot.action(/^sell_pct_set:(\d{1,3})$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const pct = Math.max(1, Math.min(100, Number(ctx.match[1])));
  setSellPct(ctx.from.id, pct);
  return renderSellMenu(ctx);
});

/* === SELL: Gas % picker that returns to SELL menu === */
bot.action('sell_gas_pct_open', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const cur = Math.round(u?.gas_pct ?? (u?.default_gas_pct ?? 0));

  const choices = [-25, 0, 5, 10, 15, 25, 50, 100];
  const rows = chunk(
    choices.map(v =>
      Markup.button.callback(
        `${cur === v ? '✅ ' : ''}${v > 0 ? '+' : ''}${v}%`,
        `sell_gas_pct_set:${v}`
      )
    ),
    4
  );
  rows.push([Markup.button.callback('⬅️ Back', 'menu_sell')]);

  return showMenu(
    ctx,
    'Choose <b>Gas %</b> over market:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/^sell_gas_pct_set:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const v = Number(ctx.match[1]);
  setGasPercent(ctx.from.id, v);
  return renderSellMenu(ctx); // stay in SELL
});

/* ===== Slippage (auto/manual) ===== */
// -1 means "Auto". Any non-negative number is basis points (0..5000 → 0..50%)
const SLIP_AUTO = -1;
const slipBpsMap = new Map<number, number>(); // uid -> bps or -1 (Auto)

// default = Auto
function getSlipBps(uid: number): number {
  return slipBpsMap.has(uid) ? (slipBpsMap.get(uid) as number) : SLIP_AUTO;
}
function setSlipBps(uid: number, bps: number) {
  // allow -1 for Auto, else clamp 0..5000 bps (0..50%)
  slipBpsMap.set(uid, Math.max(-1, Math.min(5000, Math.round(bps))));
}

// pretty-printer for manual values (bps → "%")
function fmtSlip(bps: number): string {
  return (bps % 100 === 0) ? String(bps / 100) : (bps / 100).toFixed(1);
}
// label that shows "Auto" when in auto mode
function fmtSlipLabel(uid: number): string {
  const b = getSlipBps(uid);
  return b === SLIP_AUTO ? 'Auto' : `${fmtSlip(b)}%`;
}

// ✅ NEW: helper to compute minOut from a quote (works for BUY/SELL)
function minOutFromQuote(uid: number, quotedOut: bigint): bigint {
  if (!quotedOut || quotedOut <= 0n) return 0n;
  const slip = getSlipBps(uid);
  return slip === SLIP_AUTO
    ? (quotedOut * 99n) / 100n                     // 1% safety if Auto
    : (quotedOut * BigInt(10000 - slip)) / 10000n; // manual bps
}

/* ===== Auto-Buy Slippage (own setting used only for auto-buys) ===== */
const autoSlipBpsMap = new Map<number, number>(); // uid -> bps or -1 (Auto)

function getAutoBuySlipBps(uid: number): number {
  return autoSlipBpsMap.has(uid) ? (autoSlipBpsMap.get(uid) as number) : SLIP_AUTO;
}
function setAutoBuySlipBps(uid: number, bps: number) {
  autoSlipBpsMap.set(uid, Math.max(-1, Math.min(5000, Math.round(bps))));
}
function fmtAutoSlipLabel(uid: number): string {
  const b = getAutoBuySlipBps(uid);
  return b === SLIP_AUTO ? 'Auto' : `${fmtSlip(b)}%`;
}

// ====== SELL/BUY slippage pickers ======
bot.action('slip_open', async (ctx) => {
  await ctx.answerCbQuery();
  const cur = getSlipBps(ctx.from.id);

  // Include "Auto" plus common presets
  const opts = [
    { t: 'Auto', v: SLIP_AUTO },
    { t: '0.5%', v: 50 },
    { t: '1%',   v: 100 },
    { t: '2%',   v: 200 },
    { t: '3%',   v: 300 },
    { t: '5%',   v: 500 },
  ];

  const rows = chunk(
    opts.map(o => Markup.button.callback(`${cur === o.v ? '✅ ' : ''}${o.t}`, `slip_set:${o.v}`)),
    3
  );

  // ➕ Custom slippage entry button
  rows.push([Markup.button.callback('✏️ Custom…', 'slip_custom')]);
  rows.push([Markup.button.callback('⬅️ Back', 'menu_sell')]);

  return showMenu(
    ctx,
    'Choose *Slippage*:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
});

// ✅ NEW: BUY-side slippage picker (same options, back to BUY)
bot.action('slip_open_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const cur = getSlipBps(ctx.from.id);

  const opts = [
    { t: 'Auto', v: SLIP_AUTO },
    { t: '0.5%', v: 50 },
    { t: '1%',   v: 100 },
    { t: '2%',   v: 200 },
    { t: '3%',   v: 300 },
    { t: '5%',   v: 500 },
  ];

  const rows = chunk(
    opts.map(o => Markup.button.callback(`${cur === o.v ? '✅ ' : ''}${o.t}`, `slip_set:${o.v}`)),
    3
  );

  rows.push([Markup.button.callback('✏️ Custom…', 'slip_custom_buy')]);
  rows.push([Markup.button.callback('⬅️ Back', 'menu_buy')]);

  return showMenu(
    ctx,
    'Choose *Slippage*:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
});

// accept negative for Auto (-1) or 0..5000 for manual bps
bot.action(/^slip_set:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const bps = Number(ctx.match[1]);
  setSlipBps(ctx.from.id, bps);
  // ✅ changed: try to return to the current screen (SELL first, then BUY)
  try { return renderSellMenu(ctx); } catch {}
  try { return renderBuyMenu(ctx); } catch {}
  return;
});

// start custom slippage prompt (handled in bot.on("text") with type: 'slip_custom')
bot.action('slip_custom', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'slip_custom' });
  return showMenu(
    ctx,
    'Send custom slippage % (e.g., `0.7`, `1`, `1.25`). Range 0–50.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'slip_open')]]) }
  );
});

// ✅ NEW: custom slippage prompt (BUY back button)
bot.action('slip_custom_buy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'slip_custom' });
  return showMenu(
    ctx,
    'Send custom slippage % (e.g., `0.7`, `1`, `1.25`). Range 0–50.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'slip_open_buy')]]) }
  );
});

/* ===== Settings ▸ Auto-Buy Slippage picker (separate from menu slippage) ===== */
bot.action('auto_slip_open', async (ctx) => {
  await ctx.answerCbQuery();
  const cur = getAutoBuySlipBps(ctx.from.id);

  const opts = [
    { t: 'Auto', v: SLIP_AUTO },
    { t: '0.5%', v: 50 },
    { t: '1%',   v: 100 },
    { t: '2%',   v: 200 },
    { t: '3%',   v: 300 },
    { t: '5%',   v: 500 },
  ];

  const kb = chunk(
    opts.map(o =>
      Markup.button.callback(
        `${cur === o.v ? '✅ ' : ''}${o.t}`,
        `auto_slip_set:${o.v}`
      )
    ),
    3
  );

  kb.push([Markup.button.callback('✏️ Custom…', 'auto_slip_custom')]);
  kb.push([Markup.button.callback('⬅️ Back', 'settings')]);

  return showMenu(
    ctx,
    'Choose *Auto-Buy Slippage* (applies only to automatic buys):',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) }
  );
});

bot.action(/^auto_slip_set:(-?\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const bps = Number(ctx.match[1]);
  setAutoBuySlipBps(ctx.from.id, bps);
  return renderSettings(ctx);
});

bot.action('auto_slip_custom', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'auto_slip_custom' });
  return showMenu(
    ctx,
    'Send custom slippage % for *Auto-Buy* (e.g., `0.7`, `1`, `1.25`). Range 0–50. Type `auto` to switch to Auto.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'auto_slip_open')]]) }
  );
});
/* ---------- SELL MENU (HTML + metrics) ---------- */
async function renderSellMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);

  // Use selected wallet (if any), otherwise active wallet
  const selectedId = sellWalletSel.get(ctx.from.id);
  const w = selectedId ? getWalletById(ctx.from.id, selectedId) : getActiveWallet(ctx.from.id);

  const pct = u?.sell_pct ?? 100;
  const tokenAddrFull: string | undefined = u?.token_address || undefined;
  const slipBps = getSlipBps(ctx.from.id);

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
      const bal = await c.balanceOf(w.address);
      const sellAmt = (bal * BigInt(Math.round(pct))) / 100n;

      // show balance
      balLine = `• <b>Balance:</b> ${esc(fmtDec(ethers.formatUnits(bal, dec)))} ${esc(metaSymbol || 'TOKEN')}`;

      // Try to fill “Est. Out (Sell %)” from a quote (nice to have but not required for PnL)
      let q: any = null;
      try { q = sellAmt > 0n ? await bestQuoteSell(sellAmt, tokenAddrFull) : null; } catch {}
      if (q?.amountOut) {
        outLine = `• <b>Est. Out (${esc(NF.format(pct))}%):</b> ${esc(fmtPls(q.amountOut))} PLS  (Route: ${esc(q.route.key)})`;
      }

      // === PnL calculation (no dependency on quote) ===
      // Current per-token price in PLS (fallback to quote-derived per-token if needed)
      let plsPerToken: number | null = await pricePLSPerToken(tokenAddrFull);
      if (plsPerToken == null && q?.amountOut) {
        const amtTok = Number(ethers.formatUnits(sellAmt, dec));
        const outPls = Number(ethers.formatEther(q.amountOut));
        plsPerToken = amtTok > 0 ? (outPls / amtTok) : null;
      }

// Get user-average entry across all buys (cached)
const avg = getAvgEntryCached(ctx.from.id, tokenAddrFull, dec);
      
      if (avg && plsPerToken != null) {
        const usdPerPls = await plsUSD().catch(() => null);

        // Evaluate PnL for the current Sell % of balance
        const amtTok = Number(ethers.formatUnits(sellAmt, dec));
        const curPlsVal = amtTok * plsPerToken;                       // current PLS value
        const entryPlsVal = amtTok * (avg.avgPlsPerToken || 0);       // entry PLS value for those tokens
        const pnlPls = curPlsVal - entryPlsVal;                        // PnL in PLS
        const pnlPct = (avg.avgPlsPerToken > 0)
          ? ((plsPerToken / avg.avgPlsPerToken) - 1) * 100
          : 0;

        const signEmoji = pnlPls >= 0 ? '🟢' : '🔴';

        // Avg entry line (PLS + USD if available)
        const entryUsdPerTok = (usdPerPls != null)
          ? avg.avgPlsPerToken * usdPerPls
          : null;
        entryLine =
          `• <b>Avg Entry:</b> ${esc(NF.format(avg.avgPlsPerToken))} PLS` +
          (entryUsdPerTok != null
            ? ` ($${(entryUsdPerTok).toLocaleString('en-GB', { maximumFractionDigits: 8 })})`
            : '') +
          ` / ${esc(metaSymbol || 'TOKEN')}`;

        // PnL in PLS with %
        pnlLine =
          `• <b>Net PnL:</b> ${signEmoji} ${esc(NF.format(pnlPls))} PLS  (${esc(NF.format(pnlPct))}%)`;

        // PnL in USD (if conversion available)
        if (usdPerPls != null) {
          const pnlUsd = pnlPls * usdPerPls;
          const signEmojiUsd = pnlUsd >= 0 ? '🟢' : '🔴';
          pnlLine += `\n• <b>PnL $:</b> ${signEmojiUsd} $${Math.abs(pnlUsd).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
        }
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
    '',               // extra blank line between TOKEN and PRICE
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

/* ===== Keyboard to mirror the BUY layout (plus Slippage row) ===== */
const all = listWallets(ctx.from.id);
const activeId = getActiveWallet(ctx.from.id)?.id;
const currentId = selectedId ?? activeId;

const walletButtons = chunk(
  all.map((row, i) =>
    Markup.button.callback(`${currentId === row.id ? '✅ ' : ''}W${i + 1}`, `sell_wallet_select:${row.id}`)
  ),
  6
);

/* --- DYNAMIC Sell % row (Step 4) --- */
const curPct = u?.sell_pct ?? 100;
// assumes you added getSellPresets(uid) earlier (defaults: [25,50,75,100])
const sellPresets = getSellPresets(ctx.from.id);
const pctRows = chunk(
  sellPresets.map((n) =>
    Markup.button.callback(`${curPct === n ? '✅ ' : ''}${n}%`, `sell_pct_set:${n}`)
  ),
  4 // show up to 4 per row
);

/* now compose the keyboard */
const kb: any[][] = [
  // Top gas adjuster (alone)
  [Markup.button.callback(`⛽️ Gas % (${NF.format(u?.gas_pct ?? 0)}%)`, 'sell_gas_pct_open')],
  // Slippage row — show Auto/Manual label
  [Markup.button.callback(`🎯 Slippage (${fmtSlipLabel(ctx.from.id)})`, 'slip_open')],
  // Back / Refresh
  [
    Markup.button.callback('⬅️ Back', 'main_back'),
    Markup.button.callback('🔄 Refresh', 'sell_refresh'),
  ],
  // Edit sell data (disabled label)
  [Markup.button.callback('EDIT SELL DATA', 'noop')],
  // Contract / Pair
  [
    Markup.button.callback('Contract', 'sell_set_token'),
    Markup.button.callback('Pair', 'pair_info'),
  ],
  // Wallets label + wallet rows
  [Markup.button.callback('Wallets', 'noop')],
  ...walletButtons,

  // 🔻 Dynamic "Sell Amount / Method" label + dynamic preset rows
  [Markup.button.callback('Sell Amount / Method', 'noop')],
  ...pctRows,

  // Sell all wallets, limits, primary action
  [Markup.button.callback('Sell All Wallets', 'sell_exec_all')],
  [
    Markup.button.callback('Limit Sell', 'limit_sell'),
    Markup.button.callback('Orders', 'limit_list'),
  ],
  [Markup.button.callback('🟥 Sell Now', 'sell_exec')],
];

  await showMenu(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
}

bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return renderSellMenu(ctx); });

/* Sell ▸ Approve */
bot.action('sell_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);

  // Use selected wallet if present, else active or first wallet
  const selectedId = sellWalletSel.get(ctx.from.id);
  const w = selectedId
    ? getWalletById(ctx.from.id, selectedId)
    : (getActiveWallet(ctx.from.id) || listWallets(ctx.from.id)[0]);

  if (!w || !u?.token_address) return showMenu(ctx, 'Need a wallet and token set first.', sellMenu());
  if (u.token_address.toLowerCase() === WPLS)
    return showMenu(ctx, 'WPLS doesn’t require approval.', sellMenu());
  try {
    const gas = await computeGas(ctx.from.id);
    const token = u.token_address!;
    const results = await approveAllRouters(getPrivateKey(w), token, gas);
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

/* ---------- SELL EXEC (single wallet) ---------- */
bot.action('sell_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);

  // Use selected wallet if present, else active
  const selectedId = sellWalletSel.get(ctx.from.id);
  const w = selectedId ? getWalletById(ctx.from.id, selectedId) : getActiveWallet(ctx.from.id);

  if (!w || !u?.token_address) return showMenu(ctx, 'Need active wallet and token set.', sellMenu());

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const pendingMsg = await ctx.reply(`⏳ Sending sell for ${short(w.address)}…`);

  try {
    const token = u.token_address!;
    const c = erc20(token);
    const bal = await c.balanceOf(w.address);
    const percent = u?.sell_pct ?? 100;
    const amount = (bal * BigInt(Math.round(percent))) / 100n;

    if (amount <= 0n) {
      try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'Nothing to sell.'); } catch {}
      if (percent < 100) { await upsertPinnedPosition(ctx); } else { await safeRemovePinnedPosition(ctx, token); }
      return renderSellMenu(ctx);
    }

    // Pre-quote for slippage & logging
    let q: any = null;
    try { q = await bestQuoteSell(amount, token); } catch {}
    const slipBps = getSlipBps(ctx.from.id);
    const minOut = q?.amountOut
      ? (slipBps === SLIP_AUTO
          ? (q.amountOut * 99n) / 100n            // simple 1% safety if Auto
          : (q.amountOut * BigInt(10000 - slipBps)) / 10000n)
      : 0n;

    const gas = await computeGas(ctx.from.id);
    const r = await sellAutoRoute(getPrivateKey(w), token, amount, minOut, gas);
    const hash = (r as any)?.hash;

    let outPls: bigint = q?.amountOut ?? 0n;
    let tokDec = 18;
    let tokSym = 'TOKEN';
    try {
      const meta = await tokenMeta(token);
      tokDec = meta.decimals ?? 18;
      tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
      if (q?.amountOut) {
        recordTrade(ctx.from.id, w.address, token, 'SELL', q.amountOut, amount, q.route?.key ?? 'AUTO');
      }
    } catch {}

    if (hash) {
      const link = otter(hash);
      try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`); }
      catch { await ctx.reply(`transaction sent ${link}`); }

      provider.waitForTransaction(hash).then(async () => {
        try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
        await postTradeSuccess(ctx, {
          action: 'SELL',
          spend:   { amount: amount,  decimals: tokDec, symbol: tokSym },
          receive: { amount: outPls,  decimals: 18,     symbol: 'PLS' },
          tokenAddress: token,
          explorerUrl: link
        });
        if (percent < 100) { await upsertPinnedPosition(ctx); } else { await safeRemovePinnedPosition(ctx, token); }
      }).catch(async () => {
        if (percent < 100) { await upsertPinnedPosition(ctx); } else { await safeRemovePinnedPosition(ctx, token); }
      });
    } else {
      try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)'); }
      catch {}
      if (percent < 100) { await upsertPinnedPosition(ctx); } else { await safeRemovePinnedPosition(ctx, token); }
    }
  } catch (e: any) {
    const brief = conciseError(e);
    try {
      await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Sell failed for ${short(w.address)}: ${brief}`);
    } catch {
      await ctx.reply(`❌ Sell failed for ${short(w.address)}: ${brief}`);
    }
    // on failure, do not change pins
  }

  return renderSellMenu(ctx);
});

/* ---------- SELL EXEC (ALL wallets, simultaneous) ---------- */
bot.action('sell_exec_all', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUserSettings(ctx.from.id);
  const rows = listWallets(ctx.from.id);
  if (!rows.length) return showMenu(ctx, 'No wallets.', sellMenu());
  if (!u?.token_address) return showMenu(ctx, 'Set token first.', sellMenu());

  const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
  const percent = u?.sell_pct ?? 100;
  const token = u.token_address!;
  const slipBps = getSlipBps(ctx.from.id);

  const tasks = rows.map(async (w) => {
    const pendingMsg = await ctx.reply(`⏳ Sending sell for ${short(w.address)}…`);
    try {
      const c = erc20(token);
      const bal = await c.balanceOf(w.address);
      const amount = (bal * BigInt(Math.round(percent))) / 100n;

      if (amount <= 0n) {
        try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'Nothing to sell.'); } catch {}
        return;
      }

      // Pre-quote for slippage & logging
      let q: any = null;
      try { q = await bestQuoteSell(amount, token); } catch {}
      const minOut = q?.amountOut
        ? (slipBps === SLIP_AUTO
            ? (q.amountOut * 99n) / 100n
            : (q.amountOut * BigInt(10000 - slipBps)) / 10000n)
        : 0n;

      const gas = await computeGas(ctx.from.id);
      const r = await sellAutoRoute(getPrivateKey(w), token, amount, minOut, gas);
      const hash = (r as any)?.hash;

      let outPls: bigint = q?.amountOut ?? 0n;
      let tokDec = 18;
      let tokSym = 'TOKEN';
      try {
        const meta = await tokenMeta(token);
        tokDec = meta.decimals ?? 18;
        tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
        if (q?.amountOut) {
          recordTrade(ctx.from.id, w.address, token, 'SELL', q.amountOut, amount, q.route?.key ?? 'AUTO');
        }
      } catch {}

      if (hash) {
        const link = otter(hash);
        try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `transaction sent ${link}`); }
        catch { await ctx.reply(`transaction sent ${link}`); }

        provider.waitForTransaction(hash).then(async () => {
          try { await bot.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
          await postTradeSuccess(ctx, {
            action: 'SELL',
            spend:   { amount,  decimals: tokDec, symbol: tokSym },
            receive: { amount: outPls,  decimals: 18,     symbol: 'PLS' },
            tokenAddress: token,
            explorerUrl: link
          });
        }).catch(() => {/* ignore */});
      } else {
        try { await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, 'transaction sent (no hash yet)'); } catch {}
      }
    } catch (e: any) {
      const brief = conciseError(e);
      try {
        await bot.telegram.editMessageText(chatId, pendingMsg.message_id, undefined, `❌ Sell failed for ${short(w.address)}: ${brief}`);
      } catch {
        await ctx.reply(`❌ Sell failed for ${short(w.address)}: ${brief}`);
      }
    }
  });

  await Promise.allSettled(tasks);

  // Pin behavior after batch: skip/try-remove if selling 100%
  if (percent < 100) {
    await upsertPinnedPosition(ctx);
  } else {
    await safeRemovePinnedPosition(ctx, token);
  }

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

/* No-op label handler reused */
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

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

/* ---------- /mcap command (parity with DexScreener when available) ---------- */
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
    bot.telegram.sendMessage(r.telegram_id, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra
    } as any)
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

        // ✅ NEW: apply slippage to Limit BUY
        const minOutLE = minOutFromQuote(r.telegram_id, preOut);
        const rec = await buyAutoRoute(getPrivateKey(w), r.token_address, amtIn, minOutLE, gas);
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
            await sendRefNudgeTo(r.telegram_id);
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

        // Apply user slippage (incl. Auto) to limit SELL execution
        const slipBpsLE = getSlipBps(r.telegram_id);
        const minOutLE =
          outPls > 0n
            ? (slipBpsLE === SLIP_AUTO
                ? (outPls * 99n) / 100n
                : (outPls * BigInt(10000 - slipBpsLE)) / 10000n)
            : 0n;

        const rec = await sellAutoRoute(getPrivateKey(w), r.token_address, amount, minOutLE, gas);
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

/** Helper: Telegraf requires the 4-arg overload when using (chatId, messageId, ...). */
function editMsgTextSafe(ctx: any, chatId: number | string, messageId: number, text: string) {
  // Cast the extra as any to dodge strict older type defs
  return ctx.telegram.editMessageText(chatId, messageId, text, {} as any);
}

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

    // ✅ UPDATED: custom slippage (text input) handler returns to SELL or BUY
    if (p.type === 'slip_custom') {
      const t = String(msg || '').trim().toLowerCase();

      if (t === 'auto') {
        setSlipBps(ctx.from.id, SLIP_AUTO);
        pending.delete(ctx.from.id);
        await ctx.reply('Slippage set to Auto.');
        try { return renderSellMenu(ctx); } catch {}
        try { return renderBuyMenu(ctx); } catch {}
        return;
      }

      const cleaned = t.replace(/,/g, '').replace(/\s+/g, '');
      let bps: number | null = null;

      const mBp = cleaned.match(/^([0-9]*\.?[0-9]+)(bp|bps)$/);
      if (mBp) {
        const n = Number(mBp[1]);
        if (Number.isFinite(n)) bps = Math.round(n);
      } else {
        const n = Number(cleaned.replace(/%$/, ''));
        if (Number.isFinite(n)) bps = Math.round(n * 100);
      }

      if (bps == null || bps < 0 || bps > 5000) {
        await ctx.reply('Please send a value between 0 and 50 (e.g., 0.7, 1, 1.25) — or type "auto".');
        return;
      }

      setSlipBps(ctx.from.id, bps);
      pending.delete(ctx.from.id);
      await ctx.reply(`Slippage set to ${fmtSlip(bps)}%.`);
      try { return renderSellMenu(ctx); } catch {}
      try { return renderBuyMenu(ctx); } catch {}
      return;
    }

    // ✅ NEW: Auto-Buy custom slippage (text input) handler, returns to Settings
    if (p.type === 'auto_slip_custom') {
      const t = String(msg || '').trim().toLowerCase();

      if (t === 'auto') {
        setAutoBuySlipBps(ctx.from.id, SLIP_AUTO);
        pending.delete(ctx.from.id);
        await ctx.reply('Auto-Buy slippage set to Auto.');
        return renderSettings(ctx);
      }

      const cleaned = t.replace(/,/g, '').replace(/\s+/g, '');
      let bps: number | null = null;

      const mBp = cleaned.match(/^([0-9]*\.?[0-9]+)(bp|bps)$/);
      if (mBp) {
        const n = Number(mBp[1]);
        if (Number.isFinite(n)) bps = Math.round(n);
      } else {
        const n = Number(cleaned.replace(/%$/, ''));
        if (Number.isFinite(n)) bps = Math.round(n * 100);
      }

      if (bps == null || bps < 0 || bps > 5000) {
        await ctx.reply('Please send a value between 0 and 50 (e.g., 0.7, 1, 1.25) — or type "auto".');
        return;
      }

      setAutoBuySlipBps(ctx.from.id, bps);
      pending.delete(ctx.from.id);
      await ctx.reply(`Auto-Buy slippage set to ${(bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(1))}%.`);
      return renderSettings(ctx);
    }

  /* ---------- SNIPE FLOW ---------- */
    if ((p as any).type === 'snipe_token') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(msg)) {
        await ctx.reply('That does not look like a token address.');
        return;
      }
      const d = snipeDraft.get(ctx.from.id) || {};
      d.token = msg;
      snipeDraft.set(ctx.from.id, d);

      // continue the wizard
      pending.set(ctx.from.id, { type: 'snipe_amt' } as any);
      await ctx.reply('Got the token. Now send the amount in PLS (e.g., 0.25).');
      return;
    }

    if ((p as any).type === 'snipe_amt') {
      const amt = Number(msg);
      if (!Number.isFinite(amt) || amt <= 0) {
        await ctx.reply('Send a positive number, e.g., 0.25');
        return;
      }
      const d = snipeDraft.get(ctx.from.id) || {};
      d.amountPlsWei = ethers.parseEther(String(amt));
      snipeDraft.set(ctx.from.id, d);

      // next: optional liquidity
      pending.set(ctx.from.id, { type: 'snipe_liq' } as any);
      await ctx.reply('Optional: send minimum USD liquidity (e.g., 50k), or type "skip".');
      return;
    }

    if ((p as any).type === 'snipe_liq') {
      const raw = msg.toLowerCase();
      let val: number | null = null;
      if (raw !== 'skip') {
        const m = raw.replace(/[\s,$]/g, '').match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/i);
        if (!m) {
          await ctx.reply('Send a number (supports k/m), or "skip".');
          return;
        }
        const base = Number(m[1]);
        const mul = !m[2]
          ? 1
          : m[2].toLowerCase() === 'k'
          ? 1e3
          : m[2].toLowerCase() === 'm'
          ? 1e6
          : 1e9;
        val = base * mul;
      }
      const d = snipeDraft.get(ctx.from.id) || {};
      d.minLiqUsd = val;
      snipeDraft.set(ctx.from.id, d);

      const lines = [
        'Review your snipe:',
        `• Token: <code>${d.token}</code>`,
        `• Amount: <b>${fmtDec(ethers.formatEther(d.amountPlsWei ?? 0n))} PLS</b>`,
        `• Min Liquidity: ${d.minLiqUsd != null ? fmtUsdCompact(d.minLiqUsd) : '—'}`,
        '',
        'Arm this rule?',
      ].join('\n');

      pending.delete(ctx.from.id);
      return showMenu(ctx, lines, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Create & Arm', 'snipe_confirm')],
          [Markup.button.callback('⬅️ Cancel', 'menu_snipe')],
        ]),
      });
    }

    // === NEW: Snipe menu quick-edit — set AMOUNT (PLS) ===
    // (Triggered when the Snipe menu asks for amount without running the full wizard.)
    if ((p as any).type === 'snipe_amt_edit') {
      const raw = String(ctx.message.text).trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        await ctx.reply('Send a positive number (PLS).');
        return;
      }
      const d = snipeDraft.get(ctx.from.id) || {};
      d.amountPlsWei = ethers.parseEther(String(n));
      snipeDraft.set(ctx.from.id, d);

      pending.delete(ctx.from.id);
      await ctx.reply(`Amount set to ${fmtDec(String(n))} PLS.`);
      return renderSnipeMenu(ctx);
    }

    // === NEW: Snipe menu quick-edit — set TOKEN (contract) ===
    // (Triggered when the Snipe menu asks for a token without running the full wizard.)
    if ((p as any).type === 'snipe_token_edit') {
      const addr = String(ctx.message.text).trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        await ctx.reply('That does not look like a token address.');
        return;
      }
      const d = snipeDraft.get(ctx.from.id) || {};
      d.token = addr;
      snipeDraft.set(ctx.from.id, d);

      // keep Buy/Sell menus warm & consistent
      setToken(ctx.from.id, addr);
      warmTokenAsync(ctx.from.id, addr);

      pending.delete(ctx.from.id);
      await ctx.reply('Token set ✅');
      return renderSnipeMenu(ctx);
    }

    // Snipe menu: set method (function name or 4-byte selector)
    if ((p as any).type === 'snipe_method') {
      const msgTxt = String(ctx.message?.text ?? '').trim();

      // allow either a function signature or a 4-byte selector
      const isSelector  = /^0x[0-9a-fA-F]{8}$/.test(msgTxt);
      const isSignature = /^[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)$/.test(msgTxt);

      if (!isSelector && !isSignature) {
        await ctx.reply(
          'Send a function name like `enableTrading()` or a 4-byte selector like `0xabcdef01`.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const d: any = snipeDraft.get(ctx.from.id) || {};
      d.method = isSelector ? msgTxt.toLowerCase() : msgTxt; // normalize selectors
      snipeDraft.set(ctx.from.id, d);

      pending.delete(ctx.from.id);
      await ctx.reply('✅ Method saved.');
      return renderSnipeMenu(ctx);
    }
    /* ---------- END SNIPE FLOW ---------- */

    // Referral payout wallet handler
    if (p.type === 'ref_payout') {
      const addr = msg.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        return ctx.reply('Please send a valid wallet address (0x…40 hex).');
      }
      try {
        await setReferralPayout(ctx.from.id, addr);
        pending.delete(ctx.from.id);
        await ctx.reply('Referral rewards payout wallet set ✅');
        return renderReferrals(ctx);
      } catch (e: any) {
        pending.delete(ctx.from.id);
        return ctx.reply('Failed to save payout wallet: ' + (e?.message ?? 'unknown error'));
      }
    }

    // Quick-Buy label editor
    if (p.type === 'edit_qb') {
      const idx = Math.max(0, Math.min(5, Number((p as any).idx)));
      const raw = String(msg).trim();
      if (!/^\d+(k|m|b)?$/i.test(raw)) {
        await ctx.reply('Please send a number (optionally with K/M/B), e.g., 250k, 1m, 500000.');
        return;
      }
      setQuickLabel(ctx.from.id, idx, raw.toUpperCase());
      pending.delete(ctx.from.id);
      await ctx.reply(`Updated Quick Buy #${idx + 1} → ${raw.toUpperCase()} PLS`);
      return renderSettings(ctx);
    }

    // Sell % preset editor
    if (p.type === 'edit_sp') {
      const idx = Math.max(0, Math.min(3, Number((p as any).idx)));
      const v = Number(String(msg).trim());
      if (!Number.isFinite(v) || v < 1 || v > 100) {
        await ctx.reply('Please send a whole number between 1 and 100.');
        return;
      }
      setSellPreset(ctx.from.id, idx, Math.round(v));
      pending.delete(ctx.from.id);
      await ctx.reply(`Updated Sell % preset #${idx + 1} → ${Math.round(v)}%`);
      return renderSettings(ctx);
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
      const selSet = getAutoSelSet(ctx.from.id);
      const selectedIds: number[] = selSet ? Array.from(selSet) : [];

      // Build wallet list: all selected (if any) else the active wallet
      const active = getActiveWallet(ctx.from.id);
      let wallets = selectedIds.length
        ? listWallets(ctx.from.id).filter(w => selectedIds.includes(w.id))
        : (active ? [active] : []);

      if (!wallets.length) {
        await ctx.reply('Select or create a wallet first.');
        return renderBuyMenu(ctx);
      }

      const chatId = (ctx.chat?.id ?? ctx.from?.id) as (number | string);
      const amountIn = ethers.parseEther(String(u.auto_buy_amount_pls ?? 0.01));
      const token = text;

      const briefErr = (e: any): string => {
        const s = String(e?.reason || e?.message || e || '');
        if (/insufficient funds/i.test(s)) return 'insufficient funds';
        if (/intrinsic transaction cost/i.test(s)) return 'insufficient funds (gas)';
        if (/replacement fee too low|nonce/i.test(s)) return 'nonce / replacement fee too low';
        if (/transfer amount exceeds balance|ERC20|insufficient/i.test(s)) return 'insufficient token balance';
        if (/execution reverted/i.test(s)) return 'execution reverted';
        return s.split('\n')[0].slice(0, 200);
      };

      const tasks = wallets.map(async (w) => {
        const pendingMsg = await ctx.reply(`⏳ Sending buy for ${short(w.address)}…`);
        try {
          let preOut: bigint = 0n;
          let tokDec = 18;
          let tokSym = 'TOKEN';
          try {
            const meta = await tokenMeta(token);
            tokDec = meta.decimals ?? 18;
            tokSym = (meta.symbol || meta.name || 'TOKEN').toUpperCase();
            const preQuote = await bestQuoteBuy(amountIn, token);
            if (preQuote?.amountOut) {
              preOut = preQuote.amountOut;
              recordTrade(ctx.from.id, w.address, token, 'BUY', amountIn, preQuote.amountOut, preQuote.route.key);
            }
          } catch {}

          const autoBps = getAutoBuySlipBps(ctx.from.id);
          const minOut =
            preOut > 0n
              ? (autoBps === SLIP_AUTO
                  ? (preOut * 99n) / 100n
                  : (preOut * BigInt(10000 - autoBps)) / 10000n)
              : 0n;

          const gas = await computeGas(ctx.from.id);
          const r = await buyAutoRoute(getPrivateKey(w), token, amountIn, minOut, gas);
          const hash = (r as any)?.hash;

          if (hash) {
            const link = otter(hash);
            try {
              await editMsgTextSafe(ctx, chatId, pendingMsg.message_id, `transaction sent ${link}`);
            } catch {
              await ctx.reply(`transaction sent ${link}`);
            }

            if (token.toLowerCase() !== WPLS) {
              approveAllRouters(getPrivateKey(w), token, gas).catch(() => {});
            }

            provider.waitForTransaction(hash).then(async () => {
              try { await ctx.telegram.deleteMessage(chatId, pendingMsg.message_id); } catch {}
              await postTradeSuccess(ctx, {
                action: 'BUY',
                spend:   { amount: amountIn, decimals: 18, symbol: 'PLS' },
                receive: { amount: preOut,   decimals: tokDec, symbol: tokSym },
                tokenAddress: token,
                explorerUrl: link
              });
            }).catch(() => {/* ignore */});
          } else {
            try {
              await editMsgTextSafe(ctx, chatId, pendingMsg.message_id, 'transaction sent (no hash yet)');
            } catch {}
          }
        } catch (e: any) {
          const errText = `❌ Auto-buy failed for ${short(w.address)}: ${briefErr(e)}`;
          try {
            await editMsgTextSafe(ctx, chatId, pendingMsg.message_id, errText);
          } catch {
            await ctx.reply(errText);
          }
        }
      });

      await Promise.allSettled(tasks);

      await upsertPinnedPosition(ctx);
      return renderBuyMenu(ctx);
    } else {
      return renderBuyMenu(ctx);
    }
  }
  return next();
});

/* ---------- shortcuts ---------- */
bot.action('main_back', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  return renderHome(ctx);
});
bot.action('price', async (ctx) => { await ctx.answerCbQuery(); return showMenu(ctx, 'Use /price after setting a token.', mainMenu()); });
bot.action('balances', async (ctx) => { await ctx.answerCbQuery(); return showMenu(ctx, 'Use /balances after selecting a wallet.', mainMenu()); });

// no-op
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

export {};
