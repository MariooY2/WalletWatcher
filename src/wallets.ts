import { HDNodeWallet, Mnemonic } from "ethers";

/**
 * Standard BIP-44 Ethereum derivation path for account 0, external chain.
 * The wallet at index `i` lives at `m/44'/60'/0'/0/i`.
 */
export function derivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`wallet index must be a non-negative integer, got: ${index}`);
  }
  return `m/44'/60'/0'/0/${index}`;
}

/**
 * Derive a single HD wallet from the mnemonic at the given index.
 *
 * The result is a pure function of `(mnemonic, index)`: the same inputs always
 * produce the same address and private key. Private keys exist only in memory
 * here and are never persisted.
 */
export function deriveWallet(mnemonic: string, index: number): HDNodeWallet {
  const phrase = mnemonic.trim();
  if (!Mnemonic.isValidMnemonic(phrase)) {
    throw new Error("invalid BIP-39 mnemonic");
  }
  // Derive from the mnemonic phrase at an explicit, absolute path.
  return HDNodeWallet.fromPhrase(phrase, undefined, derivationPath(index));
}

/**
 * Generate `count` wallets for indices 0..count-1.
 *
 * Determinism / index-ordering guarantees (per the assignment):
 *  - Same `count`      -> identical list of wallets.
 *  - `count + m`       -> the original wallets plus `m` new ones appended.
 *  - `count - m`       -> a strict prefix (subset) of the larger list.
 * These hold because each wallet is derived independently from its index.
 */
export function generateWallets(mnemonic: string, count: number): HDNodeWallet[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error(`wallet count must be an integer in [1, 20], got: ${count}`);
  }
  const wallets: HDNodeWallet[] = [];
  for (let i = 0; i < count; i++) {
    wallets.push(deriveWallet(mnemonic, i));
  }
  return wallets;
}

/**
 * A lightweight, key-free view of a derived wallet, safe to persist and expose.
 */
export interface WalletInfo {
  index: number;
  address: string;
  path: string;
}

export function toWalletInfo(wallet: HDNodeWallet, index: number): WalletInfo {
  return { index, address: wallet.address, path: derivationPath(index) };
}
