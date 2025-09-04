import { ethers } from 'ethers';
import { getConfig } from './config.js';

const cfg = getConfig();

// -------- Provider (single; keep-alive is handled by undici in boot.ts) --------
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
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)'
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
const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ---------------- Token metadata (robust + cached) ---------------- */

const metaCache = new Map<string, { decimals: number; symbol: string; name: string }>();

export function erc20(address: string, signer?: ethers.Signer) {
  return new ethers.Contract(address, ERC20_ABI, signer ?? provider);
}

export async function tokenMeta(address: string): Promise<{ decimals: number; symbol: string; name: string }> {
  const key = address.toLowerCase();
  const cached = metaCache.get(key);
  if (cached) return cached;

  const c = new ethers.Contract(address, ERC20_ABI, provider);

  // decimals
  const decimals = await c.decimals().catch(() => 18);

  // symbol (string → bytes32 → fallback)
  let symbol: string | undefined;
  try {
    const s: string = await c.symbol();
    if (s && typeof s === 'string' && s.length <= 24) symbol = s;
  } catch {
    try {
      const b = new ethers.Contract(address, ERC20_BYTES32_ABI, provider);
      const raw: string = await b.symbol();
      symbol = raw ? ethers.decodeBytes32String(raw) : undefined;
    } catch { /* ignore */ }
  }

  // name (string → bytes32 → fallback)
  let name: string | undefined;
  try {
    const n: string = await c.name();
    if (n && typeof n === 'string' && n.length <= 64) name = n;
  } catch {
    try {
      const b = new ethers.Contract(address, ERC20_BYTES32_ABI, provider);
      const raw: string = await b.name();
      name = raw ? ethers.decodeBytes32String(raw) : undefined;
    } catch { /* ignore */ }
  }

  // sane fallbacks
  if (!symbol || /^(token)$/i.test(symbol)) symbol = name || 'TOKEN';
  if (!name) name = symbol || 'Token';

  const meta = { decimals, symbol, name };
  metaCache.set(key, meta);
  return meta;
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

  // V2
  routes.push(v2('PULSEX_V1', process.env.PULSEX_V1_ROUTER));
  routes.push(v2('PULSEX_V2', process.env.ROUTER_ADDRESS)); // your legacy PLSX V2 env
  routes.push(v2('9MM_V2', process.env.NINEMM_V2_ROUTER));
  routes.push(v2('9INCH_V2', process.env.NINEINCH_V2_ROUTER));

  // V3 (only if router+quoter present; we’ll stick to single-hop)
  const v3Fees = [500, 3000, 10000];
  if (process.env.NINEMM_V3_ROUTER && process.env.NINEMM_V3_QUOTER) {
    for (const fee of v3Fees) routes.push(v3('9MM_V3', process.env.NINEMM_V3_ROUTER, process.env.NINEMM_V3_QUOTER, fee));
  }
  if (process.env.NINEINCH_V3_ROUTER && process.env.NINEINCH_V3_QUOTER) {
    for (const fee of v3Fees) routes.push(v3('9INCH_V3', process.env.NINEINCH_V3_ROUTER, process.env.NINEINCH_V3_QUOTER, fee));
  }

  return routes.filter(Boolean) as Route[];
}

/* ---------------- Quoting (multi-path for V2) ---------------- */

const WPLS = process.env.WPLS_ADDRESS!;
const STABLES = (process.env.STABLE_ADDRESS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PLSX = process.env.PLSX_ADDRESS?.trim();

/** Build common V2 paths between two tokens. */
function v2Paths(tokenIn: string, tokenOut: string): string[][] {
  const paths: string[][] = [];
  paths.push([tokenIn, tokenOut]); // direct
  for (const s of STABLES) {
    if (!eq(tokenIn, s) && !eq(tokenOut, s)) paths.push([tokenIn, s, tokenOut]);
  }
  if (PLSX && !eq(tokenIn, PLSX) && !eq(tokenOut, PLSX)) {
    paths.push([tokenIn, PLSX, tokenOut]);
  }
  // de-dup
  const seen = new Set<string>();
  return paths.filter(p => {
    const k = p.join('>');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function quoteV2Best(
  amountIn: bigint,
  tokenIn: string,
  tokenOut: string,
  routerAddr: string
): Promise<{ amountOut: bigint; path: string[] } | null> {
  try {
    const router = new ethers.Contract(routerAddr, V2_ROUTER_ABI, provider);
    let best: { amountOut: bigint; path: string[] } | null = null;
    for (const path of v2Paths(tokenIn, tokenOut)) {
      try {
        const amts = (await router.getAmountsOut(amountIn, path)) as unknown as bigint[];
        const out = amts?.[amts.length - 1];
        if (out && (best == null || out > best.amountOut)) best = { amountOut: out, path };
      } catch {
        /* ignore this path */
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function quoteV3(
  amountIn: bigint,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  quoterAddr: string
): Promise<bigint | null> {
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
  path?: string[]; // for V2
};

/** Best quote for PLS→TOKEN (buy). */
export async function bestQuoteBuy(amountInWei: bigint, tokenOut: string): Promise<BestQuote | null> {
  const routes = candidateRoutes();
  if (!routes.length) return null;

  const results = await Promise.all(routes.map(async (r) => {
    if (r.kind === 'v2') {
      const q = await quoteV2Best(amountInWei, WPLS, tokenOut, r.router);
      return q ? ({ route: r, amountOut: q.amountOut, path: q.path } as BestQuote) : null;
    } else {
      const out = await quoteV3(amountInWei, WPLS, tokenOut, r.fee, r.quoter);
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
  const routes = candidateRoutes();
  if (!routes.length) return null;

  const results = await Promise.all(routes.map(async (r) => {
    if (r.kind === 'v2') {
      const q = await quoteV2Best(amountInWei, tokenIn, WPLS, r.router);
      return q ? ({ route: r, amountOut: q.amountOut, path: q.path } as BestQuote) : null;
    } else {
      const out = await quoteV3(amountInWei, tokenIn, WPLS, r.fee, r.quoter);
      return out ? ({ route: r, amountOut: out } as BestQuote) : null;
    }
  }));

  const valid = results.filter(Boolean) as BestQuote[];
  if (!valid.length) return null;
  valid.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  return valid[0]!;
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
    const path = best.path && best.path.length >= 2 ? best.path : [WPLS, tokenOut];
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      minOutWei, path, me, deadline(), { ...ov(gas), value: amountInWei }
    );
    return await tx.wait();
  } else {
    const router = new ethers.Contract(best.route.router, V3_ROUTER_ABI, s);
    const params = {
      tokenIn: WPLS,
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
    const path = best.path && best.path.length >= 2 ? best.path : [tokenIn, WPLS];
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amountInWei, minOutWei, path, me, deadline(), ov(gas)
    );
    return await tx.wait();
  } else {
    const router = new ethers.Contract(best.route.router, V3_ROUTER_ABI, s);
    const params = {
      tokenIn,
      tokenOut: WPLS,
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
