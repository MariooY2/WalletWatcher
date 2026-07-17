# Wallet Watcher & Withdrawal Builder

A self-contained slice of a **custody backend** for **Ethereum Sepolia** (native **ETH**). It:

1. **Generates** N deterministic HD wallets (`1 ≤ N ≤ 20`) from a single seed phrase,
2. **Tracks** each wallet's on-chain balance and logs inflows (reflected within 10 minutes),
3. **Builds and signs** withdrawal transactions — returning the signed payload, and **optionally broadcasting** it and logging the outflow,
4. Exposes it all over a small **HTTP API**.

| | |
|---|---|
| **Network** | Ethereum Sepolia testnet (chainId `11155111`) |
| **Asset** | native ETH |
| **Stack** | Node.js ≥ 20 + TypeScript (ESM), [ethers v6](https://docs.ethers.org/v6/), Express, zod, Vitest |
| **Persistence** | JSON file at `data/state.json` |

> ⚠️ **Testnet only.** Never point this at mainnet, and never put a mnemonic that controls real funds in `.env`.

---

## Table of contents

- [Wallet Watcher \& Withdrawal Builder](#wallet-watcher--withdrawal-builder)
  - [Table of contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Configuration](#configuration)
  - [Run](#run)
  - [End-to-end walkthrough](#end-to-end-walkthrough)
    - [1. Start the service and note the addresses](#1-start-the-service-and-note-the-addresses)
    - [2. Fund a wallet](#2-fund-a-wallet)
    - [3. Watch the inflow get detected (≤ 1 poll interval)](#3-watch-the-inflow-get-detected--1-poll-interval)
    - [4. Build a withdrawal WITHOUT broadcasting (dry run)](#4-build-a-withdrawal-without-broadcasting-dry-run)
    - [5. Broadcast for real](#5-broadcast-for-real)
  - [API reference](#api-reference)
    - [`GET /health`](#get-health)
    - [`GET /wallets`](#get-wallets)
    - [`GET /wallets/:index/changes`](#get-walletsindexchanges)
    - [`POST /withdrawals`](#post-withdrawals)
  - [Common tasks (recipes)](#common-tasks-recipes)
  - [How it works](#how-it-works)
    - [Deterministic wallet generation](#deterministic-wallet-generation)
    - [Balance tracking](#balance-tracking)
    - [Withdrawals](#withdrawals)
    - [Amounts \& precision](#amounts--precision)
  - [Deposit handling](#deposit-handling)
  - [Security practices](#security-practices)
  - [Troubleshooting](#troubleshooting)
  - [Testing](#testing)
    - [Live end-to-end verification (optional)](#live-end-to-end-verification-optional)
  - [Trade-offs](#trade-offs)
  - [Project layout](#project-layout)

---

## Prerequisites

- **Node.js ≥ 20** and npm.
- A **Sepolia RPC URL** — [Alchemy](https://dashboard.alchemy.com/) or [Infura](https://infura.io) recommended (public endpoints work but rate-limit under polling). Make sure the app has the **Ethereum → Sepolia** network enabled.
- A **test mnemonic** (generated below — do not reuse a real one).
- Some **Sepolia ETH** to fund a wallet (from a faucet, or from your own MetaMask on Sepolia). You only need to fund the wallet(s) you want to withdraw from.

---

## Install

```bash
npm install
cp .env.example .env      # then edit .env (see next section)
```

---

## Configuration

All configuration is via `.env` (gitignored). Copy `.env.example` and fill it in:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MNEMONIC` | ✅ | — | BIP-39 seed phrase. All wallets derive from this. Validated at startup (bad checksum → refuses to boot). **Testnet only.** |
| `RPC_URL` | ✅ | — | Sepolia JSON-RPC endpoint, e.g. `https://eth-sepolia.g.alchemy.com/v2/<KEY>`. Service aborts if it isn't Sepolia. |
| `WALLET_COUNT` | | `3` | How many wallets to derive. **Valid range 1–20 inclusive.** |
| `POLL_INTERVAL_MS` | | `60000` | Balance poll interval (ms). Capped at `600000` (10 min) so the detection SLA holds. |
| `PORT` | | `3000` | HTTP port for the API. |

**Generate a fresh test mnemonic:**
```bash
node -e "console.log(require('ethers').Wallet.createRandom().mnemonic.phrase)"
```
Paste the result into `MNEMONIC`. Example `.env` (the mnemonic below is the **public** Hardhat test phrase — a placeholder; generate your own):
```ini
MNEMONIC="test test test test test test test test test test test junk"
RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY"
WALLET_COUNT=10
POLL_INTERVAL_MS=60000
PORT=3000
```

---

## Run

```bash
npm run dev      # watch mode (auto-restarts on file changes)
# or
npm start        # single run
npm run build    # compile to dist/ (tsc)
```

On startup the service **prints its derived addresses** and begins polling:

```
wallet-watcher listening on http://localhost:3000
network=sepolia wallets=10 pollIntervalMs=60000
derived addresses:
  #0 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  #1 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  ...
```

Those addresses are **deterministic** — the same `MNEMONIC` always produces the same list in the same order (see [How it works](#how-it-works)).

---

## End-to-end walkthrough

This is the full flow, start to finish. It matches the API exactly.

### 1. Start the service and note the addresses
```bash
npm run dev
```
Copy the printed `#0` address — that's the one you'll fund.

### 2. Fund a wallet
Send some Sepolia ETH to `#0` (e.g. `0.2` ETH) from MetaMask (on the Sepolia network) or a faucet.

### 3. Watch the inflow get detected (≤ 1 poll interval)
Within ~60 seconds the poller logs it, and the API reflects it:
```bash
curl http://localhost:3000/wallets
```
```json
{ "wallets": [
  { "index": 0, "address": "0xB56E86…6AcE", "path": "m/44'/60'/0'/0/0",
    "balanceWei": "200000000000000000", "balanceEth": "0.2",
    "updatedAt": "2026-07-16T14:48:24.073Z" },
  { "index": 1, "address": "0x33FC…897A", "balanceWei": "0", "balanceEth": "0.0", "updatedAt": … }
]}
```
The inflow is now in the change log:
```bash
curl http://localhost:3000/wallets/0/changes
```
```json
{ "index": 0, "address": "0xB56E86…6AcE",
  "changes": [ { "kind": "inflow", "amountWei": "200000000000000000", "timestamp": "…" } ] }
```

### 4. Build a withdrawal WITHOUT broadcasting (dry run)
This signs a real transaction and returns it — but **sends nothing** and records **no** outflow:
```bash
curl -X POST http://localhost:3000/withdrawals \
  -H 'content-type: application/json' \
  -d '{"fromIndex":0,"to":"0xYourDestinationAddress","amountEth":"0.05"}'
```
```json
{
  "from": "0xB56E86…6AcE",
  "broadcast": false,
  "txHash": "0x…",                 // computed, but not sent
  "payload": {
    "to": "0xYourDestinationAddress", "value": "50000000000000000", "valueEth": "0.05",
    "nonce": 0, "gasLimit": "21000",
    "maxFeePerGas": "…", "maxPriorityFeePerGas": "…", "chainId": "11155111", "type": 2
  },
  "maxFeeWei": "…",
  "rawSignedTx": "0x02f8…",         // broadcast-ready, but withheld
  "signature": { "r": "0x…", "s": "0x…", "yParity": 0, "v": 27 }
}
```
Confirm nothing was logged — the change log still shows only the inflow:
```bash
curl http://localhost:3000/wallets/0/changes    # still just the inflow entry
```

### 5. Broadcast for real
Add `"broadcast": true`. This sends the transaction and records the outflow:
```bash
curl -X POST http://localhost:3000/withdrawals \
  -H 'content-type: application/json' \
  -d '{"fromIndex":0,"to":"0xYourDestinationAddress","amountEth":"0.05","broadcast":true}'
```
The response now has `"broadcast": true` and a **real** `txHash`. Verify it:
```bash
# in the change log — now an outflow with the tx hash:
curl http://localhost:3000/wallets/0/changes
# on the block explorer:
#   https://sepolia.etherscan.io/tx/<txHash>
```
Within one more poll interval, `#0`'s balance in `GET /wallets` drops (value + gas), and — if you sent to another of your own wallets — that wallet shows a **new inflow**.

That's the entire lifecycle: **derive → fund → track (inflow) → build/sign → broadcast (outflow) → verify.**

---

## API reference

Base URL: `http://localhost:<PORT>` (default `http://localhost:3000`). All responses are JSON.

### `GET /health`
Liveness and last poll time.
```bash
curl http://localhost:3000/health
```
```json
{ "status": "ok", "network": "sepolia", "walletCount": 10, "lastPollAt": "2026-07-16T14:49:24.438Z" }
```

### `GET /wallets`
All wallet addresses with their current (persisted) balances.

Response — `wallets[]`, each:
| field | type | meaning |
|---|---|---|
| `index` | number | derivation index (`m/44'/60'/0'/0/<index>`) |
| `address` | string | the wallet address |
| `path` | string | full BIP-44 derivation path |
| `balanceWei` | string | balance in wei (decimal string — exact) |
| `balanceEth` | string | human-readable ETH (display only) |
| `updatedAt` | string\|null | ISO timestamp of the last balance update |

### `GET /wallets/:index/changes`
The balance-change log for one wallet. Returns `404` if `index` isn't an active wallet.

Response — `changes[]`, each:
| field | type | meaning |
|---|---|---|
| `kind` | `"inflow"` \| `"outflow"` | inflow = detected by tracking; outflow = a broadcast withdrawal |
| `amountWei` | string | magnitude in wei (decimal string) |
| `txHash` | string? | present for **outflows** (the broadcast tx); absent for polled inflows |
| `timestamp` | string | ISO time the entry was recorded |

### `POST /withdrawals`
Build (and optionally broadcast) a withdrawal.

Request body:
| field | type | required | notes |
|---|---|---|---|
| `fromIndex` | number | ✅ | derivation index of the source wallet |
| `to` | string | ✅ | destination address (validated with `ethers.isAddress`) |
| `amountEth` | string | ✅ | amount in ETH as a **string** (e.g. `"0.05"`) — parsed to exact wei |
| `broadcast` | boolean | | defaults to `false` |

Response (same shape for both modes; `broadcast` and `txHash` differ):
| field | meaning |
|---|---|
| `from` | source wallet address |
| `broadcast` | `false` for a dry run, `true` if sent |
| `txHash` | computed hash (dry run) or the real broadcast hash |
| `payload` | full tx fields: `to`, `value`/`valueEth`, `nonce`, `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, `chainId`, `type` (all as strings/numbers) |
| `maxFeeWei` | `gasLimit × maxFeePerGas` — the worst-case fee reserved from the balance |
| `rawSignedTx` | the serialized, broadcast-ready signed transaction |
| `signature` | decomposed `{ r, s, yParity, v }` |

**Status codes**
| code | when |
|---|---|
| `200` | build-only success |
| `201` | broadcast success |
| `400` | invalid body, invalid address, non-positive/malformed amount, or insufficient balance |
| `404` | no wallet at `fromIndex` |
| `502` | RPC didn't return EIP-1559 fee data |

**Example error** (insufficient balance — value + gas exceeds the wallet balance):
```json
{ "error": "insufficient balance: need 0.05004… ETH (value 0.05 + max fee 0.00004…) but wallet holds 0.01 ETH" }
```

---

## Common tasks (recipes)

**Change how many wallets you run.** Edit `WALLET_COUNT` (1–20) and restart. Growing it keeps existing wallets and appends new ones; shrinking it exposes a prefix. `#0` is always the same address.

**Transfer between your own wallets.** Use another wallet's address as `to` (the printed list). Great for testing without an external destination — the source logs an `outflow`, the destination logs an `inflow` on the next poll.

**Do a dry run before sending.** Omit `broadcast` (or set it `false`). You get the fully signed `rawSignedTx` back and can inspect/verify it; nothing is sent and no outflow is logged.

**Reset all persisted state.** Stop the service and delete the store:
```bash
rm -rf data/            # wallets, balances, and change log are rebuilt on next run
```
Do this whenever you **change `MNEMONIC`**, so old addresses/history don't linger.

**Inspect the raw store.**
```bash
cat data/state.json     # addresses, balances (wei strings), change log, lastPollAt — never keys
```

---

## How it works

### Deterministic wallet generation
All wallets derive from one **BIP-39 mnemonic** at the standard path `m/44'/60'/0'/0/i`. The wallet at index `i` is a pure function of `(mnemonic, i)`, which yields the required invariants:

- **Same `N`** → identical list.
- **`N + m`** → original `N` wallets **plus** `m` appended.
- **`N − m`** → a **prefix (subset)** of `N`.

Private keys are derived **on demand and held only in memory**; the store persists **addresses only**.

### Balance tracking
A poller (default every 60s, well under the 10-minute SLA) reads each wallet's balance via `getBalance`, compares it to the last persisted baseline, records **positive deltas as inflows**, and updates the baseline. See [Deposit handling](#deposit-handling).

### Withdrawals
A fully-populated **EIP-1559 (type 2)** transaction is built (`nonce` from the pending count, fees from `getFeeData`, `gasLimit` 21000 for a value transfer), signed locally with the wallet's in-memory key, and — if `broadcast` — sent via `broadcastTransaction`. The signer is sanity-checked to equal the source wallet.

### Amounts & precision
All amounts are handled as **`bigint` wei** and persisted as **decimal strings** — never JS floats. `amountEth` is parsed with ethers' fixed-point `parseEther`, so `0.000000000000000001` ETH = exactly `1` wei, and anything finer than 1 wei is rejected.

---

## Deposit handling

> Per the assignment, deposit-transaction **aggregation is not implemented**. This describes how the service *behaves* around deposits.

The tracker uses **balance-diff polling** — it compares each wallet's current on-chain balance to the last persisted baseline.

- **Multiple deposits within one interval** collapse into a single **net `inflow`** (the delta). Individual deposit txs are not attributed. No funds are missed — the on-chain balance is authoritative.
- **While offline**, no polling happens. On restart, the first poll compares the current balance to the last saved baseline and records the **net change accrued while offline** as one `inflow`. Nothing is lost, but intermediate deposits/amounts/hashes/timing aren't captured — only the net delta.
- **A deposit and a broadcast-withdrawal in the *same* interval on the *same* wallet.** The balance baseline is sourced only from the chain (updated by polling), so the outflow — already logged at broadcast time — and the deposit are seen together as one net delta. The result: the tracked `inflow` amount is **netted against that outflow** (understated, or, if the interval nets negative, not logged as a separate inflow). The **outflow is always recorded correctly** and the **balance is always correct**; only the inflow's *amount attribution* is affected. This is a deliberate trade-off — decrementing the baseline optimistically at broadcast could invent a **phantom inflow** if the tx were later dropped, so the baseline is kept truthful (chain-sourced) instead.
- **Detection latency:** default 60s ≪ the 10-minute requirement; the interval is capped at 10 minutes so the SLA holds by construction.

Per-deposit fidelity (individual amounts, senders, hashes) would require scanning blocks / transfer activity instead of diffing balances — intentionally out of scope.

**Inflows vs. outflows:** inflows come only from the poller (positive delta); **outflows are recorded only when a withdrawal is broadcast**. Building/simulating logs nothing, and a broadcast-induced balance drop is *not* re-logged by the poller (it only realigns the baseline).

---

## Security practices

- **No committed secrets.** `.env` is gitignored; `.env.example` holds placeholders only.
- **Keys never persisted.** Private keys are re-derived from the mnemonic on demand and live only in process memory. `data/state.json` stores addresses, balances, and the change log — never keys, never the phrase.
- **Testnet enforced.** The service refuses to start if the RPC's chainId isn't Sepolia.
- **Input validation.** Env config and request bodies are validated with zod; addresses via `ethers.isAddress`; amounts via fixed-point `parseEther`.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `401 Unauthorized` / `"Must be authenticated!"` from the RPC | Bad/incomplete Alchemy key, or **Sepolia not enabled** on the app. Verify with: `curl -s https://eth-sepolia.g.alchemy.com/v2/<KEY> -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` → expect `{"result":"0xaa36a7"}`. Or fall back to a public RPC. |
| `RPC_URL is not Sepolia (chainId …); refusing to start` | The endpoint points at the wrong network. Use a Sepolia URL. |
| `Invalid configuration: MNEMONIC …` at startup | The phrase isn't a valid BIP-39 mnemonic (checksum). Regenerate it (see [Configuration](#configuration)). |
| `insufficient balance …` on withdrawal | The wallet can't cover `value + gas`. Fund it more, or lower `amountEth`. |
| Inflow not showing yet | Wait one `POLL_INTERVAL_MS`; check `GET /health`'s `lastPollAt`. |
| Old addresses/history after changing the mnemonic | `rm -rf data/` and restart. |

---

## Testing

```bash
npm test         # Vitest — wallet generation + transaction building (fully offline, no RPC)
npm run test:watch
npm run typecheck
```

The unit tests assert the requirement directly: exact derived addresses for a fixed mnemonic, the `N` / `N+m` / `N−m` invariants, the 1–20 range, exact wei precision (`0.000000000000000001` → `1` wei), and that a built tx's recovered signer equals the source wallet.

### Live end-to-end verification (optional)
With the service running and a wallet funded, a harness exercises **every requirement against the live chain** — a real broadcast, real inflow-detection latency, outflow logging, and all API error paths:
```bash
npm run verify:live    # spends a little Sepolia ETH; prints PASS/FAIL per requirement
```
This is a manual integration check (it broadcasts real transactions), separate from the offline `npm test` suite.

---

## Trade-offs

- **Balance-diff polling vs. event scanning.** Simple and meets the SLA, but only net deltas — no per-deposit attribution.
- **JSON file store vs. a database.** Zero native deps, trivially inspectable; writes are atomic (temp-file + rename) and serialized. It's a **single-writer** store — fine for N ≤ 20 in one process, not horizontal scale.
- **Single-mnemonic HD derivation.** Clean determinism and one secret to protect. A production custodian would isolate keys in an HSM/KMS rather than one seed controlling all wallets.
- **Nonce handling.** Uses the pending nonce at build time. Two concurrent broadcasts from the *same* wallet could collide; the service doesn't queue per-wallet withdrawals.
- **Fixed gas limit.** A native transfer is exactly 21,000 gas, so it's hard-coded; EIP-1559 fees are fetched live via `getFeeData`.

---

## Project layout

```
src/
  config.ts          env loading + zod validation
  provider.ts        ethers JsonRpcProvider (pinned to Sepolia)
  wallets.ts         deterministic HD derivation            (unit tested)
  store.ts           JSON-file persistence (atomic writes)
  balanceTracker.ts  polling loop + inflow detection
  withdrawal.ts      build + sign + optional broadcast       (unit tested)
  server.ts          Express API
  index.ts           bootstrap
test/
  wallets.test.ts
  withdrawal.test.ts
```
