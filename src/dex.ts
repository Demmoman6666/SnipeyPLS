// src/dex.ts
import { ethers } from 'ethers';
import { getConfig } from './config.js';

const cfg = getConfig();

// Be explicit about the network (PulseChain mainnet = 369)
const network: ethers.Networkish = { chainId: cfg.CHAIN_ID, name: 'pulsechain' };
export const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, network);

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)",
  "function WETH() external view returns (address)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

export function routerInstance(signer?: ethers.Signer) {
  return new ethers.Contract(cfg.ROUTER_ADDRESS, ROUTER_ABI, signer ?? provider);
}

export function erc20(address: string, signer?: ethers.Signer) {
  return new ethers.Contract(address, ERC20_ABI, signer ?? provider);
}

export async function getPrice(amountInWei: bigint, path: string[]) {
  const r = routerInstance();
  const amounts: readonly bigint[] = await r.getAmountsOut(amountInWei, path);
  // Normalize to native bigint
  return amounts.map((a) => BigInt(a.toString()));
}

export function signerFromPrivKey(privKey: string) {
  return new ethers.Wallet(privKey, provider);
}

export type GasOpts = {
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  gasLimit?: bigint;
};

export async function approveToken(
  privKey: string,
  token: string,
  spender: string,
  amount: bigint,
  gas: GasOpts
) {
  const s = signerFromPrivKey(privKey);
  const c = erc20(token, s);
  const tx = await c.approve(spender, amount, {
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    maxFeePerGas: gas.maxFeePerGas,
    gasLimit: gas.gasLimit,
  });
  return await tx.wait();
}

export async function buyExactETHForTokens(
  privKey: string,
  token: string,
  amountInWei: bigint,
  minOut: bigint,
  gas: GasOpts
) {
  const s = signerFromPrivKey(privKey);
  const r = routerInstance(s);
  const path = [cfg.WPLS_ADDRESS, token];
  const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
  const tx = await r.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut,
    path,
    await s.getAddress(),
    deadline,
    {
      value: amountInWei,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      maxFeePerGas: gas.maxFeePerGas,
      gasLimit: gas.gasLimit,
    }
  );
  return await tx.wait();
}

export async function sellExactTokensForETH(
  privKey: string,
  token: string,
  amountIn: bigint,
  minOut: bigint,
  gas: GasOpts
) {
  const s = signerFromPrivKey(privKey);
  const r = routerInstance(s);
  const path = [token, cfg.WPLS_ADDRESS];
  const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
  const tx = await r.swapExactTokensForETHSupportingFeeOnTransferTokens(
    amountIn,
    minOut,
    path,
    await s.getAddress(),
    deadline,
    {
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      maxFeePerGas: gas.maxFeePerGas,
      gasLimit: gas.gasLimit,
    }
  );
  return await tx.wait();
}

/** Cancel pending txs by replacing them with 0-value self-sends at higher gas. */
export async function clearPendingTransactions(
  privKey: string,
  gas: GasOpts
): Promise<{ cleared: number }> {
  const s = signerFromPrivKey(privKey);
  const addr = await s.getAddress();
  const latest = await provider.getTransactionCount(addr, 'latest');
  const pending = await provider.getTransactionCount(addr, 'pending');
  const toClear = Math.max(0, Number(pending) - Number(latest));
  if (toClear === 0) return { cleared: 0 };

  for (let n = latest; n < pending; n++) {
    const tx = await s.sendTransaction({
      to: addr,
      value: 0n,
      nonce: n,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      maxFeePerGas: gas.maxFeePerGas,
      gasLimit: gas.gasLimit ?? 21000n,
    });
    await tx.wait();
  }
  return { cleared: toClear };
}

/** Withdraw PLS to a recipient */
export async function withdrawPls(
  privKey: string,
  to: string,
  amountWei: bigint,
  gas: GasOpts
) {
  const s = signerFromPrivKey(privKey);
  const tx = await s.sendTransaction({
    to,
    value: amountWei,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    maxFeePerGas: gas.maxFeePerGas,
    gasLimit: gas.gasLimit ?? 21000n,
  });
  return await tx.wait();
}

/** Diagnostics for RPC (ethers v6: use getFeeData instead of getGasPrice) */
export async function pingRpc(address?: string) {
  const info: {
    chainId?: number;
    blockNumber?: number;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    balanceWei?: string;
    error?: string;
  } = {};
  try {
    const net = await provider.getNetwork();
    info.chainId = Number(net.chainId);
    info.blockNumber = await provider.getBlockNumber();

    const fee = await provider.getFeeData().catch(() => null);
    if (fee) {
      if (fee.gasPrice) info.gasPrice = fee.gasPrice.toString();
      if (fee.maxFeePerGas) info.maxFeePerGas = fee.maxFeePerGas.toString();
      if (fee.maxPriorityFeePerGas) info.maxPriorityFeePerGas = fee.maxPriorityFeePerGas.toString();
    }

    if (address) {
      const bal = await provider.getBalance(address);
      info.balanceWei = bal.toString();
    }
  } catch (e: any) {
    info.error = e?.message || String(e);
  }
  return info;
}
