import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { generateWallets, toWalletInfo } from "../src/wallets.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const infos = (n: number) => generateWallets(MNEMONIC, n).map((w, i) => toWalletInfo(w, i));

let tmp: string;
async function freshStore(): Promise<Store> {
  tmp = path.join(os.tmpdir(), `ww-store-${process.pid}-${Math.floor(performance.now())}.json`);
  return Store.load(tmp);
}

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { force: true });
});

describe("Store.setWallets — active set reflects the current run", () => {
  it("grows: N -> N+m appends new wallets, keeps the originals", async () => {
    const s = await freshStore();
    await s.setWallets(infos(3));
    expect(s.getWallets().map((w) => w.index)).toEqual([0, 1, 2]);
    await s.setWallets(infos(5));
    expect(s.getWallets().map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("shrinks: N -> N-m exposes a strict subset (prefix), not a stale union", async () => {
    const s = await freshStore();
    await s.setWallets(infos(5));
    expect(s.getWallets()).toHaveLength(5);
    await s.setWallets(infos(3));
    expect(s.getWallets().map((w) => w.index)).toEqual([0, 1, 2]); 
  });

  it("retains balance history for a wallet that leaves then re-enters the active set", async () => {
    const s = await freshStore();
    const five = infos(5);
    await s.setWallets(five);
    const addr3 = five[3]!.address;
    await s.setBalance(addr3, 123n, new Date().toISOString());

    await s.setWallets(infos(3));
    expect(s.getWallets().map((w) => w.index)).toEqual([0, 1, 2]);
    await s.setWallets(infos(5));
    expect(s.getBalance(addr3)).toBe(123n);
  });

  it("persists wei as exact decimal strings across reload", async () => {
    const s = await freshStore();
    const [w0] = infos(1);
    await s.setWallets(infos(1));
    await s.setBalance(w0!.address, 200000000000000000n, new Date().toISOString());
    const reloaded = await Store.load(tmp);
    expect(reloaded.getBalance(w0!.address)).toBe(200000000000000000n);
  });
});
