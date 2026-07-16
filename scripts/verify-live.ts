/**
 * Live end-to-end verification harness.
 *
 * Exercises every requirement against the RUNNING service (http://localhost:PORT)
 * and the real Sepolia chain (via RPC_URL). It performs a real broadcast and
 * measures real inflow-detection latency, so it spends a little testnet ETH.
 *
 * Prereqs: the service is running (`npm run dev`) and at least one wallet holds
 * a small amount of Sepolia ETH.
 *
 * Run:  npx tsx scripts/verify-live.ts
 */
import "dotenv/config";
import { Transaction, recoverAddress, parseEther, formatEther } from "ethers";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/provider.js";
import { generateWallets } from "../src/wallets.js";

const cfg = loadConfig();
const provider = createProvider(cfg.rpcUrl);
const BASE = `http://localhost:${cfg.port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const lines: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  (ok ? pass++ : fail++);
  lines.push(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function api(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, init);
  const body = await r.json().catch(() => null);
  return { status: r.status, body: body as any };
}
function post(payload: object) {
  return api("/withdrawals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  // Preflight: service reachable?
  const health = await api("/health").catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Service not reachable at ${BASE}. Start it first: npm run dev`);
    process.exit(1);
  }

  // ── Requirement 1 — Wallet generation ──────────────────────────────────────
  console.log("\nR1 — Wallet generation (deterministic, index-ordered, 1..20)");
  const a = generateWallets(cfg.mnemonic, cfg.walletCount).map((w) => w.address);
  const b = generateWallets(cfg.mnemonic, cfg.walletCount).map((w) => w.address);
  check("deterministic: same N -> identical list", JSON.stringify(a) === JSON.stringify(b));

  const n3 = generateWallets(cfg.mnemonic, Math.min(3, cfg.walletCount)).map((w) => w.address);
  check("index-ordered: N=3 is a prefix of N", JSON.stringify(a.slice(0, n3.length)) === JSON.stringify(n3));

  let threw0 = false, threw21 = false;
  try { generateWallets(cfg.mnemonic, 0); } catch { threw0 = true; }
  try { generateWallets(cfg.mnemonic, 21); } catch { threw21 = true; }
  check("range 1..20 enforced (0 and 21 rejected)", threw0 && threw21);

  const wl = await api("/wallets");
  const apiAddrs = wl.body.wallets.map((w: any) => w.address);
  check("service /wallets matches independent derivation", JSON.stringify(apiAddrs) === JSON.stringify(a));

  // ── Requirement 2 — Balance tracking + persistence ─────────────────────────
  console.log("\nR2 — Balance tracking + persistence");
  let allMatch = true, mism = "";
  for (const w of wl.body.wallets) {
    const live = (await provider.getBalance(w.address)).toString();
    if (live !== w.balanceWei) { allMatch = false; mism = `#${w.index} store=${w.balanceWei} chain=${live}`; }
  }
  check("stored balances match live on-chain (steady state)", allMatch, mism);
  check("balances persisted (updatedAt present)", wl.body.wallets.every((w: any) => w.updatedAt));

  // ── Real broadcast + inflow-latency (R2 SLA, R3, R4, R5) ────────────────────
  console.log("\nR2b/R4 — Real broadcast + inflow detection latency (spends testnet ETH)");
  const dest = wl.body.wallets.find((w: any) => w.balanceWei === "0");
  const src = wl.body.wallets
    .filter((w: any) => BigInt(w.balanceWei) > parseEther("0.004"))
    .sort((x: any, y: any) => (BigInt(y.balanceWei) > BigInt(x.balanceWei) ? 1 : -1))[0];
  if (!dest || !src) {
    check("has an empty destination + a funded source wallet", false, "fund a wallet and retry");
    return finish();
  }
  console.log(`     source=#${src.index} (${formatEther(BigInt(src.balanceWei))} ETH)  dest=#${dest.index} (empty)`);

  const destBefore = (await api(`/wallets/${dest.index}/changes`)).body.changes.length;
  const t0 = Date.now();
  const bcast = await post({ fromIndex: src.index, to: dest.address, amountEth: "0.002", broadcast: true });
  check("R4: broadcast withdrawal accepted (201)", bcast.status === 201, `tx=${bcast.body?.txHash}`);
  const txHash: string = bcast.body?.txHash;

  // R4: broadcast tx is really on-chain
  let onchain = null;
  for (let i = 0; i < 12 && !onchain; i++) { onchain = await provider.getTransaction(txHash); if (!onchain) await sleep(3000); }
  check("R4: broadcast tx found on-chain, correct destination", !!onchain && onchain!.to?.toLowerCase() === dest.address.toLowerCase(),
        onchain ? `block ${onchain.blockNumber ?? "pending"}` : "not found");

  // R3: outflow recorded on source with the tx hash
  const srcChanges = (await api(`/wallets/${src.index}/changes`)).body.changes;
  check("R3: outflow recorded on broadcast (with txHash)", srcChanges.some((c: any) => c.kind === "outflow" && c.txHash === txHash));

  // R2 SLA: inflow appears on dest within the 10-min window
  let detected = false, elapsed = 0;
  while (Date.now() - t0 < 180_000) {
    await sleep(5000);
    const ch = (await api(`/wallets/${dest.index}/changes`)).body.changes;
    if (ch.length > destBefore && ch.some((c: any) => c.kind === "inflow")) {
      detected = true; elapsed = Math.round((Date.now() - t0) / 1000); break;
    }
    process.stdout.write(`     waiting for inflow… ${Math.round((Date.now() - t0) / 1000)}s\r`);
  }
  check("R2: inflow detected within 10-min SLA", detected && elapsed < 600, detected ? `${elapsed}s` : "not detected in 180s");

  // ── Requirement 3 — build-only produces NO outflow ─────────────────────────
  console.log("\nR3 — Simulation logs nothing");
  const cBefore = (await api(`/wallets/${src.index}/changes`)).body.changes.length;
  await post({ fromIndex: src.index, to: dest.address, amountEth: "0.001" }); // build-only
  const cAfter = (await api(`/wallets/${src.index}/changes`)).body.changes.length;
  check("build-only (simulate) adds no change-log entry", cBefore === cAfter);

  // ── Requirement 4 — build-only returns signed tx; signature recovers ───────
  console.log("\nR4 — Build-only returns a valid signed transaction");
  const dry = await post({ fromIndex: src.index, to: dest.address, amountEth: "0.001" });
  check("returns payload + rawSignedTx + signature, broadcast=false",
        !!dry.body.payload && !!dry.body.rawSignedTx && !!dry.body.signature && dry.body.broadcast === false);
  const tx = Transaction.from(dry.body.rawSignedTx);
  const unsigned = Transaction.from({
    to: tx.to, value: tx.value, nonce: tx.nonce, gasLimit: tx.gasLimit,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, chainId: tx.chainId, type: 2,
  }).unsignedHash;
  const recovered = recoverAddress(unsigned, dry.body.signature);
  check("signature recovers to the source wallet", recovered === src.address, recovered);

  // ── Requirement 5 — API surface + error handling ───────────────────────────
  console.log("\nR5 — API + error handling");
  check("GET /health -> ok", health.status === 200 && health.body.status === "ok");
  check("GET /wallets -> list", wl.status === 200 && Array.isArray(wl.body.wallets));
  check("POST bad fromIndex -> 404", (await post({ fromIndex: 999, to: dest.address, amountEth: "0.001" })).status === 404);
  check("POST invalid address -> 400", (await post({ fromIndex: src.index, to: "0xnothex", amountEth: "0.001" })).status === 400);
  const broke = await post({ fromIndex: src.index, to: dest.address, amountEth: "1000000" });
  check("POST insufficient balance -> 400", broke.status === 400 && /insufficient/i.test(broke.body?.error ?? ""));

  finish();
}

function finish() {
  console.log("\n──────────── SUMMARY ────────────");
  console.log(lines.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("verify-live crashed:", e); process.exit(1); });
