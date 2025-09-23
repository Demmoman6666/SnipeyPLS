// src/keyboards.ts
import { Markup } from 'telegraf';

/** Main menu */
export function mainMenu() {
  return Markup.inlineKeyboard([
    // Row 1
    [Markup.button.callback('🟢 Buy', 'menu_buy'),
     Markup.button.callback('🔴 Sell', 'menu_sell')],

    // Row 2 (Pump.Tires, Snipey, Positions)
    [Markup.button.callback('Pump.Tires (Soon)', 'noop'),
     Markup.button.callback('🎯 Snipey', 'menu_snipe'),
     Markup.button.callback('📊 Positions', 'positions')],

    // Row 3 (Wallets, Rewards, Settings)
    [Markup.button.callback('👛 Wallets', 'wallets'),
     Markup.button.callback('🤝 Rewards', 'referrals'),
     Markup.button.callback('⚙️ Settings', 'settings')],
  ]);
}

/** Settings */
export function settingsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Back', 'main_back')],
    [Markup.button.callback('⛽ Gas Limit', 'set_gl'), Markup.button.callback('⚡ Gwei Booster', 'set_gb')],
    [Markup.button.callback('📈 Default Gas %', 'set_defpct'), Markup.button.callback('🤖 Auto-buy', 'auto_toggle')],
    [Markup.button.callback('🧮 Auto-buy amount', 'auto_amt')],
  ]);
}

/** Gas % quick picker */
export function buyGasPctMenu() {
  const mk = (n: number) =>
    Markup.button.callback(n === 0 ? 'Reset (0%)' : (n > 0 ? `+${n}%` : `${n}%`), `gas_pct_set:${n}`);
  return Markup.inlineKeyboard([
    [mk(-25), mk(-10), mk(-5), mk(0), mk(+5), mk(+10), mk(+25)],
    [Markup.button.callback('⬅️ Back', 'menu_buy')],
  ]);
}

/**
 * Buy menu keyboard.
 * `walletRows` are rows of wallet toggle buttons (W1..Wn).
 */
export function buyMenu(gasPct: number, walletRows?: any[][]) {
  const rows: any[][] = [];

  // Top gas pill
  rows.push([Markup.button.callback(`⛽ Gas % (${gasPct}%)`, 'gas_pct_open')]);

  // Back / Refresh
  rows.push([Markup.button.callback('⬅️ Back', 'main_back'), Markup.button.callback('🔄 Refresh', 'buy_refresh')]);

  // Unclickable EDIT pill
  rows.push([Markup.button.callback('•  EDIT BUY DATA  •', 'noop')]);

  // Contract / Pair
  rows.push([Markup.button.callback('📄 Contract', 'buy_set_token'), Markup.button.callback('🔗 Pair', 'pair_info')]);

  // Wallets pill + toggles
  rows.push([Markup.button.callback('•  Wallets  •', 'noop')]);
  if (walletRows?.length) rows.push(...walletRows);

  // Amount & Buy All Wallets
  rows.push([Markup.button.callback('🔢 Amount', 'buy_set_amount'),
             Markup.button.callback('🛒 Buy All Wallets', 'buy_exec_all')]);

  // Limit Buy + Orders
  rows.push([Markup.button.callback('🧭 Limit Buy', 'limit_buy'),
             Markup.button.callback('📋 Orders', 'limit_list')]);

  // Single bottom “Buy Now” pill
  rows.push([Markup.button.callback('✅ Buy Now', 'buy_exec')]);

  return Markup.inlineKeyboard(rows);
}

/** Sell menu keyboard */
export function sellMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('25%', 'sell_pct_25'),
     Markup.button.callback('50%', 'sell_pct_50'),
     Markup.button.callback('75%', 'sell_pct_75'),
     Markup.button.callback('100%', 'sell_pct_100')],

    // Keep other actions first
    [Markup.button.callback('🧭 Limit Sell', 'limit_sell'),
     Markup.button.callback('📋 Orders', 'limit_list')],

    // Approve row
    [Markup.button.callback('🛡 Approve', 'sell_approve')],

    // Sell Now row (unchanged)
    [Markup.button.callback('⬅️ Back', 'main_back'),
     Markup.button.callback('🔴 Sell Now', 'sell_exec')],
  ]);
}

/** Trigger picker for limits */
export function limitTriggerMenu(side: 'BUY' | 'SELL') {
  const base = [
    Markup.button.callback('PLS Price', 'limit_trig:PLS'),
    Markup.button.callback('USD Price', 'limit_trig:USD'),
    Markup.button.callback('Market Cap', 'limit_trig:MCAP'),
  ];
  const rows: any[][] = [];
  rows.push(base);
  if (side === 'SELL') {
    rows.push([Markup.button.callback('Profit × Multiplier', 'limit_trig:MULT')]);
  }
  rows.push([Markup.button.callback('⬅️ Back', side === 'BUY' ? 'menu_buy' : 'menu_sell')]);
  return Markup.inlineKeyboard(rows);
}

/** Referrals menu */
export function referralMenu(link?: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔗 Your Referral Link', link || 'https://t.me/')],
    [Markup.button.callback('📊 Refresh', 'ref_refresh'),
     Markup.button.callback('⬅️ Back', 'main_back')],
  ]);
}

/** Snipe menu (needed by bot.ts) */
export function snipeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄 Paste Contract (CA)', 'buy_set_token')],
    [Markup.button.callback('🤖 Toggle Auto-Buy', 'auto_toggle')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);
}

/* ------------------------------------------------------------------ */
/* ------------------------- POSITIONS VIEW -------------------------- */
/* ------------------------------------------------------------------ */

/** Data shape for rendering positions text + keyboard */
export interface PositionItemView {
  id: string;            // token identifier (contract or internal id)
  symbol: string;        // e.g. "TOM"
  trend?: string;        // e.g. "📈" | "📉"
  positionValue: string; // e.g. "0.0025 PLS ($0.56)"
  expanded?: boolean;

  contract?: string;
  priceUsd?: string;
  mcapUsd?: string;
  avgEntryUsd?: string;
  avgEntryMcapUsd?: string;
  balance?: string;
  buysValue?: string;
  buysCount?: number;
  sellsValue?: string | null;
  sellsCount?: number;
  pnlUsdPct?: string;
  pnlUsdAbs?: string;
  pnlUsdUp?: boolean;
  pnlPlsPct?: string;
  pnlPlsAbs?: string;
  pnlPlsUp?: boolean;
}

export interface PositionsViewState {
  walletIndex: number;       // 1-based
  walletCount: number;
  walletLabel: string;       // e.g. "W1"
  walletAddress: string;
  walletBalance: string;
  positionsTotal: string;
  items: PositionItemView[];
  sortLabel?: string;        // e.g. "By: Value" / "By: PnL"
}

/** HTML escape */
function esc(s: string | undefined | null) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the Positions text body (HTML parse_mode) */
export function renderPositionsMessage(v: PositionsViewState): string {
  const header =
    `<b>Manage your tokens ${v.walletIndex}/${v.walletCount}⠀ — ${esc(v.walletLabel)}</b>\n` +
    `Wallet: <code>${esc(v.walletAddress)}</code> — ${esc(v.walletLabel)} ✏️\n` +
    `Balance: ${esc(v.walletBalance)}\n` +
    `Positions: ${esc(v.positionsTotal)}\n`;

  const blocks = v.items.map((it) => {
    const title = `${esc(it.symbol)} - ${esc(it.trend || '')} - ${esc(it.positionValue)} [${it.expanded ? 'Hide' : 'Show'}]`;
    if (!it.expanded) return title;

    const pnlUsdBadge = it.pnlUsdUp === false ? '🟥' : '🟩';
    const pnlPlsBadge = it.pnlPlsUp === false ? '🟥' : '🟩';
    const sellsValue = it.sellsValue ?? 'N/A';

    return [
      title,
      esc(it.contract || ''),
      `• Price &amp; MC: ${esc(it.priceUsd || '—')} — ${esc(it.mcapUsd || '—')}`,
      `• Avg Entry: ${esc(it.avgEntryUsd || '—')} — ${esc(it.avgEntryMcapUsd || '—')}`,
      `• Balance: ${esc(it.balance || '—')}`,
      `• Buys: ${esc(it.buysValue || 'N/A')} • (${it.buysCount ?? 0} buys)`,
      `• Sells: ${esc(sellsValue)} • (${it.sellsCount ?? 0} sells)`,
      `• PNL USD: ${esc(it.pnlUsdPct || '—')} ${esc(it.pnlUsdAbs || '')} ${pnlUsdBadge}`,
      `• PNL PLS: ${esc(it.pnlPlsPct || '—')} ${esc(it.pnlPlsAbs || '')} ${pnlPlsBadge}`,
      'PNL Card 🖼️',
    ].join('\n');
  });

  const tip = '\n💡 Click a token symbol to open quick actions.';
  return [header, ...blocks, tip].join('\n\n').trim();
}

/**
 * POSITIONS LIST keyboard (screen 1)
 * - Back / Refresh
 * - Prev / Rename / Next wallet
 * - Sort toggle
 * - Token rows: [SYMBOL — trend — value] ➜ opens per-token actions
 * - Each token also has [Show/Hide] + [PNL Card]
 */
export function positionsMenu(v: PositionsViewState) {
  const rows: any[][] = [];

  rows.push([Markup.button.callback('⬅️ Back', 'main_back'),
             Markup.button.callback('🔄 Refresh', 'pos_refresh')]);

  rows.push([
    Markup.button.callback('◀️ Prev', 'pos_wallet_prev'),
    Markup.button.callback(`✏️ Rename ${v.walletLabel}`, 'pos_wallet_edit'),
    Markup.button.callback('Next ▶️', 'pos_wallet_next'),
  ]);

  rows.push([Markup.button.callback(`↕️ Sort: ${v.sortLabel || 'By: Value'}`, 'pos_sort_toggle')]);

  for (const it of v.items) {
    const title = `${it.symbol} — ${it.trend || ''} — ${it.positionValue}`;
    // OPEN PER-TOKEN ACTIONS (its own menu)
    rows.push([Markup.button.callback(title.trim(), `pos_token:${it.id}`)]);
    rows.push([
      Markup.button.callback(it.expanded ? 'Hide' : 'Show', `pos_toggle:${it.id}`),
      Markup.button.callback('PNL Card 🖼️', `pos_pnl_card:${it.id}`),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

/* --------------------- PER-TOKEN ACTIONS (screen 2) --------------------- */

export interface TokenActionsView {
  id: string;                 // same id passed from positions list
  symbol: string;             // e.g. "TOM"
  nativeSymbol?: 'PLS' | 'WPLS' | string; // label for native
  // Quick native buy amounts (strings to display & use in callbacks)
  quickBuyAmts?: string[];    // e.g. ['0.5','1','5']
}

/**
 * Actions keyboard for a single token selected from Positions.
 * Includes: quick buys in native, % sells, approve, back/refresh.
 * You can wire callbacks in bot.ts to your existing buy/sell flows.
 */
export function positionsTokenMenu(v: TokenActionsView) {
  const native = v.nativeSymbol || 'PLS';
  const amts = v.quickBuyAmts && v.quickBuyAmts.length ? v.quickBuyAmts : ['0.5', '1', '5'];

  const rows: any[][] = [];

  // Quick Buys (native)
  rows.push(amts.map(a =>
    Markup.button.callback(`Buy ${a} ${native}`, `pos_buy_amt:${v.id}:${a}`)
  ));

  // Quick % Sells
  rows.push([
    Markup.button.callback('Sell 25 %', `pos_sell_pct:${v.id}:25`),
    Markup.button.callback('Sell 50 %', `pos_sell_pct:${v.id}:50`),
    Markup.button.callback('Sell 75 %', `pos_sell_pct:${v.id}:75`),
    Markup.button.callback('Sell 100 %', `pos_sell_pct:${v.id}:100`),
  ]);

  // Extra actions row (customize as needed)
  rows.push([
    Markup.button.callback('🛡 Approve', `pos_approve:${v.id}`),
    Markup.button.callback('⚙️ More…', `pos_more:${v.id}`),
  ]);

  // Nav
  rows.push([
    Markup.button.callback('⬅️ Back', 'positions'),   // back to list
    Markup.button.callback('🔄 Refresh', `pos_token_refresh:${v.id}`),
  ]);

  return Markup.inlineKeyboard(rows);
}
