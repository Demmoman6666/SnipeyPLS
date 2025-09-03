import { Markup } from 'telegraf';

export const mainMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📄 Wallets', 'wallets'), Markup.button.callback('🛒 Buy', 'buy'), Markup.button.callback('💱 Sell', 'sell')],
    [Markup.button.callback('⚙️ Settings', 'settings'), Markup.button.callback('💹 Price', 'price'), Markup.button.callback('📊 Balances', 'balances')],
  ]);
