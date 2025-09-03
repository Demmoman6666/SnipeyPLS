import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import { mainMenu, buyMenu } from './keyboards.js';
import {
  listWallets,
  createWallet,
  importWallet,
  setActiveWallet,
  getActiveWallet,
  setToken,
  setGas,
  getUserSettings,
  getPrivateKey,
  setBuyAmount,
} from './wallets.js';
import { ethers } from 'ethers';
import {
  provider,
  getPrice,
  buyExactETHForTokens,
  sellExactTokensForETH,
  erc20,
  approveToken,
} from './dex.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

// minimal in-memory prompt state for DM replies
const pending: Map<number, { type: 'set_amount' | 'set_token' }> = new Map();

function fmtAddress(addr?: string | null) {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—';
}

async function renderBuyMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const aw = getActiveWallet(ctx.from.id);
  const pri = u?.max_priority_fee_gwei ?? 0.1;
  const max = u?.max_fee_gwei ?? 0.2;
  const gl  = u?.gas_limit ?? 250000;
  const amt = (u?.buy_amount_pls ?? 0.01);
  const lines = [
    '//// BUY MENU ////',
    `Wallet: ${aw ? fmtAddress(aw.address) : '— (Select)'} `,
    `Token: ${fmtAddress(u?.token_address)}`,
    `Base: WPLS`,
    `Amount: ${amt} PLS`,
    `Gas: priority=${pri} gwei, max=${max} gwei, gasLimit=${gl}`,
  ];
  await ctx.reply(lines.join('\n'), buyMenu());
}

bot.start(async (ctx) => {
  await ctx.reply('Welcome to PulseChain Trading Bot. Use commands or the menu below.', mainMenu());
});

/** Wallets (unchanged) **/
bot.command('wallets', async (ctx) => {
  const rows = listWallets(ctx.from.id);
  if (rows.length === 0) {
    return ctx.reply('No wallets yet. Use /wallet_new <name> or /wallet_import <name> <privkey>');
  }
  const u = getUserSettings(ctx.from.id);
  const lines = rows
    .map((r) => `${r.id}. ${r.name} — ${r.address}${u?.active_wallet_id === r.id ? ' (active)' : ''}`)
    .join('\n');
  return ctx.reply(lines);
});

bot.command('wallet_new', async (ctx) => {
  const [_, name] = ctx.message.text.split(/\s+/, 2);
  if (!name) return ctx.reply('Usage: /wallet_new <name>');
  const w = createWallet(ctx.from.id, name);
  return ctx.reply(`Created wallet "${name}": ${w.address}`);
});

bot.command('wallet_import', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 3) return ctx.reply('Usage: /wallet_import <name> <privkey>');
  const name = parts[1];
  const pk = parts[2];
  try {
    const w = importWallet(ctx.from.id, name, pk);
    return ctx.reply(`Imported wallet "${name}": ${w.address}`);
  } catch (e: any) {
    return ctx.reply('Import failed: ' + e.message);
  }
});

bot.command('wallet_select', async (ctx) => {
  const [_, idOrName] = ctx.message.text.split(/\s+/, 2);
  if (!idOrName) return ctx.reply('Usage: /wallet_select <id|name>');
  try {
    const id = setActiveWallet(ctx.from.id, idOrName);
    return ctx.reply('Active wallet set to ID ' + id);
  } catch (e: any) {
    return ctx.reply('Select failed: ' + e.message);
  }
});

/** Settings (unchanged) **/
bot.command('set_token', (ctx) => {
  const [_, address] = ctx.message.text.split(/\s+/, 2);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return ctx.reply('Usage: /set_token <0xAddress>');
  setToken(ctx.from.id, address);
  return ctx.reply('Token set to ' + address);
});

bot.command('set_gas', (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 4) return ctx.reply('Usage: /set_gas <priority_gwei> <max_gwei> <gas_limit>');
  const [priority, max, limit] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![priority, max, limit].every((n) => Number.isFinite(n) && n > 0))
    return ctx.reply('Invalid numbers.');
  setGas(ctx.from.id, priority, max, limit);
  return ctx.reply(`Gas set. priority=${priority} gwei, max=${max} gwei, gasLimit=${limit}`);
});

/** Info **/
bot.command('price', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  const amountInWei = ethers.parseEther('1'); // 1 WPLS
  try {
    const amounts = await getPrice(amountInWei, [process.env.WPLS_ADDRESS!, u.token_address]);
    return ctx.reply(`1 WPLS -> ${ethers.formatUnits(amounts[1], 18)} tokens (raw: ${amounts[1]})`);
  } catch (e: any) {
    return ctx.reply('Price failed: ' + e.message);
  }
});

bot.command('balances', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.reply('Select a wallet first.');
  const addr = w.address;
  const u = getUserSettings(ctx.from.id);
  const plsBal = await provider.getBalance(addr);
  let token = 'N/A';
  if (u?.token_address) {
    const erc = erc20(u.token_address);
    const [bal, dec, sym] = await Promise.all([
      erc.balanceOf(addr),
      erc.decimals().catch(() => 18),
      erc.symbol().catch(() => 'TOKEN'),
    ]);
    token = `${ethers.formatUnits(bal, dec)} ${sym}`;
  }
  return ctx.reply(`Wallet ${addr}\nPLS: ${ethers.formatEther(plsBal)}\nToken: ${token}`);
});

/** === MENUS === **/
bot.action('menu_buy', async (ctx) => {
  await renderBuyMenu(ctx);
});

bot.action('main_back', async (ctx) => {
  await ctx.reply('Back to main.', mainMenu());
});

/** Buy menu controls **/
bot.action('buy_set_amount', async (ctx) => {
  pending.set(ctx.from.id, { type: 'set_amount' });
  return ctx.reply('Reply with the PLS amount to spend on each buy (e.g., `0.02`).', { parse_mode: 'Markdown' });
});
bot.action('buy_set_token', async (ctx) => {
  pending.set(ctx.from.id, { type: 'set_token' });
  return ctx.reply('Reply with the token contract address (0x…).');
});

bot.on('text', async (ctx, next) => {
  const p = pending.get(ctx.from.id);
  if (!p) return next();

  if (p.type === 'set_amount') {
    const v = Number(String(ctx.message.text).trim());
    if (!Number.isFinite(v) || v <= 0) return ctx.reply('Please send a positive number (e.g., 0.02).');
    setBuyAmount(ctx.from.id, v);
    pending.delete(ctx.from.id);
    await ctx.reply(`Buy amount set to ${v} PLS.`);
    return renderBuyMenu(ctx);
  }
  if (p.type === 'set_token') {
    const adr = String(ctx.message.text).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(adr)) return ctx.reply('That does not look like a valid 0x address.');
    setToken(ctx.from.id, adr);
    pending.delete(ctx.from.id);
    await ctx.reply(`Token set to ${adr}`);
    return renderBuyMenu(ctx);
  }
});

/** Gas nudges from menu **/
function nudgeGas(ctx: any, dPri: number, dMax: number, dGL: number) {
  const u = getUserSettings(ctx.from.id);
  const pri = Math.max(0.01, (u?.max_priority_fee_gwei ?? 0.1) + dPri);
  const max = Math.max(0.01, (u?.max_fee_gwei ?? 0.2) + dMax);
  const gl = Math.max(21000, (u?.gas_limit ?? 250000) + dGL);
  setGas(ctx.from.id, Number(pri.toFixed(4)), Number(max.toFixed(4)), gl);
}
bot.action('gas_pri_up',  async (ctx) => { nudgeGas(ctx, +0.05, 0, 0); return renderBuyMenu(ctx); });
bot.action('gas_pri_down',async (ctx) => { nudgeGas(ctx, -0.05, 0, 0); return renderBuyMenu(ctx); });
bot.action('gas_max_up',  async (ctx) => { nudgeGas(ctx, 0, +0.10, 0); return renderBuyMenu(ctx); });
bot.action('gas_max_down',async (ctx) => { nudgeGas(ctx, 0, -0.10, 0); return renderBuyMenu(ctx); });
bot.action('gas_limit_up',async (ctx) => { nudgeGas(ctx, 0, 0, +25000); return renderBuyMenu(ctx); });
bot.action('gas_limit_down',async (ctx) => { nudgeGas(ctx, 0, 0, -25000); return renderBuyMenu(ctx); });

/** Approve from menu **/
bot.action('approve_now', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!w || !u?.token_address) return ctx.reply('Need active wallet and token set.');
  try {
    const receipt = await approveToken(
      getPrivateKey(w),
      u.token_address,
      process.env.ROUTER_ADDRESS!,
      (2n ** 256n - 1n),
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      },
    );
    await ctx.reply('Approve tx: ' + receipt.transactionHash);
  } catch (e: any) {
    await ctx.reply('Approve failed: ' + e.message);
  }
  return renderBuyMenu(ctx);
});

/** Choose wallet submenu **/
bot.action('choose_wallet', async (ctx) => {
  const rows = listWallets(ctx.from.id);
  if (!rows.length) return ctx.reply('No wallets yet. Use /wallet_new <name> or /wallet_import <name> <privkey>');
  const buttons = rows.map(w => [Markup.button.callback(`${w.id}. ${w.name} ${fmtAddress(w.address)}`, `select_wallet:${w.id}`)]);
  buttons.push([Markup.button.callback('⬅️ Back', 'menu_buy')]);
  return ctx.reply('Select a wallet to set active:', Markup.inlineKeyboard(buttons));
});
bot.action(/^select_wallet:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  try {
    const setId = setActiveWallet(ctx.from.id, String(id));
    await ctx.reply(`Active wallet set to ID ${setId}.`);
  } catch (e: any) {
    await ctx.reply('Select failed: ' + e.message);
  }
  return renderBuyMenu(ctx);
});

/** Execute buy from menu (uses stored amount) **/
bot.action('buy_exec', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  if (!w) return ctx.reply('Select a wallet first.');
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  try {
    const receipt = await buyExactETHForTokens(
      getPrivateKey(w),
      u.token_address,
      ethers.parseEther(String(amt)),
      0n,
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      },
    );
    await ctx.reply('Buy tx: ' + receipt.transactionHash);
  } catch (e: any) {
    await ctx.reply('Buy failed: ' + e.message);
  }
  return renderBuyMenu(ctx);
});

bot.action('buy_exec_all', async (ctx) => {
  const rows = listWallets(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  if (!rows.length) return ctx.reply('No wallets yet. Use /wallet_new or /wallet_import.');
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  const results: string[] = [];
  for (const row of rows) {
    try {
      const receipt = await buyExactETHForTokens(
        getPrivateKey(row),
        u.token_address,
        ethers.parseEther(String(amt)),
        0n,
        {
          maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
          maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
          gasLimit: BigInt(u.gas_limit ?? 250000),
        },
      );
      results.push(`✅ ${fmtAddress(row.address)} -> ${receipt.transactionHash}`);
    } catch (e: any) {
      results.push(`❌ ${fmtAddress(row.address)} -> ${e.message}`);
    }
  }
  await ctx.reply(results.join('\n'));
  return renderBuyMenu(ctx);
});

/** Existing quick command sells still work **/
bot.command('sell', async (ctx) => {
  const [_, percentStr] = ctx.message.text.split(/\s+/, 2);
  const percent = Number(percentStr);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
    return ctx.reply('Usage: /sell <percent 1-100>');
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!w || !u?.token_address) return ctx.reply('Need active wallet and token set.');
  try {
    const erc = erc20(u.token_address);
    const [bal] = await Promise.all([erc.balanceOf(w.address)]);
    const amount = (bal * BigInt(percent)) / 100n;
    const receipt = await sellExactTokensForETH(
      getPrivateKey(w),
      u.token_address,
      amount,
      0n,
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      },
    );
    return ctx.reply('Sell tx: ' + receipt.transactionHash);
  } catch (e: any) {
    return ctx.reply('Sell failed: ' + e.message);
  }
});

/** Shortcuts back to sections from main **/
bot.action('wallets', (ctx) =>
  ctx.reply('Use /wallets, /wallet_new, /wallet_import, /wallet_select'),
);
bot.action('sell', (ctx) => ctx.reply('Use /sell <percent>'));
bot.action('settings', (ctx) =>
  ctx.reply('Use /set_token <addr> and /set_gas <priority> <max> <limit>'),
);
bot.action('price', (ctx) => ctx.reply('Use /price after setting token.'));
bot.action('balances', (ctx) => ctx.reply('Use /balances after selecting a wallet.'));
