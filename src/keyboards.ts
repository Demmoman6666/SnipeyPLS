// src/keyboards.ts
import { Markup } from 'telegraf';

/**
 * Main menu
 */
export const mainMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('📄 Wallets', 'wallets'),
      Markup.button.callback('🛒 Buy', 'menu_buy'),
      Markup.button.callback('💱 Sell', 'menu_sell'),
    ],
    [
      Markup.button.callback('⚙️ Settings', 'settings'),
      Markup.button.callback('📈 Price', 'price'),
      Markup.button.callback('📊 Balances', 'balances'),
    ],
  ]);

/**
 * Buy menu keyboard (compact, Pulseonic-style)
 * @param gasPct current gas over-market %
 */
export const buyMenu = (gasPct: number) => {
  // Top single pill → opens the selector screen
  const top = [Markup.button.callback(`⛽️ Gas ±% (${gasPct}% )`, 'gas_pct_open')];

  const nav = [
    Markup.button.callback('⬅️ Back', 'main_back'),
    Markup.button.callback('🔄 Refresh', 'buy_refresh'),
  ];

  // Disabled “pill” – we use a no-op handler
  const editPill = [Markup.button.callback('• EDIT BUY DATA •', 'noop')];

  const infoRow = [
    Markup.button.callback('🧾 Contract', 'buy_set_token'),
    Markup.button.callback('🧩 Pair', 'pair_info'),
  ];

  const actions1 = [
    Markup.button.callback('👛 Choose Wallet', 'choose_wallet'),
    Markup.button.callback('💰 Amount', 'buy_set_amount'),
  ];

  const actions2 = [
    Markup.button.callback('✅ Buy Now', 'buy_exec'),
    Markup.button.callback('✅ Buy All Wallets', 'buy_exec_all'),
  ];

  return Markup.inlineKeyboard([top, nav, editPill, infoRow, actions1, actions2]);
};

/**
 * Separate screen: choose a gas % boost.
 */
export const buyGasPctMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('−10%', 'gas_pct_set:-10'),
      Markup.button.callback('0%', 'gas_pct_set:0'),
      Markup.button.callback('+5%', 'gas_pct_set:5'),
    ],
    [
      Markup.button.callback('+10%', 'gas_pct_set:10'),
      Markup.button.callback('+25%', 'gas_pct_set:25'),
      Markup.button.callback('+50%', 'gas_pct_set:50'),
    ],
    [
      Markup.button.callback('+100%', 'gas_pct_set:100'),
      Markup.button.callback('Back', 'menu_buy'),
    ],
  ]);

/**
 * Sell menu (unchanged behaviour)
 */
export const sellMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Back', 'main_back'),
      Markup.button.callback('🔄 Refresh', 'menu_sell'),
    ],
    [
      Markup.button.callback('Sell 25%', 'sell_pct_25'),
      Markup.button.callback('Sell 50%', 'sell_pct_50'),
      Markup.button.callback('Sell 75%', 'sell_pct_75'),
      Markup.button.callback('Sell 100%', 'sell_pct_100'),
    ],
    [Markup.button.callback('✅ Sell', 'sell_exec')],
  ]);

export const settingsMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Back', 'main_back'),
      Markup.button.callback('🔄 Refresh', 'settings'),
    ],
    [
      Markup.button.callback('Gas Limit', 'set_gl'),
      Markup.button.callback('Gwei Booster', 'set_gb'),
    ],
    [Markup.button.callback('Default Gas %', 'set_defpct')],
    [
      Markup.button.callback('Auto-Buy Toggle', 'auto_toggle'),
      Markup.button.callback('Auto-Buy Amount', 'auto_amt'),
    ],
  ]);
