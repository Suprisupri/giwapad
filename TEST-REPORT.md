# GiwaPad — On-Chain Test Report

**Date:** 2026-11-22 ~00:40 WIB (test run started 21 Nov 17:37 WIB)
**Tester:** subagent (no live browser)
**Network:** GIWA Sepolia, chain 91342 (testnet only)
**App:** `app/` (Vite + TypeScript, `@ammora-protocol/sdk@0.3.9`, `viem@2.58.4`)
**Test scripts:** `test/` (Node, import the app's own `app/src/ammora.ts` + `app/src/policy.ts`)

---

## 1. Test wallet (fresh, testnet-only)

| Item | Value |
| --- | --- |
| Address | `0x106211aff2c18b038003005965C3336136Db08F7` |
| Explorer | https://sepolia-explorer.giwa.io/address/0x106211aff2c18b038003005965C3336136Db08F7 |
| Private key | Stored ONLY in `.test-wallet.json` (mode `600`, gitignored via `.gitignore`). Never printed, never committed. |
| Relation to Rayan's wallets | **None.** Fresh keypair generated locally with `viem/generatePrivateKey` for this task only. Not the Agentic wallet (`0x3157…de79`) nor MetaMask (`0x9707…329F`). |
| Balance (verified on-chain, block 41,937,621) | **0 ETH** — unfunded (see §2) |

---

## 2. Funding — ⛔ BLOCKED (needs browser help)

**Status: NOT FUNDED. No on-chain write step could run.** Per the task instructions,
funding was stopped at this point and no other wallet was used.

| Faucet | What was tried | Result |
| --- | --- | --- |
| Official — https://faucet.giwa.io (0.005 ETH / 24h) | `curl` (3 attempts, browser UA): first attempt empty reply, then **HTTP 403 Cloudflare "Just a moment..." challenge page** (`challenges.cloudflare.com`, Turnstile-style JS challenge). Also tried the text fetcher (`browser.open`): **HTTP 403, upstream access rejected**. | **Blocked.** Cloudflare bot challenge cannot be completed via curl or a text fetch. Needs a live browser to pass the challenge and submit the claim form. |
| Backup (Nodit) — https://faucet.lambda256.io/giwa-sepolia (0.01 ETH / 24h) | `curl` fetched the page (HTTP 200, Next.js). Inspected the page JS bundle (`/_next/static/chunks/507-22a5770b15b3f7e3.js`): the claim flow requires a **Google reCAPTCHA Enterprise token** (`action: "faucet_charge"`, `sitekey` rendered via `grecaptcha.enterprise`) and an **email verification code** (`POST /be/v4.0/faucet/captcha/verify` → `POST /be/v4.0/faucet/charge`). | **Blocked.** reCAPTCHA Enterprise cannot be solved via curl, and the email-code step needs an inbox. Needs a live browser (+ an email address for the code). |

**What is needed to unblock:** a browser session that claims either faucet for
`0x106211aff2c18b038003005965C3336136Db08F7` (0.005 ETH from the official faucet is
enough; 0.01 ETH from Nodit is more comfortable). Budget: ~8–10 txs of gas at
<0.1 gwei + 0.002 ETH to wrap (0.001 WETH graduation threshold + 0.0001 WETH test
buy + fees). After the claim, re-run `cd app && node ../test/01-config.mts` —
the scripts verify the balance on-chain before doing anything.

---

## 3. Results

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 0 | Read-only smoke (block read, `verifyDeployment` pins, template #12 read + hash pin, `planTeamConfig`, 12-point readiness, FeeVault read, KILN curve state, `tokenForCurve`/`curveForToken` round-trip) | **PASS** (all 20 checks) | `test/00-smoke-reads.mts`, ~11 s wall time. Head block 41,937,621. Template #12 hash `0xc2f40255…` matched the pin; policy qualified, all 12 readiness checks PASS (totalSupply 1,010,204,081,632,818 raw; migrationBase 10,204,081,632,818 raw; migrationQuote 0.001 WETH; reviewHash `0x0dba02b8…`). FeeVault `0x414Be4a093fDFd7292dCa95C4D6fdD3905Ee6800` (matches builder). KILN curve matches the safety page exactly (status 2, baseReserve 2 raw, quoteReserve 0.05 WETH). RPC was fast this run (block read 0.6 s) — the earlier degradation was not present. |
| S | Built static site serves (`npm run preview` + curl) | **PASS** | `index.html` HTTP 200 (621 B); JS bundle `./assets/index-DjWJcgEK.js` HTTP 200 (657,863 B); favicon HTTP 200. **JS was NOT executed** — no browser was available, so runtime behaviour of the page itself is untested. |
| 1 | Config preview + creation (GiwaPad policy, template #12, fallback #13; Config #6 quarantined) | **NOT RUN — blocked on funding** | Script ready: `test/01-config.mts` (loads cleanly; stops at the balance gate: "have 0 ETH, need ≥ 0.0005 ETH"). Preview logic already proven by step 0. |
| 2 | Token launch ("GiwaPad Test" / "GPTEST"; `data:` metadata URI first, `https://` fallback) | **NOT RUN — blocked on funding** | Script ready: `test/02-launch.mts`. Fallback URI: `https://suprisupri.github.io/giwapad/gptest.json`. |
| 3 | Wrap ETH → WETH (0.002 ETH), buy 0.0001 WETH, sell 25% | **NOT RUN — blocked on funding** | Script ready: `test/03-wrap-trade.mts` (+ shared `test/trade-helper.mts`, a verbatim mirror of `main.ts executeTrade`). |
| 4 | Buy to 0.001 WETH threshold → ReadyToMigrate → migrate | **NOT RUN — blocked on funding** | Script ready: `test/04-graduate.mts` (final-fill loop, max 3 buys; migration + LP position resolution). |
| 5 | Fee claims (FeeVault WETH + base; LP fees; surplus; leftover) | **NOT RUN — blocked on funding** | Script ready: `test/05-claims.mts`. |

**Transactions sent so far: none. Tx hashes: none yet.**

---

## 4. Bugs found

None so far. No write path has executed yet, so no on-chain bug could be observed.
The read-only smoke test reproduced the builder's results exactly (same FeeVault,
same KILN state, same derived economics).

---

## 5. What is NOT yet tested (and why)

- **Everything that writes on-chain** (steps 1–5): blocked on faucet funding (§2).
  All five step scripts are written, import-checked, and gate on balance/state
  correctly — they are ready to run the moment the wallet is funded.
- **The `data:` metadata URI question**: untested until step 2 runs. The script
  tries the app default first and falls back once to the `https://` override,
  recording which worked.
- **Full graduation live**: untested until step 4 runs. If the threshold buys
  cannot complete (e.g. insufficient WETH), the fallback per the task is to
  verify at least Config + launch + buy + sell and record graduation as
  implemented-but-untested-live.
- **Browser runtime of the built site**: the page + bundle load over HTTP, but
  no JS was executed (no browser available). Wallet-connect UI, button flows,
  and rendering are untested.
- **Post-graduation ARL pool trading**: out of scope for the app v1 (per
  BUILD-NOTES.md) and not covered by the test scripts.

---

## 6. How to resume (after funding)

```bash
cd ~/workspace/ammora-launchpad/app
node ../test/01-config.mts      # create Config
node ../test/02-launch.mts      # launch GPTEST
node ../test/03-wrap-trade.mts  # wrap + buy + sell
node ../test/04-graduate.mts    # buy to threshold + migrate
node ../test/05-claims.mts      # fee claims + surplus/leftover
```

Shared state (Config ID, token/curve addresses, tx hashes) is kept in
`test/state.json` — no secrets in it. Each script is idempotent-safe: it skips
work already recorded in `state.json` and never resends a submitted transaction.
All sends simulate (`eth_call`) first, use exact (never infinite) approvals,
and wait for 13 confirmations, mirroring the app's `sendTx`.

## 7. Documented deviation from "reuse the app's code"

`sendTx` / `ensureApprovals` in `test/harness.mts` are reimplementations of the
app's versions, because the app's versions sign through `window.ethereum`
(EIP-1193, browser-only). The harness keeps the **exact same pattern**
(simulate → send → wait 13 confirmations → canonical-block check → never
resend) but signs with a viem `privateKeyToAccount` wallet client. Everything
else — clients, pacing, planning, parsing, policy derivation, readiness
checks — is imported verbatim from `app/src/ammora.ts` / `app/src/policy.ts`
and the SDK calls are identical to `main.ts`.
