import { ethers } from 'ethers';
import { getConfig } from './config.js';

const cfg = getConfig();
export const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);

/* ---------------- ABIs ---------------- */

// V2 (UniswapV2-style) minimal
const V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)',
];

// V3 Quoter & Router (UniswapV3-style)
const V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)',
];
const V3_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

// ERC20
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];
const ERC20_BYTES32_ABI = [
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
];

/* ---------------- Types & helpers ---------------- */

export type GasOpts = {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
};

const now = () => Math.floor(Date.now() / 1000);
const deadline = () => now() + 600;

function ov(g: GasOpts, extra?: Partial<GasOpts>) {
  const merged = { ...g, ...(extra || {}) };
  return {
    maxFeePerGas: merged.maxFeePerGas,
    maxPriorityFeePerGas: merged.maxPriorityFeePerGas,
    gasLimit: merged.gasLimit,
  };
}

export function erc20(address: string, signer?: ethers.Signer) {
  return new ethers.Contract(address, ERC20_ABI, signer ?? provider);
}

export async function tokenMeta(address: string): Promise<{ decimals: number; symbol: string; name: string }> {
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  const decimals = await c.decimals().catch(() => 18);

  let symbol = await c.symbol().catch(async () => {
    const b = new ethers.Contract(address, ERC20_BYTES32_ABI, provider);
    const raw = await b.symbol().catch(() => null);
    try { return raw ? ethers.decodeBytes32String(raw as string) : 'TOKEN'; } catch { return 'TOKEN'; }
  });

  let name = await c.name().catch(async () => {
    const b = new ethers.Contract(address, ERC20_BYTES32_ABI, provider);
    const raw = await b.name().catch(() => null);
    try { return raw ? ethers.decodeBytes32String(raw as string) : 'Token'; } catch { return 'Token'; }
  });

  return { decimals, symbol, name };
}

/* ---------------- Route discovery ---------------- */

type RouteV2 = { key: string; kind: 'v2'; router: string };
type RouteV3 = { key: string; kind: 'v3'; router: string; quoter: string; fee: number };
export type Route = RouteV2 | RouteV3;

function v2(key: string, router?: string): RouteV2 | null {
  return router ? { key, kind: 'v2', router } : null;
}
function v3(key: string, router?: string, quoter?: string, fee?: number): RouteV3 | null {
  if (!router || !quoter || fee == null) return null;
  return { key, kind: 'v3', router, quoter, fee };
}

/** Build the list of candidate routes (skip undefined). */
function candidateRoutes(): Route[] {
  const routes: (Route | null)[] = [];

  // V2 DEXes
  routes.push(v2('PULSEX_V1', process.env.PULSEX_V1_ROUTER));         // 0x98bf...Acc02
  routes.push(v2('PULSEX_V2', process.env.ROUTER_ADDRESS));            // 0x165c...52d9  (your existing V2)
  routes.push(v2('9MM_V2', process.env.NINEMM_V2_ROUTER));             // optional
  routes.push(v2('9INCH_V2', process.env.NINEINCH_V2_ROUTER));         // optional

  // V3 (only if both router+quoter are provided)
  const v3Fees = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
  if (process.env.NINEMM_V3_ROUTER && process.env.NINEMM_V3_QUOTER) {
    for (const fee of v3Fees) routes.push(v3('9MM_V3', process.env.NINEMM_V3_ROUTER, process.env.NINEMM_V3_QUOTER, fee));
  }
  if (process.env.NINEINCH_V3_ROUTER && process.env.NINEINCH_V3_QUOTER) {
    for (const fee of v3Fees) routes.push(v3('9INCH_V3', process.env.NINEINCH_V3_ROUTER, process.env.NINEINCH_V3_QUOTER, fee));
  }

  return routes.filter(Boolean) as Route[];
}

/* ---------------- Quoting ---------------- */

async function quoteV2(amountIn: bigint, tokenIn: string, tokenOut: string, routerAddr: string): Promise<bigint | null> {
  try {
    const router = new ethers.Contract(routerAddr, V2_ROUTER_ABI, provider);
    const path = [tokenIn, tokenOut];
    const amounts = (await router.getAmountsOut(amountIn, path)) as unknown as bigint[];
    return amounts?.[amounts.length - 1] ?? null;
  } catch {
    return null;
  }
}

async function quoteV3(amountIn: bigint, tokenIn: string, tokenOut: string, fee: number, quoterAddr: string): Promise<bigint | null> {
  try {
    const quoter = new ethers.Contract(quoterAddr, V3_QUOTER_ABI, provider);
    const out = (await quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0)) as unknown as bigint;
    return out ?? null;
  } catch {
    return null;
  }
}

export type BestQuote = {
  route: Route;
  amountOut: bigint;
};

/** Best quote for PLS→TOKEN (buy). */
export async function bestQuoteBuy(amountInWei: bigint, tokenOut: string): Promise<BestQuote | null> {
  const W = process.env.WPLS_ADDRESS!;
  const routes = candidateRoutes();
  if (!routes.length) return null;

  const results = await Promise.all(routes.map(async (r) => {
    if (r.kind === 'v2') {
      const out = await quoteV2(amountInWei, W, tokenOut, r.router);
      return out ? ({ route: r, amountOut: out } as BestQuote) : null;
    } else {
      const out = await quoteV3(amountInWei, W, tokenOut, r.fee, r.quoter);
      return out ? ({ route: r, amountOut: out } as BestQuote) : null;
    }
  }));

  const valid = results.filter(Boolean) as BestQuote[];
  if (!valid.length) return null;
  valid.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  return valid[0]!;
}

/** Best quote for TOKEN→PLS (sell). */
export async function bestQuoteSell(amountInWei: bigint, tokenIn: string): Promise<BestQuote | null> {
  const W = process.env.WPLS_ADDRESS!;
  const routes = candidateRoutes();
  if (!routes.length) return null;

  const results = await Promise.all(routes.map(async (r) => {
    if (r.kind === 'v2') {
      const out = await quoteV2(amountInWei, tokenIn, W, r.router);
      return out ? ({ route: r, amountOut: out } as BestQuote) : null;
    } else {
      const out = await quoteV3(amountInWei, tokenIn, W, r.fee, r.quoter);
      return out ? ({ route: r, amountOut: out } as BestQuote) : null;
    }
  }));

  const valid = results.filter(Boolean) as BestQuote[];
  if (!valid.length) return null;
  valid.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  return valid[0]!;
}

/** Debug helper (you can wire this to a /route_debug command if you like). */
export async function debugQuotesBuy(amountInWei: bigint, tokenOut: string) {
  const W = process.env.WPLS_ADDRESS!;
  const routes = candidateRoutes();
  const out: Array<{ route: string; amountOut?: string }> = [];
  for (const r of routes) {
    let amt: bigint | null = null;
    try {
      amt = r.kind === 'v2'
        ? await quoteV2(amountInWei, W, tokenOut, r.router)
        : await quoteV3(amountInWei, W, tokenOut, r.fee, (r as RouteV3).quoter);
    } catch { /* ignore */ }
    out.push({ route: r.key, amountOut: amt ? amt.toString() : undefined });
  }
  return out;
}

/* ---------------- Swaps (auto-route) ---------------- */

async function signerFrom(pk: string) {
  return new ethers.Wallet(pk, provider);
}

export async function buyAutoRoute(
  privKey: string,
  tokenOut: string,
  amountInWei: bigint,
  minOutWei: bigint,
  gas: GasOpts
) {
  const best = await bestQuoteBuy(amountInWei, tokenOut);
  if (!best) throw new Error('No route available for buy');
  const s = await signerFrom(privKey);
  const me = await s.getAddress();

  if (best.route.kind === 'v2') {
    const router = new ethers.Contract(best.route.router, V2_ROUTER_ABI, s);
    const path = [process.env.WPLS_ADDRESS!, tokenOut];
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      minOutWei, path, me, deadline(), { ...ov(gas), value: amountInWei }
    );
    return await tx.wait();
  } else {
    const router = new ethers.Contract(best.route.router, V3_ROUTER_ABI, s);
    const params = {
      tokenIn: process.env.WPLS_ADDRESS!,
      tokenOut,
      fee: best.route.fee,
      recipient: me,
      deadline: BigInt(deadline()),
      amountIn: amountInWei,
      amountOutMinimum: minOutWei,
      sqrtPriceLimitX96: 0n,
    };
    const tx = await router.exactInputSingle(params, { ...ov(gas), value: amountInWei });
    return await tx.wait();
  }
}

export async function sellAutoRoute(
  privKey: string,
  tokenIn: string,
  amountInWei: bigint,
  minOutWei: bigint,
  gas: GasOpts
) {
  const best = await bestQuoteSell(amountInWei, tokenIn);
  if (!best) throw new Error('No route available for sell');
  const s = await signerFrom(privKey);
  const me = await s.getAddress();

  if (best.route.kind === 'v2') {
    const router = new ethers.Contract(best.route.router, V2_ROUTER_ABI, s);
    const path = [tokenIn, process.env.WPLS_ADDRESS!];
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amountInWei, minOutWei, path, me, deadline(), ov(gas)
    );
    return await tx.wait();
  } else {
    const router = new ethers.Contract(best.route.router, V3_ROUTER_ABI, s);
    const params = {
      tokenIn,
      tokenOut: process.env.WPLS_ADDRESS!,
      fee: best.route.fee,
      recipient: me,
      deadline: BigInt(deadline()),
      amountIn: amountInWei,
      amountOutMinimum: minOutWei,
      sqrtPriceLimitX96: 0n,
    };
    const tx = await router.exactInputSingle(params, ov(gas));
    return await tx.wait();
  }
}

/* ---------------- Allowance / Approvals ---------------- */

export async function approveAllRouters(
  privKey: string,
  token: string,
  gas: GasOpts,
  amount: bigint = ethers.MaxUint256
) {
  const s = await signerFrom(privKey);
  const t = erc20(token, s);
  const routes = candidateRoutes();
  const me = await s.getAddress();
  const results: string[] = [];

  for (const r of routes) {
    const spender = r.router;
    const current = await t.allowance(me, spender);
    if (current >= amount / 2n) { results.push(`skipped ${r.key}`); continue; }
    const tx = await t.approve(spender, amount, ov(gas));
    const rc = await tx.wait();
    results.push(`${r.key}: ${rc.hash}`);
  }
  return results;
}

/* ---------------- Pending / Withdraw / Ping ---------------- */

export async function clearPendingTransactions(privKey: string, gas: GasOpts) {
  const s = await signerFrom(privKey);
  const addr = await s.getAddress();
  const pending = await provider.getTransactionCount(addr, 'pending');
  const latest = await provider.getTransactionCount(addr, 'latest');
  let cleared = 0;
  for (let n = latest; n < pending; n++) {
    const tx = await s.sendTransaction({ to: addr, value: 0n, nonce: n, ...ov(gas) });
    await tx.wait().catch(() => null);
    cleared++;
  }
  return { cleared };
}

export async function withdrawPls(privKey: string, to: string, amountWei: bigint, gas: GasOpts) {
  const s = await signerFrom(privKey);
  const tx = await s.sendTransaction({ to, value: amountWei, ...ov(gas) });
  return await tx.wait();
}

export async function pingRpc(address?: string) {
  try {
    const net = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? 0n;
    const maxFeePerGas = fee.maxFeePerGas ?? 0n;
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;
    let balanceWei: bigint | undefined;
    if (address) balanceWei = await provider.getBalance(address);
    return {
      chainId: Number(net.chainId),
      blockNumber,
      gasPrice: gasPrice.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      balanceWei: balanceWei?.toString(),
    };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}
