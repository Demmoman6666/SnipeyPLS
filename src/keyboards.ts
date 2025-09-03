import { Markup } from 'telegraf';

export const mainMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📄 Wallets', 'wallets'), Markup.button.callback('🛒 Buy', 'menu_buy'), Markup.button.callback('💱 Sell', 'menu_sell')],
    [Markup.button.callback('⚙️ Settings', 'settings'), Markup.button.callback('💹 Price', 'price'), Markup.button.callback('📊 Balances', 'balances')],
  ]);

export const buyMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💧 Set Token', 'buy_set_token'), Markup.button.callback('💰 Set Amount', 'buy_set_amount')],
    [Markup.button.callback('➖ Gas %', 'gas_pct_down'), Markup.button.callback('↩️ Reset', 'gas_pct_reset'), Markup.button.callback('➕ Gas %', 'gas_pct_up')],
    [Markup.button.callback('👛 Choose Wallet', 'choose_wallet')],
    // Removed approve here (PLS/WPLS buys don’t need it)
    [Markup.button.callback('✅ Buy Now', 'buy_exec'), Markup.button.callback('🧑‍🤝‍🧑 Buy All Wallets', 'buy_exec_all')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);

export const sellMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('25%', 'sell_pct_25'), Markup.button.callback('50%', 'sell_pct_50'), Markup.button.callback('75%', 'sell_pct_75'), Markup.button.callback('100%', 'sell_pct_100')],
    // Keep approve here (selling ERC-20 needs allowance)
    [Markup.button.callback('✅ Approve (Sell)', 'approve_now'), Markup.button.callback('💸 Sell Now', 'sell_exec')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);

export const settingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⛽ Gas Limit', 'set_gl'), Markup.button.callback('⚡ Gwei Booster', 'set_gb')],
    [Markup.button.callback('📈 Default Gas %', 'set_defpct')],
    [Markup.button.callback('🤖 Auto-buy Toggle', 'auto_toggle'), Markup.button.callback('💵 Auto-buy Amount', 'auto_amt')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);
