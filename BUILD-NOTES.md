# GiwaPad — Build Notes

Builder log for the Ammora Builder mission launchpad. Built 21 Nov 2026 (WIB).
Read-only build: no wallet was created, no private key handled, no transaction sent.

## What was built

A static single-page token launchpad (Vite 8 + TypeScript, vanilla, no framework)
in `app/`, deployable to GitHub Pages from `app/dist` (copied to `/docs` or repo root).

| Area | Status |
| --- | --- |
| Wallet connect (MetaMask/Rabby via viem + EIP-1193, auto switch/add GIWA Sepolia) | ✅ Implemented |
| ETH + WETH balances, faucet link, Wrap ETH → WETH | ✅ Implemented |
| Deployment verification on load (`verifyAmmoraV4CoreAtBlock` vs SDK pins) | ✅ Implemented |
| Config preview: template read → derivation → 12-point readiness check → review hash | ✅ Implemented |
| Config creation (send + receipt-bound verification) | ✅ Implemented (untested on-chain — tester phase) |
| Stored Config revalidation on load (enabled/hash/quarantine) | ✅ Implemented |
| Launch token (name/symbol/description/image, metadata URI) | ✅ Implemented (untested on-chain — tester phase) |
| Token list (localStorage) + lookup by token/curve address (factory-authenticated) | ✅ Implemented |
| Live curve state, graduation progress bar, status badges | ✅ Implemented |
| Live quotes (buy/sell) + fill classification incl. graduation-boundary final fills | ✅ Implemented |
| Buy/sell with exact approvals, simulation, receipt parsing | ✅ Implemented (untested on-chain — tester phase) |
| Migrate (planMigrateAtBlock → simulate → send → receipt parse → LP position resolve) | ✅ Implemented (untested on-chain — tester phase) |
| FeeVault claims (Creator/Partner, WETH + base token) | ✅ Implemented (untested on-chain — tester phase) |
| LP fee claims (DammV2Client, owned positions only) | ✅ Implemented (untested on-chain — tester phase) |
| Creator surplus / leftover actions | ✅ Implemented (untested on-chain — tester phase) |
| Activity log (tx hashes + explorer links, localStorage) | ✅ Implemented |

## Build status

`npm run build` (`tsc && vite build`) — **PASS**. Output `app/dist` (~658 KB JS,
165 KB gzip). No Node builtins leak into the bundle: the SDK + Math packages are
pure ESM (`type: module`, no Node deps); the Node-only example/agent code was never
imported — only SDK builders/clients/parsers + viem.

## SDK exports actually used

From `@ammora-protocol/sdk@0.3.9` (root entrypoint only):

- Catalog: `giwaSepoliaAutoRouteDeployment`
- Config: `buildCreateAmmoraV4Config`, `getAmmoraV4ConfigAtBlock`,
  `parseAmmoraV4ConfigCreatedReceipt`, `assertAmmoraV4Config`,
  `buildSingleSegmentCurve`, `concentratedDepositQuote`, `AmmoraV4MigrationMode`
- Launch: `buildCreateAmmoraV4Launch`, `parseAmmoraV4LaunchCreatedReceipt`
- Curve: `AmmoraV4LaunchCurveClient` (`getStateAtBlock`, `quoteExactInputAtBlock`,
  `getMigrationProgressAtBlock`, `planSwapExactInput`, `planMigrateAtBlock`,
  `planClaimSurplus`, `planWithdrawLeftover`), `classifyAmmoraV4ExactInputFill`,
  `parseAmmoraV4SwapReceipt`, `parseAmmoraV4MigratedReceipt`,
  `resolveAmmoraV4ConcentratedMigrationPositionsReceipt`
- Claims: `feeVaultAbi`, `buildClaimFeeVaultFor`, `DammV2Client`
  (`planClaimManagedConcentratedFees`)
- Infra: `verifyAmmoraV4CoreAtBlock`, `planERC20Approvals`,
  `buildAmmoraPortableWrapTransaction`, `ammoraLaunchFactoryV4Abi`,
  `AMMORA_FEE_POLICY_VERSION`
- Types: `AmmoraV4Config`, `AmmoraV4ConfigSnapshot`, `AmmoraV4Segment`,
  `AmmoraV4LaunchCurveState`

## Addresses verified from the catalog

All read from `giwaSepoliaAutoRouteDeployment` in the installed SDK (slot
`v4-auto-route-20260917`, protocol v4, chain 91342). The three third-party-sourced
addresses from the research notes **all matched the catalog exactly** — no
discrepancies:

| Contract | Catalog value | Research note |
| --- | --- | --- |
| Config Registry | `0x6d043014972b87406C4757a5f2d655A24e0b0aF9` | matched (docs-confirmed) |
| Launch Factory | `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA` | matched (was third-party) |
| Graduation adapter | `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263` | matched (was third-party) |
| Fee policy | `0x17B44C14F640fD429740FA3220f47a567c62725C` | matched (was third-party) |
| WETH | `0x4200000000000000000000000000000000000006` | matched OP predeploy |
| Concentrated factory | `0x9eBD78f3839996014238728b4c9C2f2A4e6759Cb` | catalog only |
| Concentrated position manager | `0x089163706d9956d7baeCeDF4eAb4aD6CcE7Ca2D6` | catalog only |
| Concentrated fee controller | `0x71Fea1fb18647986C4e02D0D06BFb6dD2491F6fE` | catalog only |
| First-buy executor | `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451` | catalog only |
| Native router | `0xade9E6dEF440E05640ed07c4a701C238B9FB66a8` | catalog only |

FeeVault is **not** in the catalog — it is read live from the Factory (`feeVault()`),
per the Ammora examples. The app does the same.

## Deviations from the research notes

1. **`planMigrateAtBlock` is a method, not a standalone export.** The research
   notes list it as a top-level function; in SDK 0.3.9 it exists only as
   `AmmoraV4LaunchCurveClient.planMigrateAtBlock(blockNumber)` (same for
   `planMigrate()`). The app uses the method. Likewise,
   `planExistingConfigAtomicFirstBuy` does not exist as an export.
2. **No atomic Config+token+first-buy flow.** `createConfigAndPoolWithFirstBuy`
   exists in the SDK, but the app uses the simpler two-step flow (create Config,
   then createLaunch) because the brief asks for per-step tx hashes/explorer links
   and the two-step flow is fully covered by the examples. The atomic helper would
   add first-buy-executor approvals and a combined review; not needed for v1.
3. **Template #12/#13 as derivation source (not #10).** No qualified template ID is
   published. Config #10 (the safety page's "test observation") has
   `migrationBaseThreshold = 0` — the quarantined pattern — so it was not used even
   as a derivation source. Configs #12/#13 are enabled, concentrated-mode, and
   already carry a nonzero derived `migrationBaseThreshold`; #12's scalar policy
   (fees, vesting, start price) is the derivation source and all coupled budget
   fields are recomputed. See `docs/graduation-policy-coverage.json`.
4. **Metadata is a `data:` URI by default.** A static site has no IPFS backend.
   `buildCreateAmmoraV4Launch` takes any `metadataURI` string; the app generates a
   `data:application/json;base64,…` URI and lets the user override it with an
   `https://`/`ipfs://` URI. Whether the Factory accepts a `data:` URI on-chain is
   **untested** — the tester should try the default first and fall back to the
   override if the launch simulation reverts.
5. **No `AmmoraSwapClient` / `PreparedExactInputSwap` usage.** Curve trades go
   through `AmmoraV4LaunchCurveClient.planSwapExactInput` (the SDK 0.3.9
   convenience planner), which returns the quote, transaction and approval
   requirements in one call. Post-graduation ARL pool swaps are out of scope (see
   below).
6. **No unwrap button.** Wrapping (ETH → WETH) is wired; unwrapping is a plain
   WETH `withdraw()` and was left out of v1 scope.

## Verification performed (read-only)

- **Catalog check:** printed `giwaSepoliaAutoRouteDeployment` from the installed
  package; all addresses above confirmed (21 Nov 2026).
- **Config census:** read Configs #1–#15 from the Registry at head 41,934,643.
  #6 confirmed disabled with the quarantined hash `0x6048…e667`. #12/#13 confirmed
  enabled, concentrated, nonzero migrationBaseThreshold.
- **Derivation validation:** the ported derivation reproduces Config #12 **exactly**
  (segment bounds + liquidity, totalSupply, migrationBaseThreshold, post-migration
  liquidity and range) when fed #12's own inputs (sale 100,000 tokens, threshold
  0.00001 WETH). Note: an early unit error (10¹³ raw misread as 0.01 WETH instead
  of 0.00001 WETH) briefly suggested a mismatch; corrected and verified exact.
- **Policy pre-flight:** the GiwaPad policy (1M tokens / 0.001 WETH) passes
  `assertAmmoraV4Config` and all three graduation invariants; all 12 readiness
  checks pass. Derived economics: totalSupply 1,010,204,081,632,818 raw,
  migrationBase 10,204,081,632,818 raw, migrationQuote 0.001 WETH, surplus 0,
  locked 0. (Cross-check: Config #15 on-chain is the same policy family at 1000×
  smaller scale.)
- **In-app smoke test** (compiled `src/ammora.ts` + `src/policy.ts`, live RPC,
  21 Nov 2026, head 41,937,105, ~6.5 min wall time due to RPC slowness):
  **ALL PASS** — fresh block read; `verifyAmmoraV4CoreAtBlock` core-pin
  verification OK; template #12 hash match + enabled; derived GiwaPad policy
  **qualified, all 12 readiness checks PASS** (threshold-base 10,204,081,632,818
  raw; totalSupply 1,010,204,081,632,818 ≥ sale + migrationBase + locked);
  FeeVault read live from Factory: `0x414Be4a093fDFd7292dCa95C4D6fdD3905Ee6800`;
  KILN curve (Config #6, read-only) state matches the safety page exactly
  (status 2 ReadyToMigrate, baseReserve 2 raw, quoteReserve 0.050000000000000001
  WETH, progress 10000 bps); `tokenForCurve`/`curveForToken` round-trip OK.

## Known limitations / risks

- **RPC is severely degraded at times.** Observed 21 Nov 2026: `eth_chainId` took
  31s on the primary RPC; the Pocket backup was unresponsive for 120s+. Single
  SDK reads took 5–45s all day. The app paces reads (≥600ms apart), uses 90s
  timeouts, and disables viem's retry stacking (which turned one slow read into
  8+ minutes). Even so, **every flow can take minutes when the RPC is degraded** —
  the UI says so, but testers should expect it and never resend.
- **No write path has been executed.** Config creation, launch, trade, migrate and
  claims are implemented per the official examples but untested against a live
  wallet. The tester phase must run them in order with a funded test wallet.
- **Receipt waits use 13 confirmations** (per the Ammora examples for GIWA).
  With ~1s blocks this is fast in principle, but a lagging RPC can stretch it;
  `waitForTransactionReceipt` times out at 5 minutes and surfaces an error (the
  transaction itself may still confirm — reconcile by hash, never resend).
- **No post-graduation ARL trading.** After migration the app links to the
  canonical pool but does not offer swaps on it (`AmmoraSwapClient` / concentrated
  pool trading is a separate surface). Out of scope for v1.
- **No vesting, DFS/team splits, or multi-recipient flows.** The GiwaPad policy
  assigns all roles (owner/partner/LP/leftover) to the launching wallet.
- **localStorage only.** Tokens/Config/activity live in the browser; clearing
  storage loses the list (tokens can be re-imported by address lookup).
- **One operation at a time.** A global busy guard serializes on-chain operations
  to protect the rate-limited RPC.
- **No price chart / USD values.** All amounts are raw on-chain values; there is
  no price feed for testnet tokens (and none is needed).

## Tester notes

See the final handoff report for the full checklist. In short: run
`cd app && npm install && npm run dev`, fund a fresh test wallet from
https://faucet.giwa.io, then test in order: connect → preview Config → create
Config → launch → wrap → buy → sell → buy to threshold → migrate → claims.
Do NOT use any real wallet or any of Rayan's wallets.
