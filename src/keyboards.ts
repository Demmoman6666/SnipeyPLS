// src/keyboards.ts
import { Markup } from 'telegraf';

export const mainMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('📄 Wallets', 'wallets'),
      Markup.button.callback('🛒 Buy', 'menu_buy'),
      Markup.button.callback('💱 Sell', 'sell'),
    ],
    [
      Markup.button.callback('⚙️ Settings', 'settings'),
      Markup.button.callback('💹 Price', 'price'),
      Markup.button.callback('📊 Balances', 'balances'),
    ],
  ]);

// Nested Buy menu (WPLS-only)
export const buyMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Buy', 'buy_exec'), Markup.button.callback('🟢 Buy (All Wallets)', 'buy_exec_all')],
    [Markup.button.callback('🧩 Set Token', 'buy_set_token'), Markup.button.callback('💰 Set Amount', 'buy_set_amount')],
    [Markup.button.callback('⚡️ Pri +', 'gas_pri_up'), Markup.button.callback('⚡️ Pri −', 'gas_pri_down')],
    [Markup.button.callback('⛽️ Max +', 'gas_max_up'), Markup.button.callback('⛽️ Max −', 'gas_max_down')],
    [Markup.button.callback('🧱 GasLimit +', 'gas_limit_up'), Markup.button.callback('🧱 GasLimit −', 'gas_limit_down')],
    [Markup.button.callback('✅ Approve', 'approve_now'), Markup.button.callback('👛 Choose Wallet', 'choose_wallet')],
    [Markup.button.callback('⬅️ Back', 'main_back')],
  ]);
