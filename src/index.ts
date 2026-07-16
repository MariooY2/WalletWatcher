import path from "node:path";
import { loadConfig } from "./config.js";
import { createProvider } from "./provider.js";
import { Store } from "./store.js";
import { generateWallets, toWalletInfo } from "./wallets.js";
import { BalanceTracker } from "./balanceTracker.js";
import { createServer } from "./server.js";

const DATA_FILE = path.resolve("data", "state.json");

async function main(): Promise<void> {
  const config = loadConfig();

  // Derive wallets deterministically. Keys stay in memory only.
  const derived = generateWallets(config.mnemonic, config.walletCount);
  const wallets = new Map(derived.map((w, i) => [i, w]));
  const walletInfos = derived.map((w, i) => toWalletInfo(w, i));

  const provider = createProvider(config.rpcUrl);

  // Confirm we're actually on Sepolia before doing anything else.
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(
      `RPC_URL is not Sepolia (chainId ${network.chainId}); refusing to start. ` +
        `This service is testnet-only.`,
    );
  }

  const store = await Store.load(DATA_FILE);
  await store.setWallets(walletInfos);

  const tracker = new BalanceTracker(provider, store, config.pollIntervalMs);
  await tracker.start();

  const app = createServer({ store, provider, wallets });
  const server = app.listen(config.port, () => {
    console.log(`wallet-watcher listening on http://localhost:${config.port}`);
    console.log(`network=sepolia wallets=${wallets.size} pollIntervalMs=${config.pollIntervalMs}`);
    console.log(`derived addresses:`);
    for (const info of walletInfos) console.log(`  #${info.index} ${info.address}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    tracker.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
