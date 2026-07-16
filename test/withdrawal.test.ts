import { describe, it, expect } from "vitest";
import { Transaction, parseEther } from "ethers";
import { deriveWallet } from "../src/wallets.js";
import {
  buildAndSignWithdrawal,
  parseAmountToWei,
  VALUE_TRANSFER_GAS,
  WithdrawalError,
  type ChainContext,
} from "../src/withdrawal.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SEPOLIA = 11155111n;

// A realistic offline chain context. No provider is touched.
function ctx(overrides: Partial<ChainContext> = {}): ChainContext {
  return {
    nonce: 3,
    maxFeePerGas: 20_000_000_000n, // 20 gwei
    maxPriorityFeePerGas: 1_500_000_000n, // 1.5 gwei
    chainId: SEPOLIA,
    balanceWei: parseEther("1"),
    ...overrides,
  };
}

describe("parseAmountToWei", () => {
  it("parses to exact wei with no floating-point error", () => {
    expect(parseAmountToWei("1")).toBe(10n ** 18n);
    expect(parseAmountToWei("0.5")).toBe(500_000_000_000_000_000n);
    // Smallest possible unit — must not round to zero.
    expect(parseAmountToWei("0.000000000000000001")).toBe(1n);
  });

  it("rejects non-positive and malformed amounts", () => {
    expect(() => parseAmountToWei("0")).toThrow(WithdrawalError);
    expect(() => parseAmountToWei("-1")).toThrow(WithdrawalError);
    expect(() => parseAmountToWei("abc")).toThrow(WithdrawalError);
    // More than 18 decimals is not representable in wei.
    expect(() => parseAmountToWei("0.0000000000000000001")).toThrow(WithdrawalError);
  });
});

describe("buildAndSignWithdrawal", () => {
  it("builds a correct, fully-populated EIP-1559 transaction", async () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 0);
    const built = await buildAndSignWithdrawal(
      wallet,
      { to: DESTINATION, amountEth: "0.01" },
      ctx(),
    );

    expect(built.from).toBe(wallet.address);
    expect(built.broadcast).toBe(false);
    expect(built.payload.to).toBe(DESTINATION);
    expect(built.payload.value).toBe(parseEther("0.01").toString());
    expect(built.payload.valueEth).toBe("0.01");
    expect(built.payload.nonce).toBe(3);
    expect(built.payload.gasLimit).toBe(VALUE_TRANSFER_GAS.toString());
    expect(built.payload.chainId).toBe(SEPOLIA.toString());
    expect(built.payload.type).toBe(2);
    // maxFee reserved = gasLimit * maxFeePerGas
    expect(built.maxFeeWei).toBe((VALUE_TRANSFER_GAS * 20_000_000_000n).toString());
  });

  it("produces a signature that recovers to the sending wallet", async () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 5);
    const built = await buildAndSignWithdrawal(
      wallet,
      { to: DESTINATION, amountEth: "0.02" },
      ctx(),
    );

    // Re-parse the broadcast-ready raw tx and verify signer + hash + fields.
    const parsed = Transaction.from(built.rawSignedTx);
    expect(parsed.from).toBe(wallet.address);
    expect(parsed.hash).toBe(built.txHash);
    expect(parsed.to).toBe(DESTINATION);
    expect(parsed.value).toBe(parseEther("0.02"));
    expect(parsed.nonce).toBe(3);
    expect(parsed.chainId).toBe(SEPOLIA);

    // Signature components are exposed and internally consistent.
    expect(built.signature.r).toBe(parsed.signature!.r);
    expect(built.signature.s).toBe(parsed.signature!.s);
    expect(built.signature.yParity).toBe(parsed.signature!.yParity);
    expect([0, 1]).toContain(built.signature.yParity);
  });

  it("rejects an invalid destination address", async () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 0);
    await expect(
      buildAndSignWithdrawal(wallet, { to: "0xnothex", amountEth: "0.01" }, ctx()),
    ).rejects.toThrow(WithdrawalError);
  });

  it("rejects when balance cannot cover value + max fee", async () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 0);
    // Balance is exactly the value, leaving nothing for gas.
    await expect(
      buildAndSignWithdrawal(
        wallet,
        { to: DESTINATION, amountEth: "1" },
        ctx({ balanceWei: parseEther("1") }),
      ),
    ).rejects.toThrow(/insufficient balance/);
  });

  it("allows a withdrawal that exactly fits value + max fee", async () => {
    const wallet = deriveWallet(TEST_MNEMONIC, 0);
    const value = parseEther("0.1");
    const maxFee = VALUE_TRANSFER_GAS * 20_000_000_000n;
    const built = await buildAndSignWithdrawal(
      wallet,
      { to: DESTINATION, amountEth: "0.1" },
      ctx({ balanceWei: value + maxFee }),
    );
    expect(built.payload.value).toBe(value.toString());
  });
});
