import { formatEther, type JsonRpcProvider } from "ethers";
import type { Store } from "./store.js";

/**
 * Polls each wallet's on-chain balance and records inflows.
 *
 * Detection model (balance-diff polling):
 *  - For each wallet we compare the current on-chain balance to the last
 *    persisted baseline.
 *  - A positive delta is recorded as a single `inflow` change entry. If several
 *    deposits land within one interval, they collapse into one net inflow (this
 *    is intentional; per-deposit attribution is out of scope — see README).
 *  - A negative delta is NEVER logged. Outflows are recorded only when a
 *    withdrawal is broadcast (see withdrawal.ts). We simply move the baseline
 *    down so a broadcast-induced drop isn't misread on the next poll.
 *  - The baseline is always updated to the fresh on-chain value.
 *
 * With the default 60s interval, changes are reflected well within the 10-minute
 * SLA. On restart, the first poll compares against the last persisted baseline,
 * so any net change accrued while offline is captured as one inflow.
 */
export class BalanceTracker {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly store: Store,
    private readonly intervalMs: number,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  /** Run one poll immediately, then schedule recurring polls. */
  async start(): Promise<void> {
    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Poll all wallets once. Reentrancy-guarded so a slow RPC round can't overlap
   * with the next scheduled tick.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const wallets = this.store.getWallets();
      for (const w of wallets) {
        try {
          const current = await this.provider.getBalance(w.address);
          const previous = this.store.getBalance(w.address);
          const at = new Date().toISOString();

          if (current > previous) {
            const delta = current - previous;
            await this.store.addChange({
              index: w.index,
              address: w.address,
              kind: "inflow",
              amountWei: delta.toString(),
              timestamp: at,
            });
            this.log(
              `inflow  [#${w.index} ${w.address}] +${formatEther(delta)} ETH ` +
                `(balance ${formatEther(current)} ETH)`,
            );
          } else if (current < previous) {
            // Balance dropped — attributable to a broadcast withdrawal, which is
            // logged separately. Just realign the baseline; do not log here.
            this.log(
              `baseline down [#${w.index} ${w.address}] now ${formatEther(current)} ETH ` +
                `(outflow logged at broadcast time)`,
            );
          }

          if (current !== previous) {
            await this.store.setBalance(w.address, current, at);
          }
        } catch (err) {
          this.log(`poll error [#${w.index} ${w.address}]: ${(err as Error).message}`);
        }
      }
      await this.store.setLastPollAt(new Date().toISOString());
    } finally {
      this.polling = false;
    }
  }
}
