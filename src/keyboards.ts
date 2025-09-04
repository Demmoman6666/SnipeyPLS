// src/keyboards.ts
import { Markup } from 'telegraf';

/** Main menu */
export function mainMenu() {
  return Markup.inlineKeyboard([
    // Row 1
    [Markup.button.callback('🟢 Buy', 'menu_buy'),
     Markup.button.callback('🔴 Sell', 'menu_sell')],
    // Row 2
    [Markup.button.callback('👛 Wallets', 'wallets'),
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
    [Markup.button.callback('⬅️ Back', 'main_back'),
     Markup.button.callback('🔴 Sell Now', 'sell_exec')],
  ]);
}
