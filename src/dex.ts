// src/dex.ts (WPLS-only)
import { ethers } from 'ethers';
import { getConfig } from './config.js';

const cfg = getConfig();
export const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);

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
  const amounts: bigint[] = await r.getAmountsOut(amountInWei, path);
  return amounts.map(a => BigInt(a.toString()));
}

export function signerFromPrivKey(privKey: string) {
  return new ethers.Wallet(privKey, provider);
}

export type GasOpts = {
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  gasLimit?: bigint;
};

export async function approveToken(privKey: string, token: string, spender: string, amount: bigint, gas: GasOpts) {
  const s = signerFromPrivKey(privKey);
  const c = erc20(token, s);
  const tx = await c.approve(spender, amount, {
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    maxFeePerGas: gas.maxFeePerGas,
    gasLimit: gas.gasLimit,
  });
  return await tx.wait();
}

export async function buyExactETHForTokens(privKey: string, token: string, amountInWei: bigint, minOut: bigint, gas: GasOpts) {
  const s = signerFromPrivKey(privKey);
  const r = routerInstance(s);
  const path = [cfg.WPLS_ADDRESS, token];
  const deadline = Math.floor(Date.now()/1000)+60*10;
  const tx = await r.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut, path, await s.getAddress(), deadline, {
      value: amountInWei,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      maxFeePerGas: gas.maxFeePerGas,
      gasLimit: gas.gasLimit,
    }
  );
  return await tx.wait();
}

export async function sellExactTokensForETH(privKey: string, token: string, amountIn: bigint, minOut: bigint, gas: GasOpts) {
  const s = signerFromPrivKey(privKey);
  const r = routerInstance(s);
  const path = [token, cfg.WPLS_ADDRESS];
  const deadline = Math.floor(Date.now()/1000)+60*10;
  const tx = await r.swapExactTokensForETHSupportingFeeOnTransferTokens(
    amountIn, minOut, path, await s.getAddress(), deadline, {
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      maxFeePerGas: gas.maxFeePerGas,
      gasLimit: gas.gasLimit,
    }
  );
  return await tx.wait();
}
