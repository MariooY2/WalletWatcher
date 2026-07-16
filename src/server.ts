import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { formatEther, type HDNodeWallet, type JsonRpcProvider } from "ethers";
import { z } from "zod";
import type { Store } from "./store.js";
import { submitWithdrawal, WithdrawalError } from "./withdrawal.js";

export interface ServerDeps {
  store: Store;
  provider: JsonRpcProvider;
  /** Derived wallets (with keys) held in memory, keyed by derivation index. */
  wallets: Map<number, HDNodeWallet>;
}

const WithdrawalBody = z.object({
  fromIndex: z.number().int().nonnegative(),
  to: z.string().min(1),
  amountEth: z.string().min(1),
  broadcast: z.boolean().optional().default(false),
});

/** Wrap an async handler so rejections reach the error middleware. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createServer(deps: ServerDeps): Express {
  const { store, provider, wallets } = deps;
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      network: "sepolia",
      walletCount: wallets.size,
      lastPollAt: store.getLastPollAt(),
    });
  });

  // (a) All wallet addresses and their current balances.
  app.get("/wallets", (_req: Request, res: Response) => {
    const result = store.getWallets().map((w) => {
      const rec = store.getBalanceRecord(w.address);
      const balanceWei = rec?.balanceWei ?? "0";
      return {
        index: w.index,
        address: w.address,
        path: w.path,
        balanceWei,
        balanceEth: formatEther(BigInt(balanceWei)),
        updatedAt: rec?.updatedAt ?? null,
      };
    });
    res.json({ wallets: result });
  });

  // Per-wallet balance-change log (inflows from tracking, outflows from broadcasts).
  app.get("/wallets/:index/changes", (req: Request, res: Response) => {
    const index = Number(req.params.index);
    const wallet = store.getWallets().find((w) => w.index === index);
    if (!wallet) {
      res.status(404).json({ error: `no wallet at index ${req.params.index}` });
      return;
    }
    res.json({ index, address: wallet.address, changes: store.getChanges(wallet.address) });
  });

  // (b) Create, and optionally broadcast, a withdrawal from a wallet to a destination.
  app.post(
    "/withdrawals",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = WithdrawalBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid request body", issues: parsed.error.issues });
        return;
      }
      const { fromIndex, to, amountEth, broadcast } = parsed.data;
      const wallet = wallets.get(fromIndex);
      if (!wallet) {
        res.status(404).json({ error: `no wallet at index ${fromIndex}` });
        return;
      }
      const built = await submitWithdrawal(
        provider,
        store,
        wallet,
        fromIndex,
        { to, amountEth },
        broadcast,
      );
      res.status(broadcast ? 201 : 200).json(built);
    }),
  );

  // Central error handler — maps WithdrawalError to its status, else 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof WithdrawalError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return app;
}
