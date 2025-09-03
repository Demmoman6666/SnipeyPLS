import { Markup } from 'telegraf';

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

/** Buy menu (Pulseonic-style layout) */
export const buyMenu = () =>
  Markup.inlineKeyboard([
    // Top row: Gas picker + Back + Refresh
    [
      Markup.button.callback('⛽️ Gas ± %', 'buy_gas_picker'),
      Markup.button.callback('⬅️ Back', 'main_back'),
      Markup.button.callback('🔄 Refresh', 'buy_refresh'),
    ],

    // Non-clickable label (we’ll ignore the noop action)
    [Markup.button.callback('———  EDIT BUY DATA  ———', 'noop')],

    // Edit data row
    [
      Markup.button.callback('🧾 Contract', 'buy_set_token'),
      Markup.button.callback('🧩 Pair', 'pair_info'),
      Markup.button.callback('💰 Amount In', 'buy_set_amount'),
    ],

    // Utility
    [Markup.button.callback('👛 Choose Wallet', 'choose_wallet')],

    // Primary actions
    [
      Markup.button.callback('✅ Buy Now', 'buy_exec'),
      Markup.button.callback('✅ Buy All Wallets', 'buy_exec_all'),
    ],
  ]);

/** Gas percent quick picker */
export const gasPercentMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('5%', 'gas_pct_set:5'),
      Markup.button.callback('10%', 'gas_pct_set:10'),
      Markup.button.callback('15%', 'gas_pct_set:15'),
      Markup.button.callback('25%', 'gas_pct_set:25'),
      Markup.button.callback('50%', 'gas_pct_set:50'),
    ],
    [
      Markup.button.callback('Reset to Default', 'gas_pct_reset'),
      Markup.button.callback('Custom…', 'gas_pct_custom'),
    ],
    [Markup.button.callback('⬅️ Back', 'menu_buy')],
  ]);

/** Sell menu (unchanged layout except no approve in buy) */
export const sellMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Back', 'main_back'),
      Markup.button.callback('🔄 Refresh', 'sell_refresh'),
    ],
    [
      Markup.button.callback('25%', 'sell_pct_25'),
      Markup.button.callback('50%', 'sell_pct_50'),
      Markup.button.callback('75%', 'sell_pct_75'),
      Markup.button.callback('100%', 'sell_pct_100'),
    ],
    [Markup.button.callback('✅ Sell Now', 'sell_exec')],
  ]);

export const settingsMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⛽️ Gas Limit', 'set_gl'),
      Markup.button.callback('⚡️ Gwei Booster', 'set_gb'),
    ],
    [Markup.button.callback('⛽️ Default Gas %', 'set_defpct')],
    [
      Markup.button.callback('🤖 Auto-buy On/Off', 'auto_toggle'),
      Markup.button.callback('💸 Auto-buy Amount', 'auto_amt'),
    ],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);
