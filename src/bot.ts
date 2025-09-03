// src/bot.ts
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
  getWalletById,
  removeWallet,
} from './wallets.js';
import { ethers } from 'ethers';
import {
  provider,
  getPrice,
  buyExactETHForTokens,
  sellExactTokensForETH,
  erc20,
  approveToken,
  clearPendingTransactions,
  withdrawPls,
  pingRpc,
} from './dex.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

/* ----------------------- small UI helpers ----------------------- */

const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const fmtPls = (wei: bigint) => (wei === 0n ? '0' : ethers.formatEther(wei));

function canEdit(ctx: any) {
  return Boolean(ctx?.callbackQuery?.message?.message_id);
}

// Merge a keyboard (Markup.inlineKeyboard(...)) with extra (e.g., parse_mode)
function withKb(kb?: any, extra?: any) {
  return kb ? { ...(kb as any), ...(extra || {}) } : (extra || {});
}

// Edit the pressed message if possible; otherwise send a new one.
// Falls back to reply if edit fails (e.g., "message is not modified" or too old).
async function sendOrEdit(ctx: any, text: string, extra?: any) {
  if (canEdit(ctx)) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (e: any) {
      // If edit fails, try to delete then send fresh (best-effort)
      try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch {}
      return await ctx.reply(text, extra);
    }
  } else {
    return await ctx.reply(text, extra);
  }
}

/* ----------------------- balances (timeout) ----------------------- */

const BAL_TIMEOUT_MS = 8000;
function withTimeout<T>(p: Promise<T>, ms = BAL_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
// Always return something; if RPC fails, value=0n and ok=false.
async function getBalanceFast(address: string): Promise<{ value: bigint; ok: boolean }> {
  try {
    const v = await withTimeout(provider.getBalance(address));
    return { value: v, ok: true };
  } catch {
    return { value: 0n, ok: false };
  }
}

/* ----------------------- pending prompts ----------------------- */

type Pending =
  | { type: 'set_amount' }
  | { type: 'set_token' }
  | { type: 'gen_name' }
  | { type: 'import_wallet' }
  | { type: 'withdraw'; walletId: number };
const pending = new Map<number, Pending>();

/* ----------------------- /start ----------------------- */

bot.start(async (ctx) => {
  await ctx.reply('Main Menu', mainMenu());
});

/* ----------------------- Wallets: list & manage ----------------------- */

async function renderWalletsList(ctx: any) {
  const rows = listWallets(ctx.from.id);

  if (!rows.length) {
    return sendOrEdit(
      ctx,
      'No wallets yet.',
      withKb(
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')],
          [Markup.button.callback('⬅️ Back', 'main_back')],
        ])
      )
    );
  }

  const results = await Promise.all(rows.map(w => getBalanceFast(w.address)));
  const u = getUserSettings(ctx.from.id);

  const lines = [
    'Your Wallets',
    '',
    'Address                              | Balance (PLS)',
    '-------------------------------------|----------------',
    ...rows.map((w, i) => {
      const bal = fmtPls(results[i].value);
      const active = u?.active_wallet_id === w.id ? '   (active)' : '';
      return `${w.address} | ${bal}${active}`;
    }),
  ];
  if (results.some(r => !r.ok)) {
    lines.push('', '⚠️ Some balances didn’t load from the RPC. Use /rpc_check to diagnose.');
  }

  const kb = rows.map(w => [
    Markup.button.callback(`${w.id}. ${short(w.address)}`, `wallet_manage:${w.id}`),
    Markup.button.callback('Set Active', `wallet_set_active:${w.id}`)
  ]);
  kb.push([Markup.button.callback('➕ Generate', 'wallet_generate'), Markup.button.callback('📥 Add (Import)', 'wallet_add')]);
  kb.push([Markup.button.callback('⬅️ Back', 'main_back')]);

  return sendOrEdit(ctx, lines.join('\n'), Markup.inlineKeyboard(kb));
}

async function renderWalletManage(ctx: any, walletId: number) {
  const w = getWalletById(ctx.from.id, walletId);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');

  const { value: bal, ok } = await getBalanceFast(w.address);
  const lines = [
    '//// Wallet ////',
    `ID: ${walletId}`,
    `Address: ${w.address}`,
    `Balance: ${fmtPls(bal)} PLS${ok ? '' : '  (RPC issue)'}`
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Show Private Key', `wallet_pk:${walletId}`), Markup.button.callback('🔄 Refresh', `wallet_refresh:${walletId}`)],
    [Markup.button.callback('🧹 Clear Pending', `wallet_clear:${walletId}`), Markup.button.callback('🏧 Withdraw', `wallet_withdraw:${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove:${walletId}`), Markup.button.callback('⬅️ Back', 'wallets')],
  ]);

  return sendOrEdit(ctx, lines, kb);
}

/* actions */

bot.action('wallets', async (ctx) => { await ctx.answerCbQuery(); return renderWalletsList(ctx); });

bot.action(/^wallet_manage:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  return renderWalletManage(ctx, id);
});

bot.action(/^wallet_set_active:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  try {
    const setId = setActiveWallet(ctx.from.id, String(id));
    await ctx.answerCbQuery(`Active wallet set to ${setId}`);
  } catch (e: any) {
    await ctx.answerCbQuery('Select failed', { show_alert: true });
  }
  return renderWalletsList(ctx);
});

// PK flow
bot.action(/^wallet_pk:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  const masked = getPrivateKey(w).replace(/^(.{6}).+(.{4})$/, '$1…$2');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⚠️ Reveal (I understand the risk)', `wallet_pk_reveal:${id}`)],
    [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)],
  ]);
  return sendOrEdit(ctx, `Private key (masked): ${masked}\nRevealing exposes full control of funds.`, kb);
});

bot.action(/^wallet_pk_reveal:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  // reveal as a separate message (don’t edit menu with sensitive data)
  await ctx.reply(`PRIVATE KEY for ${short(w.address)}:\n\`${getPrivateKey(w)}\``, { parse_mode: 'Markdown' });
  return renderWalletManage(ctx, id);
});

// Clear pending
bot.action(/^wallet_clear:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const w = getWalletById(ctx.from.id, id);
  if (!w) return sendOrEdit(ctx, 'Wallet not found.');
  const u = getUserSettings(ctx.from.id);
  try {
    const res = await clearPendingTransactions(getPrivateKey(w), {
      maxPriorityFeePerGas: ethers.parseUnits(String((u?.max_priority_fee_gwei ?? 0.1) + 0.1), 'gwei'),
      maxFeePerGas: ethers.parseUnits(String((u?.max_fee_gwei ?? 0.2) + 0.2), 'gwei'),
      gasLimit: BigInt(u?.gas_limit ?? 250000),
    });
    await ctx.reply(`Cleared ${res.cleared} pending transactions.`);
  } catch (e: any) {
    await ctx.reply('Clear pending failed: ' + e.message);
  }
  return renderWalletManage(ctx, id);
});

// Withdraw prompt
bot.action(/^wallet_withdraw:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)]]);
  pending.set(ctx.from.id, { type: 'withdraw', walletId: id });
  return sendOrEdit(ctx, 'Reply with: `address amount_pls`\nExample: `0xabc123... 0.5`', withKb(kb, { parse_mode: 'Markdown' }));
});

// Remove
bot.action(/^wallet_remove:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Confirm Remove', `wallet_remove_confirm:${id}`)],
    [Markup.button.callback('⬅️ Back', `wallet_manage:${id}`)],
  ]);
  return sendOrEdit(ctx, `Remove wallet ID ${id}? This does NOT revoke keys on-chain.`, kb);
});
bot.action(/^wallet_remove_confirm:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  try {
    removeWallet(ctx.from.id, id);
    await ctx.reply(`Wallet ${id} removed.`);
  } catch (e: any) {
    await ctx.reply('Remove failed: ' + e.message);
  }
  return renderWalletsList(ctx);
});

// Refresh
bot.action(/^wallet_refresh:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  return renderWalletManage(ctx, id);
});

// Generate / Import prompts (edit menu into prompt with Back)
bot.action('wallet_generate', async (ctx) => {
  await ctx.answerCbQuery();
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]);
  pending.set(ctx.from.id, { type: 'gen_name' });
  return sendOrEdit(ctx, 'Send a name for your new wallet (e.g., `trader1`).', withKb(kb, { parse_mode: 'Markdown' }));
});
bot.action('wallet_add', async (ctx) => {
  await ctx.answerCbQuery();
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'wallets')]]);
  pending.set(ctx.from.id, { type: 'import_wallet' });
  return sendOrEdit(ctx, 'Reply with: `name privkey`\nExample: `hot1 0xYOUR_PRIVATE_KEY`', withKb(kb, { parse_mode: 'Markdown' }));
});

/* ----------------------- Text replies for prompts ----------------------- */

bot.on('text', async (ctx, next) => {
  const p = pending.get(ctx.from.id);
  if (!p) return next();

  if (p.type === 'set_amount') {
    const v = Number(String(ctx.message.text).trim());
    if (!Number.isFinite(v) || v <= 0) return ctx.reply('Please send a positive number (e.g., 0.02).');
    setBuyAmount(ctx.from.id, v);
    pending.delete(ctx.from.id);
    await ctx.reply(`Buy amount set to ${v} PLS.`);
    return sendOrEdit(ctx, '//// BUY MENU ////', buyMenu());
  }

  if (p.type === 'set_token') {
    const adr = String(ctx.message.text).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(adr)) return ctx.reply('That does not look like a valid 0x address.');
    setToken(ctx.from.id, adr);
    pending.delete(ctx.from.id);
    await ctx.reply(`Token set to ${adr}`);
    return sendOrEdit(ctx, '//// BUY MENU ////', buyMenu());
  }

  if (p.type === 'gen_name') {
    const name = String(ctx.message.text).trim();
    if (!name) return ctx.reply('Please send a non-empty name.');
    const w = createWallet(ctx.from.id, name);
    pending.delete(ctx.from.id);
    await ctx.reply(`Created wallet "${name}": ${w.address}`);
    return renderWalletsList(ctx);
  }

  if (p.type === 'import_wallet') {
    const parts = String(ctx.message.text).trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Expected: `name privkey`');
    const name = parts[0];
    const pk = parts[1];
    try {
      const w = importWallet(ctx.from.id, name, pk);
      pending.delete(ctx.from.id);
      await ctx.reply(`Imported wallet "${name}": ${w.address}`);
    } catch (e: any) {
      pending.delete(ctx.from.id);
      return ctx.reply('Import failed: ' + e.message);
    }
    return renderWalletsList(ctx);
  }

  if (p.type === 'withdraw') {
    const [to, amtStr] = String(ctx.message.text).trim().split(/\s+/);
    if (!/^0x[a-fA-F0-9]{40}$/.test(to) || !amtStr) return ctx.reply('Expected: `address amount_pls`');
    const amount = Number(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Amount must be a positive number.');
    const w = getWalletById(ctx.from.id, p.walletId);
    if (!w) {
      pending.delete(ctx.from.id);
      return ctx.reply('Wallet not found.');
    }
    const u = getUserSettings(ctx.from.id);
    try {
      const receipt = await withdrawPls(
        getPrivateKey(w),
        to,
        ethers.parseEther(String(amount)),
        {
          maxPriorityFeePerGas: ethers.parseUnits(String(u?.max_priority_fee_gwei ?? 0.1), 'gwei'),
          maxFeePerGas: ethers.parseUnits(String(u?.max_fee_gwei ?? 0.2), 'gwei'),
          gasLimit: 21000n,
        }
      );
      const txHash = receipt?.hash ?? '(pending)';
      await ctx.reply(`Withdraw tx: ${txHash}`);
    } catch (e: any) {
      await ctx.reply('Withdraw failed: ' + e.message);
    }
    pending.delete(ctx.from.id);
    return renderWalletManage(ctx, p.walletId);
  }
});

/* ----------------------- Buy menu (edit in place) ----------------------- */

async function renderBuyMenu(ctx: any) {
  const u = getUserSettings(ctx.from.id);
  const aw = getActiveWallet(ctx.from.id);
  const pri = u?.max_priority_fee_gwei ?? 0.1;
  const max = u?.max_fee_gwei ?? 0.2;
  const gl  = u?.gas_limit ?? 250000;
  const amt = u?.buy_amount_pls ?? 0.01;
  const lines = [
    '//// BUY MENU ////',
    `Wallet: ${aw ? short(aw.address) : '— (Select)'}`,
    `Token: ${u?.token_address ? short(u.token_address) : '—'}`,
    `Base: WPLS`,
    `Amount: ${amt} PLS`,
    `Gas: priority=${pri} gwei, max=${max} gwei, gasLimit=${gl}`,
  ];
  return sendOrEdit(ctx, lines.join('\n'), buyMenu());
}

bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); return renderBuyMenu(ctx); });
bot.action('main_back', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Main Menu', mainMenu()); });

bot.action('buy_set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_amount' });
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]);
  return sendOrEdit(ctx, 'Reply with the PLS amount (e.g., `0.02`).', withKb(kb, { parse_mode: 'Markdown' }));
});
bot.action('buy_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'set_token' });
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_buy')]]);
  return sendOrEdit(ctx, 'Reply with the token contract address (0x…).', kb);
});

// Gas nudges
function nudgeGas(ctx: any, dPri: number, dMax: number, dGL: number) {
  const u = getUserSettings(ctx.from.id);
  const pri = Math.max(0.01, (u?.max_priority_fee_gwei ?? 0.1) + dPri);
  const max = Math.max(0.01, (u?.max_fee_gwei ?? 0.2) + dMax);
  const gl = Math.max(21000, (u?.gas_limit ?? 250000) + dGL);
  setGas(ctx.from.id, Number(pri.toFixed(4)), Number(max.toFixed(4)), gl);
}
bot.action('gas_pri_up',  async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, +0.05, 0, 0); return renderBuyMenu(ctx); });
bot.action('gas_pri_down',async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, -0.05, 0, 0); return renderBuyMenu(ctx); });
bot.action('gas_max_up',  async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, 0, +0.10, 0); return renderBuyMenu(ctx); });
bot.action('gas_max_down',async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, 0, -0.10, 0); return renderBuyMenu(ctx); });
bot.action('gas_limit_up',async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, 0, 0, +25000); return renderBuyMenu(ctx); });
bot.action('gas_limit_down',async (ctx) => { await ctx.answerCbQuery(); nudgeGas(ctx, 0, 0, -25000); return renderBuyMenu(ctx); });

// Approve (keeps menu, prints tx separately)
bot.action('approve_now', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!w || !u?.token_address) return sendOrEdit(ctx, 'Need active wallet and token set.', buyMenu());
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
    const txHash = (receipt as any)?.hash ?? '(pending)';
    await ctx.reply('Approve tx: ' + txHash);
  } catch (e: any) {
    await ctx.reply('Approve failed: ' + e.message);
  }
  return renderBuyMenu(ctx);
});

// Choose wallet (in-place)
bot.action('choose_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  const rows = listWallets(ctx.from.id);
  if (!rows.length) return sendOrEdit(ctx, 'No wallets yet. Use /wallet_new <name> or /wallet_import <name> <privkey>');
  const buttons = rows.map(w => [Markup.button.callback(`${w.id}. ${w.name} ${short(w.address)}`, `select_wallet:${w.id}`)]);
  buttons.push([Markup.button.callback('⬅️ Back', 'menu_buy')]);
  return sendOrEdit(ctx, 'Select a wallet to set active:', Markup.inlineKeyboard(buttons));
});
bot.action(/^select_wallet:(\d+)$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  try {
    const setId = setActiveWallet(ctx.from.id, String(id));
    await ctx.answerCbQuery(`Active set to ${setId}`);
  } catch (e: any) {
    await ctx.answerCbQuery('Select failed', { show_alert: true });
  }
  return renderBuyMenu(ctx);
});

// Execute buys (menu persists; tx printed separately)
bot.action('buy_exec', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  if (!w) return sendOrEdit(ctx, 'Select a wallet first.', buyMenu());
  if (!u?.token_address) return sendOrEdit(ctx, 'Set token first with /set_token <address>', buyMenu());
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
    const txHash = (receipt as any)?.hash ?? '(pending)';
    await ctx.reply('Buy tx: ' + txHash);
  } catch (e: any) {
    await ctx.reply('Buy failed: ' + e.message);
  }
  return renderBuyMenu(ctx);
});

bot.action('buy_exec_all', async (ctx) => {
  await ctx.answerCbQuery();
  const rows = listWallets(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  const amt = u?.buy_amount_pls ?? 0.01;
  if (!rows.length) return sendOrEdit(ctx, 'No wallets yet. Use /wallet_new or /wallet_import.', buyMenu());
  if (!u?.token_address) return sendOrEdit(ctx, 'Set token first with /set_token <address>', buyMenu());
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
      const txHash = (receipt as any)?.hash ?? '(pending)';
      results.push(`✅ ${short(row.address)} -> ${txHash}`);
    } catch (e: any) {
      results.push(`❌ ${short(row.address)} -> ${e.message}`);
    }
  }
  await ctx.reply(results.join('\n'));
  return renderBuyMenu(ctx);
});

/* ----------------------- Diagnostics ----------------------- */

bot.command('rpc_check', async (ctx) => {
  const aw = getActiveWallet(ctx.from.id);
  const info = await pingRpc(aw?.address);
  const lines = [
    '*RPC Check*',
    `chainId: ${info.chainId ?? '—'}`,
    `block: ${info.blockNumber ?? '—'}`,
    `gasPrice(wei): ${info.gasPrice ?? '—'}`,
    `maxFeePerGas(wei): ${info.maxFeePerGas ?? '—'}`,
    `maxPriorityFeePerGas(wei): ${info.maxPriorityFeePerGas ?? '—'}`,
    `active wallet: ${aw ? aw.address : '—'}`,
    `balance(wei): ${info.balanceWei ?? '—'}`,
    `${info.error ? 'error: ' + info.error : ''}`,
  ].join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

/* ----------------------- Classic commands (unchanged UX) ----------------------- */

bot.command('wallets', async (ctx) => renderWalletsList(ctx));
bot.command('wallet_new', async (ctx) => {
  const [_, name] = ctx.message.text.split(/\s+/, 2);
  if (!name) return ctx.reply('Usage: /wallet_new <name>');
  const w = createWallet(ctx.from.id, name);
  return ctx.reply(`Created wallet "${name}": ${w.address}`);
});
bot.command('wallet_import', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 3) return ctx.reply('Usage: /wallet_import <name> <privkey>');
  const name = parts[1], pk = parts[2];
  try { const w = importWallet(ctx.from.id, name, pk); return ctx.reply(`Imported wallet "${name}": ${w.address}`); }
  catch (e: any) { return ctx.reply('Import failed: ' + e.message); }
});
bot.command('wallet_select', async (ctx) => {
  const [_, idOrName] = ctx.message.text.split(/\s+/, 2);
  if (!idOrName) return ctx.reply('Usage: /wallet_select <id|name>');
  try { const id = setActiveWallet(ctx.from.id, idOrName); return ctx.reply('Active wallet set to ID ' + id); }
  catch (e: any) { return ctx.reply('Select failed: ' + e.message); }
});
bot.command('set_token', (ctx) => {
  const [_, address] = ctx.message.text.split(/\s+/, 2);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return ctx.reply('Usage: /set_token <0xAddress>');
  setToken(ctx.from.id, address); return ctx.reply('Token set to ' + address);
});
bot.command('set_gas', (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 4) return ctx.reply('Usage: /set_gas <priority_gwei> <max_gwei> <gas_limit>');
  const [priority, max, limit] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![priority, max, limit].every((n) => Number.isFinite(n) && n > 0)) return ctx.reply('Invalid numbers.');
  setGas(ctx.from.id, priority, max, limit);
  return ctx.reply(`Gas set. priority=${priority} gwei, max=${max} gwei, gasLimit=${limit}`);
});
bot.command('price', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  const amountInWei = ethers.parseEther('1');
  try {
    const amounts = await getPrice(amountInWei, [process.env.WPLS_ADDRESS!, u.token_address]);
    return ctx.reply(`1 WPLS -> ${ethers.formatUnits(amounts[1], 18)} tokens (raw: ${amounts[1]})`);
  } catch (e: any) { return ctx.reply('Price failed: ' + e.message); }
});
bot.command('balances', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.reply('Select a wallet first.');
  const addr = w.address;
  const u = getUserSettings(ctx.from.id);
  const { value: plsBal } = await getBalanceFast(addr);
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
  return ctx.reply(`Wallet ${addr}\nPLS: ${fmtPls(plsBal)}\nToken: ${token}`);
});
bot.command('sell', async (ctx) => {
  const [_, percentStr] = ctx.message.text.split(/\s+/, 2);
  const percent = Number(percentStr);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return ctx.reply('Usage: /sell <percent 1-100>');
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!w || !u?.token_address) return ctx.reply('Need active wallet and token set.');
  try {
    const erc = erc20(u.token_address);
    const [bal] = await Promise.all([erc.balanceOf(w.address)]);
    const amount = (bal * BigInt(percent)) / 100n;
    const receipt = await sellExactTokensForETH(
      getPrivateKey(w), u.token_address, amount, 0n, {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      }
    );
    const txHash = (receipt as any)?.hash ?? '(pending)';
    return ctx.reply('Sell tx: ' + txHash);
  } catch (e: any) { return ctx.reply('Sell failed: ' + e.message); }
});

/* shortcuts from main (keep simple) */
bot.action('sell', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /sell <percent>', mainMenu()); });
bot.action('settings', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /set_token <addr> and /set_gas <priority> <max> <limit>', mainMenu()); });
bot.action('price', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /price after setting token.', mainMenu()); });
bot.action('balances', async (ctx) => { await ctx.answerCbQuery(); return sendOrEdit(ctx, 'Use /balances after selecting a wallet.', mainMenu()); });

export {};
