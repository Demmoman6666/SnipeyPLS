import { Telegraf } from 'telegraf';
import { getConfig } from './config.js';
import { mainMenu } from './keyboards.js';
import { listWallets, createWallet, importWallet, setActiveWallet, getActiveWallet, setToken, setPair, setGas, getUserSettings } from './wallets.js';
import { ethers } from 'ethers';
import { provider, getPrice, buyExactETHForTokens, sellExactTokensForETH, erc20, approveToken } from './dex.js';

const cfg = getConfig();
export const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

bot.start(async (ctx) => {
  await ctx.reply('Welcome to PulseChain Trading Bot. Use commands or the menu below.', mainMenu());
});

bot.command('wallets', async (ctx) => {
  const rows = listWallets(ctx.from.id);
  if (rows.length === 0) return ctx.reply('No wallets yet. Use /wallet_new <name> or /wallet_import <name> <privkey>');
  const u = getUserSettings(ctx.from.id);
  const lines = rows.map(r => `${r.id}. ${r.name} — \`${r.address}\`${u?.active_wallet_id===r.id ? ' (active)' : ''}`).join('\n');
  return ctx.replyWithMarkdownV2(lines);
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
  } catch (e:any) {
    return ctx.reply('Import failed: ' + e.message);
  }
});

bot.command('wallet_select', async (ctx) => {
  const [_, idOrName] = ctx.message.text.split(/\s+/, 2);
  if (!idOrName) return ctx.reply('Usage: /wallet_select <id|name>');
  try {
    const id = setActiveWallet(ctx.from.id, idOrName);
    return ctx.reply('Active wallet set to ID ' + id);
  } catch (e:any) {
    return ctx.reply('Select failed: ' + e.message);
  }
});

bot.command('set_token', (ctx) => {
  const [_, address] = ctx.message.text.split(/\s+/, 2);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return ctx.reply('Usage: /set_token <0xAddress>');
  setToken(ctx.from.id, address);
  return ctx.reply('Token set to ' + address);
});

bot.command('set_pair', (ctx) => {
  const [_, pair] = ctx.message.text.split(/\s+/, 2);
  if (!pair || !/^WPLS|STABLE$/i.test(pair)) return ctx.reply('Usage: /set_pair <WPLS|STABLE>');
  setPair(ctx.from.id, pair.toUpperCase() as any);
  return ctx.reply('Base pair set to ' + pair.toUpperCase());
});

bot.command('set_gas', (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 4) return ctx.reply('Usage: /set_gas <priority_gwei> <max_gwei> <gas_limit>');
  const [priority, max, limit] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![priority,max,limit].every(n => Number.isFinite(n) && n>0)) return ctx.reply('Invalid numbers.');
  setGas(ctx.from.id, priority, max, limit);
  return ctx.reply(`Gas set. priority=${priority} gwei, max=${max} gwei, gasLimit=${limit}`);
});

bot.command('price', async (ctx) => {
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  const base = (u.base_pair ?? 'WPLS') as 'WPLS'|'STABLE';
  const baseAddr = base === 'WPLS' ? process.env.WPLS_ADDRESS! : process.env.STABLE_ADDRESS!;
  const amountInWei = ethers.parseEther('1');
  try {
    const amounts = await getPrice(amountInWei, [baseAddr, u.token_address]);
    return ctx.reply(`1 ${base} -> ${ethers.formatUnits(amounts[1], 18)} tokens (raw: ${amounts[1]})`);
  } catch (e:any) {
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
    const [bal, dec, sym] = await Promise.all([erc.balanceOf(addr), erc.decimals().catch(()=>18), erc.symbol().catch(()=> 'TOKEN')]);
    token = `${ethers.formatUnits(bal, dec)} ${sym}`;
  }
  return ctx.reply(`Wallet ${addr}\nPLS: ${ethers.formatEther(plsBal)}\nToken: ${token}`);
});

bot.command('buy', async (ctx) => {
  const [_, amt] = ctx.message.text.split(/\s+/, 2);
  const amount = Number(amt);
  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Usage: /buy <amount_pls>');
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.reply('Select a wallet first.');
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  try {
    const receipt = await buyExactETHForTokens(
      require('./wallets.js').getPrivateKey(w),
      u.token_address,
      (u.base_pair ?? 'WPLS') as any,
      ethers.parseEther(amount.toString()),
      0n,
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      }
    );
    return ctx.reply('Buy tx: ' + receipt.transactionHash);
  } catch (e:any) {
    return ctx.reply('Buy failed: ' + e.message);
  }
});

bot.command('buy_all', async (ctx) => {
  const [_, amt] = ctx.message.text.split(/\s+/, 2);
  const amount = Number(amt);
  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Usage: /buy_all <amount_pls>');
  const rows = listWallets(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!u?.token_address) return ctx.reply('Set token first with /set_token <address>');
  const results:string[] = [];
  for (const row of rows) {
    try {
      const receipt = await buyExactETHForTokens(
        require('./wallets.js').getPrivateKey(row),
        u.token_address,
        (u.base_pair ?? 'WPLS') as any,
        ethers.parseEther(amount.toString()),
        0n,
        {
          maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
          maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
          gasLimit: BigInt(u.gas_limit ?? 250000),
        }
      );
      results.push(`✅ ${row.address} -> ${receipt.transactionHash}`);
    } catch (e:any) {
      results.push(`❌ ${row.address} -> ${e.message}`);
    }
  }
  return ctx.reply(results.join('\n'));
});

bot.command('approve', async (ctx) => {
  const w = getActiveWallet(ctx.from.id);
  const u = getUserSettings(ctx.from.id);
  if (!w || !u?.token_address) return ctx.reply('Need active wallet and token set.');
  try {
    const receipt = await approveToken(
      require('./wallets.js').getPrivateKey(w),
      u.token_address,
      process.env.ROUTER_ADDRESS!,
      (2n**256n - 1n),
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      }
    );
    return ctx.reply('Approve tx: ' + receipt.transactionHash);
  } catch (e:any) {
    return ctx.reply('Approve failed: ' + e.message);
  }
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
    const [bal, dec] = await Promise.all([erc.balanceOf(w.address), erc.decimals().catch(()=>18)]);
    const amountIn = (bal * BigInt(Math.floor(percent*100))) // basis points
      // divide by 100*100 to avoid float; but simpler:
    const amount = (bal * BigInt(percent)) // percent
      // divide by 100
      / 100n;
    const receipt = await sellExactTokensForETH(
      require('./wallets.js').getPrivateKey(w),
      u.token_address,
      (u.base_pair ?? 'WPLS') as any,
      amount,
      0n,
      {
        maxPriorityFeePerGas: ethers.parseUnits(String(u.max_priority_fee_gwei ?? 0.1), 'gwei'),
        maxFeePerGas: ethers.parseUnits(String(u.max_fee_gwei ?? 0.2), 'gwei'),
        gasLimit: BigInt(u.gas_limit ?? 250000),
      }
    );
    return ctx.reply('Sell tx: ' + receipt.transactionHash);
  } catch (e:any) {
    return ctx.reply('Sell failed: ' + e.message);
  }
});

// Simple callbacks to reopen menu
bot.action('wallets', (ctx) => ctx.reply('Use /wallets, /wallet_new, /wallet_import, /wallet_select'));
bot.action('buy', (ctx) => ctx.reply('Use /buy <amount_pls> or /buy_all <amount_pls>'));
bot.action('sell', (ctx) => ctx.reply('Use /sell <percent>'));
bot.action('settings', (ctx) => ctx.reply('Use /set_token <addr>, /set_pair <WPLS|STABLE>, /set_gas <priority> <max> <limit>'));
bot.action('price', (ctx) => ctx.reply('Use /price after setting token + base pair.'));
bot.action('balances', (ctx) => ctx.reply('Use /balances after selecting a wallet.'));
