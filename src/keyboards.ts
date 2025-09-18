// src/keyboards.ts
import { Markup } from 'telegraf';

/** Main menu */
export function mainMenu() {
  return Markup.inlineKeyboard([
   
    [Markup.button.callback('🟢 Buy', 'menu_buy'),
     Markup.button.callback('🔴 Sell', 'menu_sell')],
    
    [Markup.button.callback('👛 Wallets', 'wallets'),
     Markup.button.callback('🎯 Snipey', 'menu_snipe')],
    // Row 3
    [Markup.button.callback('🤝 Referrals', 'referrals'),
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
    [Markup.button.callback('🛡 Approve', 'sell_approve')],
    [Markup.button.callback('🧭 Limit Sell', 'limit_sell'),
     Markup.button.callback('📋 Orders', 'limit_list')],
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
