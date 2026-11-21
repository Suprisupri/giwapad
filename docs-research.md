# Ammora Launchpad — Docs Research Notes

Researched 2026-11-21 (WIB) from the official Ammora docs site
(https://ammora-docs.vercel.app / https://docs.ammora.org) and the public
npm/SDK references it links. Read-only research; no wallets created, nothing
deployed, no funds spent.

**Docs pages read in full:**
- Home / SDK intro — https://ammora-docs.vercel.app
- Build a launchpad with SDK 0.3.9 — https://ammora-docs.vercel.app/guides/launchpad
- Build an agent that launches and trades tokens — https://ammora-docs.vercel.app/guides/agent-launchpad
- SDK quickstart — https://ammora-docs.vercel.app/guides/sdk-quickstart
- Partner quickstart — https://ammora-docs.vercel.app/guides/partner-quickstart
- Start a contract agent with SDK 0.3.9 — https://ammora-docs.vercel.app/guides/agent-quickstart
- From recipients to fee claims — https://ammora-docs.vercel.app/guides/fee-sharing
- SDK 0.3.9: public APIs and live deployment status — https://ammora-docs.vercel.app/guides/sdk-status
- Run the examples locally — https://ammora-docs.vercel.app/guides/example-setup
- Partner permissions and review boundaries — https://ammora-docs.vercel.app/guides/permissions
- Graduation readiness and the Config #6 incident — https://docs.ammora.org/ai/launchpad-graduation-safety.md

**Pages that could NOT be verified:** the npmjs.com page for
`@ammora-protocol/sdk` returned HTTP 403 to the fetcher, so package
metadata (exact `exports` map, peer deps, file list) could NOT be confirmed
from npmjs directly. Version/dependency facts below come from the Ammora
docs themselves instead. The official GIWA docs site (docs.giwa.io) was not
opened directly; faucet amounts below are corroborated by multiple
third-party guides citing GIWA docs (see §7).

---

## 1. SDK install, versions, Node, browser compatibility

| Item | Value (per docs) |
| --- | --- |
| SDK package | `@ammora-protocol/sdk@0.3.9` — "0.3.9 is npm latest" (SDK status page, reviewed 2026-11-04) |
| Math package | `@ammora-protocol/math` **0.3.0** — "The SDK declares its Math dependency" (SDK quickstart §1); do not install separately |
| Install command (own app) | `npm install --save-exact @ammora-protocol/sdk@0.3.9 viem` (SDK quickstart) / with dotenv: `npm install --save-exact @ammora-protocol/sdk@0.3.9 viem dotenv` (launchpad guide §2) |
| Node version | **Node 24** (SDK quickstart; agent guides pin **Node 24.18.0** via `.nvmrc`); launchpad guide says "Use Node 22 or 24" |
| Package shape | "All 74 package files, SDK runtime/declarations, Math and the **four entrypoints** matched the qualified public artifact" (SDK status page). Entrypoints seen in docs: root (`@ammora-protocol/sdk`) and `/partner` subpath |
| Peer / co-deps | `viem` is co-installed in every install command in the docs; `dotenv` only for the CLI examples. No other peer dep is named in the docs. (npmjs 403 — peer-dep list not independently confirmed.) |

### Browser (Vite/webpack) vs Node-only

**The core SDK is usable in a browser; the example/agent code is not.**

- SDK quickstart §4 ("Move from CLI code to your application"): *"Reuse the
  public SDK builders, clients and receipt parsers shown in the source. In a
  browser app, sign through the connected user's WalletClient. Keep CLI
  `dotenv`, filesystem access and private-key loaders out of browser
  bundles."*
- Launchpad guide §11: *"Reuse public SDK calls without bundling `src/shared`
  environment/signer helpers into the browser."*
- The SDK itself only **plans** transactions: it *"does not sign or send; it
  returns `APPROVAL_REQUIRED` or `READY` plans"* (launchpad §4-A). The wallet
  is *"the only component allowed to sign and submit"* (docs home).
- **Browser-incompatible parts (Node-only, do NOT bundle):**
  - The agent example: uses `node:sqlite` for the local durable execution
    journal (agent-launchpad §1: "Use the public downloaded project and Node
    24.18.0 (`node:sqlite` is used for the local durable execution journal)").
    Agent quickstart §3: *"These examples use Node filesystem/SQLite and
    belong in your agent backend, not in a browser bundle."* Example-setup:
    *"The agent backend uses Node 24 filesystem/SQLite and is not a browser
    bundle."*
  - CLI helpers: `dotenv`, `AMMORA_PRIVATE_KEY` loaders, `src/shared`
    environment/signer helpers, `runtime-pins.giwa.json` file reads (see §4 —
    the pins data itself can be bundled as JSON, but the file-reading helpers
    are Node code).
  - The 203 `npm run …` example commands are a Node/TSX CLI project, not a
    browser library.

---

## 2. Clients and key methods

### ⚠️ Name check: `AmmoraRouteClient` was NOT found in any docs page read

The task brief suggested `AmmoraRouteClient.create({chainId: 91342})`. That
identifier does not appear in the docs home, SDK quickstart, launchpad guide,
agent guides, fee-sharing guide, or SDK status page. **Do not use it.** The
documented entry points are below.

### Deployment catalog (source of addresses — use this, not hardcoded values)

```js
import {
  giwaSepoliaAutoRouteDeployment,   // the default path: auto-route V4
  giwaSepoliaTokenLockDeployment,
} from '@ammora-protocol/sdk';

const deployment = giwaSepoliaAutoRouteDeployment;
deployment.chain.id;                              // 91342
deployment.contracts.launch.protocolVersion;      // 4
deployment.contracts.launch.configRegistry;       // Registry address
deployment.contracts.launch.factory;              // LaunchFactory address
```

(SDK quickstart §2.) The legacy generation uses the SDK's
`giwaSepoliaPermissionless` catalog. **Do not mix** legacy and auto-route
Registry / Config IDs / Factory / Manager. `getAmmoraDeployment(91342)` alone
"selects a historical V3 default in SDK 0.3.0/0.3.1" — preserve the explicit
catalog/source instead (src-launch README, via search).

Other documented root exports (docs home):

```js
import {
  ALCClient, ALMMClient, ARLClient, AFSClient,
  attestAmmoraDeployment,
  createAmmoraDeploymentSourceFromReleaseManifests,
} from "@ammora-protocol/sdk";
```

### Method map (launchpad guide §11 "SDK boundaries and executable sources")

| Step | SDK boundary | Notes |
| --- | --- | --- |
| Config authoring | `buildCreateAmmoraV4Config`, `getAmmoraV4ConfigAtBlock`, receipt parser | Example sources: `team/config.ts`, `policy.ts` |
| Recipients / split / distribution preview | Example helper combining Config builder + SDK fee math | `fee-config.ts`, `fee-policy.ts`, `config-json.ts` |
| New token + ALC | `buildCreateAmmoraV4Launch`, `parseAmmoraV4LaunchCreatedReceipt` | `create-launch.ts` |
| ALC state / quote | `AmmoraV4LaunchCurveClient.getStateAtBlock` / `quoteExactInputAtBlock` | `quote-curve.ts` |
| Trades / approvals / receipts | `AmmoraSwapClient`, `PreparedExactInputSwap`, confirmed-block V4 plan | `safe-swap.ts` |
| Terminal fill / migration | `classifyAmmoraV4ExactInputFill`, `planMigrateAtBlock`, `parseAmmoraV4MigratedReceipt` | `final-fill-and-graduate.ts` |
| LP identification | `resolveAmmoraV4ConcentratedMigrationPositionsReceipt` | `migration-positions.ts` |
| Creator/Partner claim | `feeVaultAbi` `claimFor` + own-entitlement planner | `claim-fees.ts`, `fee-claim-plan.ts` |
| LP fee claim | `DammV2Client.planClaimManagedConcentratedFees` | `claim-position-fee.ts` |
| Fee-only delegation | `DammV2Client.planUpdateDelegatePermission` | `fee-delegate.ts` |
| Multi-recipient vault create/state | `DFSFactoryClient.planCreateVault`, `DFSClient.getState` | `create-json.ts`, `state.ts` |
| Multi-recipient funding/claims | `DFSClient.planCappedDirectFundingWithApproval`, `getClaimPreview`, `planClaim` | `fund.ts`, `claim.ts` |
| Atomic Config+token+first buy | `createConfigAndPoolWithFirstBuy(client, { ...parameters, blockNumber })` | SDK 0.3.9 convenience fn; returns `APPROVAL_REQUIRED` or `READY` plans; does not sign/send |
| Atomic existing-Config first buy | `planExistingConfigAtomicFirstBuy` (explicit-manifest `planAtomicFirstBuy` also supported) | `portable:existing-config-first-buy` |
| Quote classification | `classifyAmmoraV4ExactInputFill` → `full` / `graduation-boundary` / partial sell / dust / RPC failure | `full` = ordinary trade; `graduation-boundary` = final-buy boundary |
| FeeVault read | `feeVaultAbi`, `claimable(feeToken, beneficiary)` via viem `publicClient.readContract` | Read quote + base token separately at one block (launchpad §8) |
| Vesting (0.3.9) | `planAmmoraLaunchVesting`, `buildPortableAmmoraV4Config`, `planLockManagedConcentratedVesting` | Vesting guide / launchpad §9, §12 |

### Agent-layer convenience functions (Node backend only — `src/agent/index.js`)

`connectAgent`, `toolDefinitions`, `createLaunchpadConfig`, `createToken`,
`createTokenAndFirstBuy`, `createConfigAndFirstBuy`, `buy`, `sell`,
`finalFill`, `graduate`, `claimLaunchFees`, `claimLpFees`,
`executeReviewedStep`, `runLaunchpadWalkthrough`, plus 12 tools
(`agent_get_context`, `agent_get_config`, `agent_get_balances`,
`agent_quote_trade`, `agent_prepare`, `agent_prepare_approval`,
`agent_refresh`, `agent_get_claimable`, `agent_submit`,
`agent_reconcile`, `agent:tools`, …). These wrap the SDK with a policy +
SQLite journal; **not for a browser bundle**.

### Exact signatures as shown in the docs

```ts
// Atomic create (launchpad §4-A)
createConfigAndPoolWithFirstBuy(client, { ...parameters, blockNumber })

// FeeVault claim (launchpad §8) — contract call
claimFor(feeToken, connectedAccount, payout)

// FeeVault read (launchpad §8)
publicClient.readContract({
  address: feeVault, abi: feeVaultAbi, functionName: "claimable",
  args: [feeToken, beneficiary], blockNumber: feeBlock,
})

// Agent signer interface (agent-launchpad §6)
interface AgentSigner { address: string; signTransaction(request): Promise<...> }

// Agent connect (agent-launchpad §3)
connectAgent(policy, ".agent-state/my-launchpad")            // keyless, reads only
connectAgent(policy, directory, signer)                      // with signer
```

No fuller TypeScript signatures (parameter-by-parameter) are printed in the
prose docs; exact types live in the SDK's published `.d.ts` files and the
example sources. The docs repeatedly instruct: *"Use real SDK exports and
parameter types. Do not invent methods, addresses, recipients or token
decimals."* (SDK quickstart §5.)

---

## 3. Contract addresses on GIWA Sepolia (91342)

| Contract | Address | Source / confidence |
| --- | --- | --- |
| Config Registry (V4, shared by legacy + auto-route) | `0x6d043014972b87406C4757a5f2d655A24e0b0aF9` | **Official Ammora docs** — stated on every guide page (graduation notice, team-recipients.json, safety page). Confirmed. |
| Launch Factory (auto-route V4) | `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA` | Third-party ScoutPad site ("from the SDK catalog") via search snippet — **UNVERIFIED against official docs; must be re-checked against `giwaSepoliaAutoRouteDeployment.contracts.launch.factory` after `npm install`** |
| Graduation adapter | `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263` | Same ScoutPad source — **unverified, same caveat** |
| Fee policy | `0x17B44C14F640fD429740FA3220f47a567c62725C` | Same ScoutPad source — **unverified, same caveat** |
| WETH (OP Stack predeploy) | `0x4200000000000000000000000000000000000006` | Agent-launchpad §3 (`agent_get_balances` example uses it as the WETH token). Standard OP Stack WETH predeploy. |
| Affected KILN curve (Config #6, DO NOT USE) | `0x5DBf2731BF5F62Db48fF01f71c1cec87A6D49384` | Official safety page (linked explorer URL) |
| Deployment slot | `v4-auto-route-20260917` | ScoutPad (third-party) — unverified |

**Router / FeeVault / ARL Manager addresses:** the prose docs do NOT print
these. They are per-launch/per-pool values read from the SDK catalog and from
receipts at runtime (FeeVault comes from `launch:fee-sharing` output; the
canonical pool + Manager NFT IDs come from the migration receipt via
`launch:migration-positions`). The docs warn: *"The SDK does not ship guessed
production addresses"* (SDK status page). **The builder must read addresses
from the installed SDK catalog + on-chain reads, never hardcode them from
this file except the Registry above.**

### Runtime pins file

- `runtime-pins.giwa.json` — *"Standalone `src/quickstart` verify/create/swap
  files need adjacent `runtime-pins.giwa.json`"* (launchpad §2). Standalone
  creation/trading files *"read the adjacent reviewed `runtime-pins.giwa.json`
  (or `AMMORA_RUNTIME_PINS_FILE`) and verify actual bytecode against it"*
  (src-launch README).
- **Where to get it:** it ships inside the examples project downloaded via
  `https://docs.ammora.org/examples/setup.mjs` (or the GitHub repo
  `AmmoraLabs/ammora-examples`); it is a project-local file, not a separate
  download URL.
- SDK 0.3.9 *"includes GIWA helper/runtime pins"* and *"Helper and 11 runtime
  pins included"* for the atomic first-buy path (launchpad §4-A) — so the
  public SDK catalog already embeds the pins for the default path; the JSON
  file is needed mainly by the standalone example scripts.

---

## 4. Config creation — parameters, minimal Config

### Recipient-only path (`launch:team-config` + `team-recipients.json`)

```json
{
  "schemaVersion": 1,
  "chainId": 91342,
  "registry": "0x6d043014972b87406C4757a5f2d655A24e0b0aF9",
  "templateId": "REPLACE_WITH_QUALIFIED_TEMPLATE_ID",
  "templateHash": "REPLACE_WITH_QUALIFIED_TEMPLATE_HASH",
  "configOwner": "REPLACE_WITH_CONFIG_OWNER",
  "partnerRecipient": "REPLACE_WITH_PARTNER_FEE_WALLET",
  "liquidityPartner": "REPLACE_WITH_PARTNER_LP_WALLET",
  "leftoverReceiver": "REPLACE_WITH_LEFTOVER_WALLET"
}
```

Plus two raw-integer CLI args: `saleSupplyRaw` (base-token sale supply) and
`thresholdRaw` (quote-token graduation threshold). Example: with base decimals
9, 1,000,000 tokens = `1000000000000000` raw; with 18-decimal WETH, 0.001 WETH
= `1000000000000000` raw.

| Field | Required? | Meaning |
| --- | --- | --- |
| `schemaVersion` | Yes | `1` |
| `chainId` | Yes | `91342` |
| `registry` | Yes | `0x6d04…0aF9` (see §3) |
| `templateId` / `templateHash` | Yes | An **explicitly qualified** concentrated template; Registry, ID and hash must agree. **NOT Config #6** (see §5) |
| `configOwner` | Yes | Wallet that creates the Config; **the direct caller must equal Config owner** |
| `partnerRecipient` | Yes | Partner's trading-fee recipient before graduation |
| `liquidityPartner` | Yes | Partner's LP recipient after graduation |
| `leftoverReceiver` | Yes | Recipient for leftover base tokens |
| `saleSupplyRaw` | Yes | Raw base-token sale supply (NOT total issuance) |
| `thresholdRaw` | Yes | Raw quote-token graduation threshold |
| `creatorShareOfNonProtocolBps` | Only via `launch:fee-config` path | Creator's share of fees **after the Protocol share**, integer 0–10000; remainder to Partner. Example `7000` = 70% of the non-Protocol share. The recipient-only path inherits the template's Creator ratio. Cannot change the fixed Protocol share. |

### Inherited from the template (not set in the recipient JSON)

Fees, Creator share (recipient-only path), curve segments, LP ratios, locks,
vesting, migration mode (`migrationMode: 0` = concentrated; `1` =
compounding), quote asset/decimals, `poolCreationFee`. To redesign economics,
use `launch:author-config` → full Config JSON → `launch:config-json`
(launchpad §11/§12). "Large JSON integers are **decimal strings**, small ABI
integers are numbers, and booleans are booleans. Unknown fields, rounded
integers and overflow are rejected."

### Safe minimal Config (per docs)

The docs' own default: **one reusable Config, concentrated graduation,
template-based via `launch:team-config`** (launchpad §"How to follow this
guide"). Minimal = recipient JSON above (all four real addresses) + reviewed
`saleSupplyRaw` + `thresholdRaw`, derived from a **graduation-qualified
concentrated template**. Full economic-policy editing, Compounding and time
locks are explicitly optional (step 12).

---

## 5. ⚠️ GRADUATION READINESS WARNING (verbatim in substance)

From the notice banner on every guide page and the safety page
(https://docs.ammora.org/ai/launchpad-graduation-safety.md):

> **Graduation readiness notice: do not use the affected chain 91342 /
> Registry 0x6d043014972b87406C4757a5f2d655A24e0b0aF9 / Config 6 / hash
> 0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667 for new
> launches, even if enabled. This policy can sell all base inventory and fail
> migration. Replace pinned-example defaults with an explicitly qualified
> policy and verify derived graduation reserves, including
> migrationBaseThreshold = 0. Config #10 is a test observation, not an
> automatic replacement.**

### What happened (safety page)

At canonical block 41665456 the affected policy could sell all 1,000,000,000
base tokens but required another 333,333,333.342095747 tokens for its
concentrated graduation pool. The reported KILN curve had only **2 raw base
units** left (9 decimals), 0.050000000000000001 WETH, status **2**
(ReadyToMigrate), and no canonical pool. A read-only migrate call reverted
with `MigrationNotReady`. Its 0.05 WETH target had been reached; the missing
graduation inventory was the failure.

Root cause: *"The Registry supply check adds migrationBaseThreshold; zero
means zero in that check, while migrate derives a nonzero destination base
requirement in zero-threshold mode. The existing quote/equality checks do not
close that remaining-base gap."* So: **an enabled Config, successful
registration or creation, SDK structural validation, or ReadyToMigrate alone
does NOT qualify graduation.**

### What "explicitly qualified policy" means (per the safety page)

1. Select an **operator-published, graduation-qualified policy** and review
   its plain-language summary; the app checks readiness **before** requesting
   a creation signature.
2. Read **one canonical chain/factory/registry snapshot** and bind the actual
   Config ID/hash, quote identity/decimals, supply, curve segments, fees,
   vesting and supported destination.
3. **Reject the affected identity** (chain 91342 / Registry 0x6d04…0aF9 /
   Config 6 / hash 0x6048…e667) in the generated app's server/planner **and**
   live Create path, not only its picker. Revalidate saved drafts and
   imported Config IDs.
4. Compute destination amounts using the actual supported Concentrated or
   Compounding math, migration price/range and liquidity, including rounding.
   *"Do not invent an SDK readiness method; use verified installed exports or
   a reviewed application adapter with recorded source/math evidence."*
5. Publish a policy as ready **only after its budget reconciliation and
   applicable last-fill/migration validation**. Record source, target, policy
   identity, block/evidence and unexecuted live checks in
   `docs/graduation-policy-coverage.json`.
6. Test: affected-Config rejection, zero-threshold missing-base rejection, a
   valid reserved-base case, both offered destinations, and
   just-below/at/above-target behavior.

### How to verify graduation reserves (required invariants, exact raw integers)

```text
totalSupply >= worstCaseCurveBaseSold + grossMigrationBaseRequired + lockedBaseTotal
quoteReserveAfterSurplusAndMigrationFees >= grossMigrationQuoteRequired
at migration: baseReserve >= grossMigrationBaseRequired + lockedBaseTotal
```

- **For `migrationBaseThreshold = 0`, `grossMigrationBaseRequired` is the
  derived destination amount, never zero.** For a nonzero threshold, reconcile
  it to that same amount.
- Include maximum/partial/final fills, multiple-fill rounding, quote
  fees/surplus, locked allocations and the actual stopping condition.
- Verify **both internal reserves and real ERC-20 balances**. Do not count
  sold tokens, a donation, a market-cap estimate or future deposits as
  reserved graduation inventory.
- A threshold-only change to 6.5 WETH cannot repair inconsistent
  supply/curve/liquidity budgets.
- Config #10 has a successful historical testnet graduation example but is
  **not** an automatic replacement, a universally approved policy, or the
  recommended 6.5 WETH profile. **No qualified template ID is published in
  the docs pages read** — the builder team must qualify a template (or
  author/register a fully reconciled new policy) itself.

### Existing affected curves

No ordinary recovery path: *"Do not rewrite their thresholds, relabel them
as graduated, promise refunds, or tell holders to send additional tokens/ETH
to repair them… a plain token transfer does not update baseReserve, and
withdrawLeftover requires completed migration."* Keep the affected token page
readable, explain trading/migration is unavailable, provide curve/Config
identity + tx hashes + error for operator support.

---

## 6. Launchpad lifecycle (in order)

```
Config creation (owner signs) → token issuance + ALC curve (Creator signs)
  → buy/sell on ALC (trader signs) → final buy → ReadyToMigrate
  → migration, separate tx (any gas-paying caller) → ARL pool + LP NFTs
  → trade on ARL (trader signs) → claim Creator/Partner FeeVault fees
  → claim LP NFT fees (owner or fee delegate)
```

| Step | SDK / contract call | Wallet signature? |
| --- | --- | --- |
| 1. Connection / deployment verification | `quickstart:verify`, `launch:get-config` (reads) | **No** — reads only |
| 2. Create Config | `buildCreateAmmoraV4Config` → Registry `createConfig`-equivalent (via `launch:team-config` / `launch:config-json`) | **Yes** — Config owner; direct caller must equal owner |
| 3. Issue token + ALC | `buildCreateAmmoraV4Launch` → LaunchFactory `createLaunch(configId, name, symbol, metadataURI)` | **Yes** — Creator; pays issuance gas + Config `poolCreationFee` in native ETH |
| 3-A. Atomic Config+token+first buy | `createConfigAndPoolWithFirstBuy` / `planExistingConfigAtomicFirstBuy` | **Yes** — owner=Creator=buyer (new Config) or Creator=buyer (existing Config); ERC-20 approvals are separate prior txs |
| 4. Quote (buy/sell) | `AmmoraV4LaunchCurveClient.getStateAtBlock` / `quoteExactInputAtBlock` | **No** — read-only |
| 5. Buy / sell on ALC | `AmmoraSwapClient` (`PreparedExactInputSwap`); ERC-20 approval first if needed | **Yes** — trader; buy uses quote (WETH) input, sell uses base input |
| 6a. Final buy (graduation boundary) | `classifyAmmoraV4ExactInputFill` + `launch:graduate` | **Yes** — takes only consumed input; unused input stays in wallet (no refund tx) |
| 6b. Migration | `planMigrateAtBlock` → `launch:migrate` | **Yes** — any execution wallet with gas; separate tx from final buy. Status 3 returns existing `canonicalPool` |
| 7. Post-graduation trades | `quickstart:swap` (`concentrated`) on POOL, not CURVE | **Yes** — trader |
| 8. Creator/Partner fee claims | `feeVaultAbi.claimFor(feeToken, beneficiary, payout)` | **Yes** — each beneficiary signs their own claim; quote and base claimed separately |
| 9. LP fee claims | `DammV2Client.planClaimManagedConcentratedFees` | **Yes** — Manager NFT owner or authorized fee delegate |
| 9-A. (Optional) Team split | `DFSFactoryClient.planCreateVault` → `DFSClient.planCappedDirectFundingWithApproval` → `DFSClient.planClaim` | **Yes** — vault creator → funder → each recipient (own index) |

**Curve statuses:** `0` Uninitialized · `1` Active · `2` ReadyToMigrate ·
`3` Migrated.

**Key lifecycle rules from the docs:**
- Do NOT use `createProductionPool` for the graduated pool — it creates only
  an ARL AMM for existing tokens, without issuance/ALC/graduation. Migration
  creates the canonical pool.
- `launch:quick-create` combines Config + token creation but does NOT include
  the first buy.
- Never resend a successful final buy or creation because of RPC lag; GIWA
  confirmation-depth snapshots can lag a newly created Config.
- Submission is not completion: reconcile receipt, canonical block, transfers
  and claim events. "An Ammora HTTP feed is not required."
- `AMMORA_SEND=0` never sends; some commands are send-only and reject at the
  send gate rather than previewing.

---

## 7. GIWA Sepolia essentials

| Item | Value | Source |
| --- | --- | --- |
| Chain ID | **91342** | Ammora docs (every page) |
| Network name | GIWA Sepolia | GIWA docs (via third-party guides) |
| Public RPC | **https://sepolia-rpc.giwa.io** | Ammora stablecoin quickstart (`AMMORA_RPC_URL=https://sepolia-rpc.giwa.io`) + GIWA docs |
| Flashblocks RPC | https://sepolia-rpc-flashblocks.giwa.io | GIWA docs (via third-party guides) |
| Block explorer | **https://sepolia-explorer.giwa.io** (Blockscout) | Ammora safety page links + GIWA docs |
| Official faucet | **https://faucet.giwa.io** — **0.005 ETH per claim, once per 24h** (per address + IP fingerprint) | GIWA docs as cited by multiple third-party guides (BlockVar, Boxmining, TokenTopNews with on-chain receipt evidence). Ammora docs do not name a faucet URL. |
| Backup faucet (Nodit) | https://faucet.lambda256.io/giwa-sepolia — 0.01 ETH / 24h, email signup | Third-party guides |
| Bridge | https://sepolia-bridge.giwa.io (Ethereum Sepolia ↔ GIWA Sepolia) | GIWA docs (via third-party guides) |
| Playground | https://sepolia-playground.giwa.io | GIWA docs (via third-party guides) |
| Currency | ETH (native gas token; GIWA has no own token) | GIWA docs |
| Block time | ~1 second (OP Stack L2) | Third-party guides |
| Gas price | < 0.1 gwei typical | Third-party guides |

**Testnet quirks / warnings:**
- Public RPC is **rate-limited, not for production** (GIWA docs, per BlockVar)
  and "rate-limited and unreliable for sending transactions" (xpad.fun,
  third-party). Ammora examples set `AMMORA_RPC_INTERVAL_MS=600` (600 ms
  between RPC calls) and use one shared RPC transport.
- Alternative free RPC (third-party, not official): `https://giwa-sepolia-testnet.api.pocket.network`
  (Pocket Network, no key required, per xpad.fun).
- **Old RPC URL `https://sepolia.giwa.io/rpc`** appears in the Sept 2025 launch
  announcement — superseded by `sepolia-rpc.giwa.io`; do not use the old one.
- GIWA confirmation-depth snapshots can lag newly created Configs (launchpad
  §3-3) — use receipt-block reads (`AMMORA_READ_RECEIPT`) rather than resending.
- Canonical receipts are labeled canonical at ≥13 confirmations in the agent
  example (not guaranteed finality).
- GIWA testnet terms (Dunamu) forbid automated faucet claims / faucet farming
  and selling test tokens.
- GIWA mainnet is still in development (no date); only GIWA Sepolia is live.
- GIWA's own wallet is "Coming Soon" — use MetaMask/Rabby etc.

---

## 8. Wallet requirements (browser)

- **viem `WalletClient` + `PublicClient`** is the documented browser signing
  model: *"In a browser app, sign through the connected user's WalletClient"*
  (SDK quickstart §4). The allowance-cleanup example uses
  `publicClient.readContract` + `walletClient.writeContract` with
  `account`, `chain` (chain id checked `!== 91342` → throw) (launchpad §6).
- The SDK never holds keys: *"Frontends sign through the connected user's
  WalletClient, not CLI private-key helpers"* (launchpad §2). *"Keep CLI keys
  in your private local environment, never in source, commits, or frontend
  code"* (partner quickstart §3).
- No MetaMask/Rabby-specific connect code appears in the Ammora docs; any
  EIP-1193 wallet works via viem. Third-party ScoutPad: "Connect any EVM
  wallet… The chain is added automatically on connect (chain id 91342, RPC
  sepolia-rpc.giwa.io)."
- CLI equivalent: `AMMORA_ACCOUNT` = public caller address (does not change
  the signer); `AMMORA_PRIVATE_KEY` only in private local CLI config.
- Agent backend: `AgentSigner` = `{ address, signTransaction(request) }`
  supplied by the trusted host's own wallet backend / isolated signing
  service; signing and broadcasting must be separable.
- Roles: each role (Config owner, Creator, trader, LP owner, fee claimant)
  signs with its own wallet; one role does not grant another's rights. Each
  sender needs its own gas ETH; WETH (trading) and native ETH (gas) are
  separate balances. Wrapping: `launch:funding` previews WETH `deposit()`;
  wrap only the required amount.

---

## 9. Official example repo / starter

| Resource | URL | Contents |
| --- | --- | --- |
| Examples repo (public, anonymous clone, no invitation) | https://github.com/AmmoraLabs/ammora-examples.git | Full Node/TSX project: 203 npm commands, `src/quickstart`, `src/launch`, `src/arl`, `src/agent`, `src/dfs`, `src/vesting`, `src/stablecoin`, shared helpers, templates, `runtime-pins.giwa.json`, optional ALMM unified extension; pins SDK 0.3.9 via committed lockfile |
| Docs source download (no GitHub needed) | `curl -fL https://docs.ammora.org/examples/setup.mjs` then `node ammora-examples-setup.mjs ./ammora-examples` | Same source project; setup script verifies every file's SHA-256 against the public manifest, refuses existing dirs, never installs deps or runs code. `PROVENANCE.json` records the revision. |
| Example browser | https://docs.ammora.org/examples | Browse/copy every example file + "Copy example Markdown" (entry code, run command, guide links, supporting-file URLs) |
| AI brief | https://docs.ammora.org/ai/sdk-quickstart.md and https://docs.ammora.org/llms.txt | Machine-readable quickstart + docs index |
| Docs home | https://ammora-docs.vercel.app (canonical: https://docs.ammora.org) | All guides above |

**No official browser/Vite starter exists** — the examples are a Node CLI
project. The closest browser precedent is the third-party ScoutPad explorer
(https://cryptoid-id.github.io/scoutpad/ — read-only, GitHub Pages, built with
the Ammora SDK; it reads Configs from the Registry and connects a wallet for
balance display only, never signs).

---

## 10. Blockers / risks for a static GitHub Pages site

**No hard blocker for the core flow**, but several real constraints:

1. **No official browser starter.** Everything official is a Node/TSX CLI.
   The team must hand-build the browser integration from SDK exports
   (catalog, builders, clients, receipt parsers) + viem `PublicClient` /
   `WalletClient`. The docs bless this pattern explicitly (§1) but provide no
   Vite template.
2. **Agent code is Node-only and must stay out of the bundle.** `node:sqlite`,
   `node:fs`, the policy/journal/session machinery, `dotenv`, private-key
   loaders, and `src/shared` env/signer helpers are all backend-only. A
   static site must NOT import `src/agent/*`.
3. **Graduation qualification has no SDK method.** The docs say *"Do not
   invent an SDK readiness method"* — the team must implement the budget
   reconciliation (invariants in §5) as a reviewed application adapter with
   recorded source/math evidence, or pre-qualify policies off-site and ship a
   pinned allowlist. **No qualified template ID is published in the docs** —
   qualifying one (or authoring a fully reconciled Config) is an open work
   item, not a copy-paste step.
4. **Public RPC rate limits.** `sepolia-rpc.giwa.io` is rate-limited and
   reported unreliable for sends; a static site with many visitors hitting it
   directly (reads + `eth_call` simulations) may get throttled. Mitigations:
   the Pocket endpoint, request pacing (600 ms interval per the examples),
   caching reads, and letting the user's wallet RPC do reads where possible.
   No backend is *required* ("An Ammora HTTP feed is not required"), but a
   thin read cache/proxy may become desirable at scale.
5. **No secrets needed — good for static hosting.** The whole flow needs no
   API keys, no backend, no Ammora account, and no per-team approval. Config
   creation, issuance, trading, graduation and claims are permissionless for
   valid Configs on the supported WETH path (permissions guide §1). The only
   "secret" is the user's own wallet in their browser.
6. **Runtime-pins verification needs the pins data.** The standalone scripts
   verify contract bytecode against `runtime-pins.giwa.json`. For a browser
   build, either bundle the pins JSON (from the examples download) or rely on
   the SDK 0.3.9 catalog's embedded pins (11 pins for the atomic path) plus
   Explorer verification. Do not skip verification silently.
7. **npm metadata gap.** npmjs.com returned 403, so the SDK's exact `exports`
   map / peer deps / browser field could not be confirmed from the registry.
   The builder must check the installed package's `package.json` after
   `npm install` (especially whether any export pulls Node builtins) before
   assuming a clean Vite build.
8. **Amount/unit discipline.** All amounts are raw `bigint` integers; human
   decimals only at display/input boundaries. Never route execution-critical
   values through JS `number`. Slippage in bps; minimum output/share computed
   by the SDK, not recomputed in floats.
9. **Receipt reconciliation is the app's job.** Submission ≠ completion;
   the app must reconcile receipts, canonical blocks, transfers and claim
   events, and must never auto-resend after an uncertain hash. The agent's
   journal/reconcile machinery is Node-only, so the browser app needs its own
   (simpler) persistence — e.g. localStorage for hashes/operation state.
10. **First-buy helper / aggregation policy.** The default WETH path needs no
    partner registration, but a different quote asset must pass the Factory's
    pool **and** aggregation policies; custom callbacks/helpers need shared
    code admission. Stay on the default WETH path for v1.
11. **Config #6 contamination in fixtures.** Pinned example files
    (`team-recipients.json` templates, `fees.example.json`, the agent policy
    fixture) still contain the quarantined #6 identity. Any copied fixture
    must have its template ID/hash replaced with a qualified policy before
    use — including in the static site's default config.

---

## 11. Source index (for the builder team)

- Docs home: https://ammora-docs.vercel.app
- Launchpad guide: https://ammora-docs.vercel.app/guides/launchpad
- Agent guide: https://ammora-docs.vercel.app/guides/agent-launchpad
- Agent quickstart: https://ammora-docs.vercel.app/guides/agent-quickstart
- SDK quickstart: https://ammora-docs.vercel.app/guides/sdk-quickstart
- Partner quickstart: https://ammora-docs.vercel.app/guides/partner-quickstart
- Fee sharing: https://ammora-docs.vercel.app/guides/fee-sharing
- SDK status: https://ammora-docs.vercel.app/guides/sdk-status
- Example setup: https://ammora-docs.vercel.app/guides/example-setup
- Permissions: https://ammora-docs.vercel.app/guides/permissions
- Graduation safety: https://docs.ammora.org/ai/launchpad-graduation-safety.md
- Examples repo: https://github.com/AmmoraLabs/ammora-examples.git
- Setup script: https://docs.ammora.org/examples/setup.mjs
- Example browser: https://docs.ammora.org/examples
- AI brief: https://docs.ammora.org/ai/sdk-quickstart.md · https://docs.ammora.org/llms.txt
- GIWA explorer: https://sepolia-explorer.giwa.io
- GIWA RPC: https://sepolia-rpc.giwa.io
- GIWA faucet: https://faucet.giwa.io
- GIWA docs: https://docs.giwa.io/giwa-chain/en (cited by third-party guides; not opened directly)
- Third-party ScoutPad (read-only reference, NOT official): https://cryptoid-id.github.io/scoutpad/
