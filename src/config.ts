import "dotenv/config";
import { Mnemonic } from "ethers";
import { z } from "zod";

/**
 * Sepolia chain id. Hard-coded because this service is testnet-only by design.
 */
export const SEPOLIA_CHAIN_ID = 11155111n;

const RawEnv = z.object({
  MNEMONIC: z
    .string()
    .min(1, "MNEMONIC is required")
    .refine((phrase) => Mnemonic.isValidMnemonic(phrase.trim()), {
      message: "MNEMONIC must be a valid BIP-39 mnemonic phrase",
    }),
  RPC_URL: z.string().url("RPC_URL must be a valid URL"),
  // WALLET_COUNT: the assignment mandates a valid range of 1..20 inclusive.
  WALLET_COUNT: z.coerce
    .number()
    .int("WALLET_COUNT must be an integer")
    .min(1, "WALLET_COUNT must be >= 1")
    .max(20, "WALLET_COUNT must be <= 20")
    .default(3),
  POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    // Keep polling comfortably under the 10-minute detection SLA.
    .max(600_000, "POLL_INTERVAL_MS must be <= 600000 (10 min) to meet the detection SLA")
    .default(60_000),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
});

export type Config = {
  mnemonic: string;
  rpcUrl: string;
  walletCount: number;
  pollIntervalMs: number;
  port: number;
};

/**
 * Parse and validate configuration from the environment. Throws a readable
 * error (aggregating all issues) if anything is invalid, so the process fails
 * fast at startup instead of misbehaving later.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    mnemonic: e.MNEMONIC.trim(),
    rpcUrl: e.RPC_URL,
    walletCount: e.WALLET_COUNT,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    port: e.PORT,
  };
}
