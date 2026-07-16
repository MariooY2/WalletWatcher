import { describe, it, expect } from "vitest";
import {
  deriveWallet,
  derivationPath,
  generateWallets,
  toWalletInfo,
} from "../src/wallets.js";

// The public Hardhat/Anvil test mnemonic. Its derived addresses are well-known
// and fixed, which lets us assert exact, deterministic derivation. TEST ONLY.
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

// Standard m/44'/60'/0'/0/i addresses for the mnemonic above (checksummed).
const EXPECTED_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

describe("derivationPath", () => {
  it("produces standard BIP-44 Ethereum paths", () => {
    expect(derivationPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(derivationPath(7)).toBe("m/44'/60'/0'/0/7");
  });

  it("rejects invalid indices", () => {
    expect(() => derivationPath(-1)).toThrow();
    expect(() => derivationPath(1.5)).toThrow();
  });
});

describe("generateWallets", () => {
  it("derives the expected fixed addresses in index order", () => {
    const wallets = generateWallets(TEST_MNEMONIC, 10);
    expect(wallets.map((w) => w.address)).toEqual(EXPECTED_ADDRESSES);
  });

  it("is deterministic: same N produces the identical list", () => {
    const a = generateWallets(TEST_MNEMONIC, 5).map((w) => w.address);
    const b = generateWallets(TEST_MNEMONIC, 5).map((w) => w.address);
    expect(a).toEqual(b);
  });

  it("is index-ordered: N is a strict prefix of N+m", () => {
    const small = generateWallets(TEST_MNEMONIC, 3).map((w) => w.address);
    const large = generateWallets(TEST_MNEMONIC, 8).map((w) => w.address);
    expect(large.slice(0, 3)).toEqual(small);
    expect(large.length).toBe(8);
  });

  it("is index-ordered: N-m is a subset (prefix) of N", () => {
    const full = generateWallets(TEST_MNEMONIC, 6).map((w) => w.address);
    const shrunk = generateWallets(TEST_MNEMONIC, 4).map((w) => w.address);
    expect(shrunk).toEqual(full.slice(0, 4));
  });

  it("enforces the valid range 1..20 inclusive", () => {
    expect(() => generateWallets(TEST_MNEMONIC, 0)).toThrow();
    expect(() => generateWallets(TEST_MNEMONIC, 21)).toThrow();
    expect(generateWallets(TEST_MNEMONIC, 1)).toHaveLength(1);
    expect(generateWallets(TEST_MNEMONIC, 20)).toHaveLength(20);
  });

  it("rejects an invalid mnemonic", () => {
    expect(() => generateWallets("not a real mnemonic phrase", 1)).toThrow();
  });
});

describe("deriveWallet / toWalletInfo", () => {
  it("returns a key-free, index-tagged view", () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 2);
    const info = toWalletInfo(wallet, 2);
    expect(info).toEqual({
      index: 2,
      address: EXPECTED_ADDRESSES[2],
      path: "m/44'/60'/0'/0/2",
    });
    // The view must not leak private key material.
    expect(info).not.toHaveProperty("privateKey");
    expect(Object.keys(info)).toEqual(["index", "address", "path"]);
  });
});
