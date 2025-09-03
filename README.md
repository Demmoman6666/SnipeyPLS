# PulseChain Telegram Trading Bot (Starter)

A minimal, self-hostable Telegram bot to trade on PulseChain (EVM) via a Uniswap V2–compatible router (e.g., PulseX).  
**Control entirely from Telegram** and run 24/7 on a host like Railway, Fly.io, Render, Docker on a VPS, etc.
Code is designed to live on GitHub; deploy from there.

> ⚠️ **Risk & security**: Hot wallets, private keys, and on-chain trading are risky. Use small funds.  
> Keys are encrypted at rest with `MASTER_KEY`, but anyone with OS access and your master key can spend funds.

## Features
- `/start` menu with inline buttons
- Create/import/list/select wallets (multiple per Telegram user)
- Set the target token and base pair (`WPLS` or `STABLE`), gas limit and EIP-1559 tips
- Buy from active wallet or from **all wallets** with one command
- Sell by percent or amount
- Check price and balances
- UniswapV2-compatible trading (router address configurable)
- SQLite storage (portable).

## Quick start

1. **Fork** this repo to your GitHub.
2. Create `.env` from `.env.example` and fill in values (router, WPLS, stable addresses, etc.).
3. Build & run locally or deploy to a host:
   - Local (optional): `npm i && npm run dev`
   - Docker: `docker build -t pulsebot . && docker run --env-file .env -v $(pwd)/data:/app/data pulsebot`
   - Railway/Render/Fly: point to this repo, set env vars, run `npm run build` then `node dist/index.js`.

## Commands (arguments syntax)
- `/start` — open menu
- `/wallet_new <name>` — create a new wallet
- `/wallet_import <name> <privkey>` — import an existing wallet (0x…)
- `/wallets` — list wallets
- `/wallet_select <id|name>` — select active wallet
- `/set_token <address>` — set the ERC20 you want to trade
- `/set_pair <WPLS|STABLE>` — choose trade base
- `/set_gas <priority_gwei> <max_gwei> <gas_limit>` — set EIP-1559 tips and gas limit
- `/buy <amount_pls>` — buy with active wallet (amount in PLS)
- `/buy_all <amount_pls>` — buy from **all** wallets
- `/sell <percent>` — sell % of token balance from active wallet (e.g., `/sell 25`)
- `/approve` — approve router to spend your token (active wallet)
- `/price` — show current price path via `getAmountsOut`
- `/balances` — show balances (PLS, token) for active wallet

You can extend with buttons and scenes; this starter includes a compact inline keyboard menu.

## Notes
- Works with any UniswapV2 router; set `ROUTER_ADDRESS` accordingly.
- For stable pairing, set `STABLE_ADDRESS` to your preferred USD stable on PulseChain.
- For 24/7 uptime, **do not** rely on GitHub alone. Use a host to run the Node process continuously.

## Legal
For educational purposes only. No warranty. You are responsible for compliance with local laws and platform rules.
