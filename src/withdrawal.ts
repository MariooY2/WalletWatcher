import {
  formatEther,
  isAddress,
  parseEther,
  Transaction,
  type JsonRpcProvider,
  type HDNodeWallet,
} from "ethers";
import type { Store } from "./store.js";

/** Gas required for a plain native-ETH value transfer. */
export const VALUE_TRANSFER_GAS = 21_000n;

/** Error carrying an HTTP status so the API can map it to a 4xx response. */
export class WithdrawalError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "WithdrawalError";
  }
}

export interface WithdrawalInput {
  to: string;
  amountEth: string;
}

/**
 * Everything about the chain needed to build a tx, injected explicitly so the
 * builder can be exercised fully offline in unit tests.
 */
export interface ChainContext {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: bigint;
  balanceWei: bigint;
  gasLimit?: bigint;
}

export interface BuiltWithdrawal {
  from: string;
  broadcast: boolean;
  txHash: string;
  payload: {
    to: string;
    value: string;
    valueEth: string;
    nonce: number;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    chainId: string;
    type: 2;
  };
  /** gasLimit * maxFeePerGas — the worst-case fee reserved from the balance. */
  maxFeeWei: string;
  rawSignedTx: string;
  signature: { r: string; s: string; yParity: number; v: number };
}

/**
 * Parse an ETH amount string into exact wei. Uses ethers' fixed-point parser so
 * there is no floating-point rounding — "0.000000000000000001" -> 1n wei.
 */
export function parseAmountToWei(amountEth: string): bigint {
  let value: bigint;
  try {
    value = parseEther(amountEth.trim());
  } catch {
    throw new WithdrawalError(`invalid amountEth: "${amountEth}"`);
  }
  if (value <= 0n) throw new WithdrawalError("amountEth must be greater than 0");
  return value;
}

/**
 * Build and sign a native-ETH withdrawal transaction. Pure and offline: no
 * network access, no persistence. Returns the fully-populated, signed tx as a
 * JSON-serializable object (never broadcast here).
 */
export async function buildAndSignWithdrawal(
  wallet: HDNodeWallet,
  input: WithdrawalInput,
  ctx: ChainContext,
): Promise<BuiltWithdrawal> {
  const to = input.to.trim();
  if (!isAddress(to)) throw new WithdrawalError(`invalid destination address: "${input.to}"`);

  const value = parseAmountToWei(input.amountEth);
  const gasLimit = ctx.gasLimit ?? VALUE_TRANSFER_GAS;
  const maxFeeWei = gasLimit * ctx.maxFeePerGas;
  const required = value + maxFeeWei;
  if (required > ctx.balanceWei) {
    throw new WithdrawalError(
      `insufficient balance: need ${formatEther(required)} ETH ` +
        `(value ${formatEther(value)} + max fee ${formatEther(maxFeeWei)}) ` +
        `but wallet holds ${formatEther(ctx.balanceWei)} ETH`,
    );
  }

  // Fully-populated EIP-1559 (type 2) transaction. `from` is intentionally
  // omitted; signing binds it to this wallet.
  const tx = Transaction.from({
    to,
    value,
    nonce: ctx.nonce,
    gasLimit,
    maxFeePerGas: ctx.maxFeePerGas,
    maxPriorityFeePerGas: ctx.maxPriorityFeePerGas,
    chainId: ctx.chainId,
    type: 2,
  });

  const rawSignedTx = await wallet.signTransaction(tx);
  const signed = Transaction.from(rawSignedTx);

  if (!signed.signature) throw new Error("signing produced no signature");
  if (signed.from?.toLowerCase() !== wallet.address.toLowerCase()) {
    // Sanity check: the recovered signer must be the wallet we intended.
    throw new Error("recovered signer does not match wallet address");
  }

  const sig = signed.signature;
  return {
    from: wallet.address,
    broadcast: false,
    txHash: signed.hash!,
    payload: {
      to,
      value: value.toString(),
      valueEth: formatEther(value),
      nonce: ctx.nonce,
      gasLimit: gasLimit.toString(),
      maxFeePerGas: ctx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: ctx.maxPriorityFeePerGas.toString(),
      chainId: ctx.chainId.toString(),
      type: 2,
    },
    maxFeeWei: maxFeeWei.toString(),
    rawSignedTx,
    signature: { r: sig.r, s: sig.s, yParity: sig.yParity, v: sig.v },
  };
}

/**
 * Read the current chain context (nonce, fees, balance) for a sender.
 */
export async function fetchChainContext(
  provider: JsonRpcProvider,
  from: string,
): Promise<ChainContext> {
  const [nonce, feeData, balanceWei, network] = await Promise.all([
    provider.getTransactionCount(from, "pending"),
    provider.getFeeData(),
    provider.getBalance(from),
    provider.getNetwork(),
  ]);
  if (feeData.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) {
    throw new WithdrawalError(
      "RPC did not return EIP-1559 fee data (maxFeePerGas/maxPriorityFeePerGas)",
      502,
    );
  }
  return {
    nonce,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    chainId: network.chainId,
    balanceWei,
  };
}

/**
 * End-to-end withdrawal: fetch context, build + sign, and optionally broadcast.
 * When broadcast succeeds, an `outflow` entry is recorded in the store (this is
 * the ONLY place outflows are logged). A build-only call never touches the store
 * and produces no on-chain effect.
 */
export async function submitWithdrawal(
  provider: JsonRpcProvider,
  store: Store,
  wallet: HDNodeWallet,
  walletIndex: number,
  input: WithdrawalInput,
  broadcast: boolean,
): Promise<BuiltWithdrawal> {
  const ctx = await fetchChainContext(provider, wallet.address);
  const built = await buildAndSignWithdrawal(wallet, input, ctx);

  if (!broadcast) return built;

  const response = await provider.broadcastTransaction(built.rawSignedTx);
  const at = new Date().toISOString();
  await store.addChange({
    index: walletIndex,
    address: wallet.address,
    kind: "outflow",
    amountWei: built.payload.value,
    txHash: response.hash,
    timestamp: at,
  });
  return { ...built, broadcast: true, txHash: response.hash };
}
