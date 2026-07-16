import { promises as fs } from "node:fs";
import path from "node:path";
import type { WalletInfo } from "./wallets.js";

export type ChangeKind = "inflow" | "outflow";

export interface BalanceRecord {
  /** Balance in wei, as a decimal string (never a JS number — precision matters). */
  balanceWei: string;
  /** ISO-8601 timestamp of the last balance update. */
  updatedAt: string;
}

export interface ChangeEntry {
  index: number;
  address: string;
  kind: ChangeKind;
  /** Signed magnitude of the change in wei, decimal string (always positive here). */
  amountWei: string;
  /** Present for outflows (always) and available for reconciliation. */
  txHash?: string;
  timestamp: string;
}

interface StoreState {
  version: 1;
  network: "sepolia";
  chainId: string;
  wallets: WalletInfo[];
  balances: Record<string, BalanceRecord>;
  changes: ChangeEntry[];
  lastPollAt: string | null;
}

function emptyState(): StoreState {
  return {
    version: 1,
    network: "sepolia",
    chainId: "11155111",
    wallets: [],
    balances: {},
    changes: [],
    lastPollAt: null,
  };
}

/**
 * A tiny JSON-file-backed store for wallets, balances, and the change log.
 *
 * Design notes:
 *  - All wei amounts are stored as decimal strings, never JS numbers, so we
 *    never lose precision on 18-decimal values.
 *  - Writes are atomic (write to a temp file, then rename) and serialized
 *    through a single promise chain to avoid interleaved/corrupt writes. This
 *    is a single-writer store — adequate for N <= 20 wallets in one process.
 */
export class Store {
  private state: StoreState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  /** Load an existing store from disk, or start a fresh one if none exists. */
  static async load(filePath: string): Promise<Store> {
    const store = new Store(path.resolve(filePath));
    try {
      const raw = await fs.readFile(store.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreState;
      store.state = { ...emptyState(), ...parsed };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No file yet — persist the empty state so the data dir/file exists.
      await store.persist();
    }
    return store;
  }

  /**
   * Set the active wallet list to exactly the wallets derived this run.
   *
   * The active set is a pure function of (MNEMONIC, WALLET_COUNT), so we
   * REPLACE the list rather than merge: growing N appends new wallets, and
   * shrinking N exposes a strict prefix/subset (as Requirement 1 demands).
   * Balance and change-log history is keyed by address, so it is retained
   * for any wallet that later becomes active again.
   */
  async setWallets(wallets: WalletInfo[]): Promise<void> {
    this.state.wallets = [...wallets].sort((a, b) => a.index - b.index);
    // Seed a zero baseline for any wallet address we have never tracked.
    for (const w of wallets) {
      if (!this.state.balances[w.address]) {
        this.state.balances[w.address] = {
          balanceWei: "0",
          updatedAt: new Date().toISOString(),
        };
      }
    }
    await this.persist();
  }

  getWallets(): WalletInfo[] {
    return [...this.state.wallets];
  }

  getBalance(address: string): bigint {
    const rec = this.state.balances[address];
    return rec ? BigInt(rec.balanceWei) : 0n;
  }

  getBalanceRecord(address: string): BalanceRecord | undefined {
    return this.state.balances[address];
  }

  /** Overwrite the stored balance baseline for an address. */
  async setBalance(address: string, balanceWei: bigint, at: string): Promise<void> {
    this.state.balances[address] = { balanceWei: balanceWei.toString(), updatedAt: at };
    await this.persist();
  }

  /** Append a change-log entry (inflow or outflow). */
  async addChange(entry: ChangeEntry): Promise<void> {
    this.state.changes.push(entry);
    await this.persist();
  }

  getChanges(address?: string): ChangeEntry[] {
    const all = this.state.changes;
    return address ? all.filter((c) => c.address === address) : [...all];
  }

  getLastPollAt(): string | null {
    return this.state.lastPollAt;
  }

  async setLastPollAt(at: string): Promise<void> {
    this.state.lastPollAt = at;
    await this.persist();
  }

  /** Serialize the current state to disk atomically. */
  private persist(): Promise<void> {
    // Snapshot now so concurrent mutations don't leak into this write.
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
