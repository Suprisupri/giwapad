# GiwaPad

A static token launchpad on **GIWA Sepolia** (chain 91342, testnet) built with the
[Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) (`@ammora-protocol/sdk@0.3.9`)
and [viem](https://viem.sh). No backend, no API keys, no account — open the page, connect
MetaMask/Rabby, and launch.

Built for the **Ammora Builder mission** (Season 2).

## What it does

1. **GiwaPad Config** — creates one reusable launch Config, derived from a reviewed
   on-chain template (Config #12, fallback #13) with a fully reconciled graduation
   budget: 1,000,000 tokens sale supply, 0.001 WETH graduation threshold, concentrated
   migration. A 12-point graduation readiness check must pass before any signature is
   requested.
2. **Launch a token** — issues a token on the GiwaPad Config with its own Ammora
   bonding curve (ALC). Pool creation fee is 0; you pay gas only.
3. **Trade** — live SDK quotes (buy with WETH / sell token), curve state, and a
   graduation progress bar. Buys that reach the graduation boundary are detected and
   handled as final fills (unused input stays in your wallet).
4. **Graduate** — when a curve is ReadyToMigrate, anyone can run the permissionless
   migration to the canonical ARL pool; LP (Manager NFT) positions are resolved from
   the migration receipt and stored.
5. **Claims** — Creator/Partner FeeVault claims (WETH + base token) and LP fee claims
   for owned migration positions, plus creator surplus / leftover actions.
6. **Token list + lookup** — tokens launched through GiwaPad persist in localStorage;
   any Ammora V4 token/curve can be looked up by address (the curve is authenticated
   against the reviewed factory + fee policy before it is displayed).

Every on-chain action shows pending/success/error states with a transaction hash and
explorer link. Every number comes from the SDK/RPC — nothing is mocked.

## Run it

```bash
cd app
npm install
npm run dev      # local dev server
npm run build    # static output in app/dist — copy to /docs for GitHub Pages
npm run preview  # serve the production build locally
```

Live site: https://suprisupri.github.io/giwapad/ (after deploy)

## Use it

1. Get test ETH from the [GIWA faucet](https://faucet.giwa.io) (0.005 ETH / 24h).
2. Connect MetaMask/Rabby — GiwaPad prompts to switch to GIWA Sepolia (91342).
3. **Preview policy + readiness check**, then **Create Config** (one-time, reused).
4. **Launch a token** (name + symbol; description/image optional).
5. Wrap some ETH → WETH in the Wallet card, then buy/sell on the curve.
6. Buy through the 0.001 WETH threshold to reach ReadyToMigrate, then **Migrate**.

## Stack

| Item | Value |
| --- | --- |
| SDK | `@ammora-protocol/sdk@0.3.9` (+ `@ammora-protocol/math@0.3.0` as its dep) |
| Wallet/signing | `viem@2.58.4` WalletClient + PublicClient (EIP-1193) |
| Chain | GIWA Sepolia, 91342 |
| RPC | `https://sepolia-rpc.giwa.io` (primary) · Pocket `https://giwa-sepolia-testnet.api.pocket.network` (fallback) |
| Explorer | `https://sepolia-explorer.giwa.io` |
| Tooling | Vite 8 + TypeScript, vanilla (no framework) |

## Contract addresses (from the SDK catalog)

All addresses are read at runtime from `giwaSepoliaAutoRouteDeployment` in the
installed SDK — verified against the catalog during the build (see
[BUILD-NOTES.md](BUILD-NOTES.md)):

| Contract | Address |
| --- | --- |
| Config Registry | `0x6d043014972b87406C4757a5f2d655A24e0b0aF9` |
| Launch Factory | `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA` |
| Graduation adapter | `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263` |
| Fee policy | `0x17B44C14F640fD429740FA3220f47a567c62725C` |
| WETH (OP Stack predeploy) | `0x4200000000000000000000000000000000000006` |
| Concentrated factory | `0x9eBD78f3839996014238728b4c9C2f2A4e6759Cb` |
| Concentrated position manager | `0x089163706d9956d7baeCeDF4eAb4aD6CcE7Ca2D6` |
| First-buy executor | `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451` |

Deployment slot `v4-auto-route-20260917`, protocol version 4. The app also verifies
core contract bytecode against the SDK's runtime pins on load
(`verifyAmmoraV4CoreAtBlock`).

## Graduation qualification note

No graduation-qualified template ID is published in the Ammora docs, so GiwaPad
qualifies its own policy: it derives a Config from template #12 (or #13) using the
official examples' derivation math, then verifies the graduation invariants itself
with a 12-point readiness adapter before any creation signature is requested
(`app/src/policy.ts` → `checkGraduationReadiness`). The derivation was validated
locally: it reproduces Config #12's on-chain segment, totalSupply,
migrationBaseThreshold and post-migration liquidity/range **exactly**.

The quarantined Config #6 identity (chain 91342 / Registry `0x6d04…0aF9` / Config 6 /
hash `0x6048…e667`) is rejected in the Create path and when revalidating any stored
or imported Config. Evidence is recorded in
[`docs/graduation-policy-coverage.json`](docs/graduation-policy-coverage.json).

## Warnings

- **Testnet only.** GIWA Sepolia assets have no value. Never send real funds.
- The public RPC is **slow and rate-limited** (single reads took 5–45s in testing).
  GiwaPad paces reads (≥600ms apart) and shows progress; please be patient and never
  resend a submitted transaction.
- Every write is simulated (`eth_call`) before signing, uses exact (never infinite)
  ERC-20 approvals, and waits for 13 confirmations before reading dependent state.
- Token metadata defaults to an inline `data:application/json;base64,…` URI (no
  IPFS/backend in a static site). You can paste your own `https://`/`ipfs://` URI
  instead. The `data:` URI path is untested against the Factory on-chain — see
  BUILD-NOTES.md.
- GiwaPad never sees private keys or seed phrases. Signing happens only in your
  own wallet.

## Project layout

```
ammora-launchpad/
├── README.md                    # this file
├── BUILD-NOTES.md               # what was built, SDK exports used, deviations, limits
├── docs-research.md             # docs research (method map, addresses, warnings)
├── docs/
│   └── graduation-policy-coverage.json   # graduation qualification evidence
└── app/                         # Vite + TypeScript app (the deployable project)
    ├── package.json             # name: giwapad
    ├── index.html
    ├── vite.config.ts           # base './' — works from repo root, /docs, or a Pages subpath
    └── src/
        ├── main.ts              # UI + all user flows
        ├── ammora.ts            # SDK integration: catalog, clients, sends, reads
        ├── policy.ts            # Config derivation + graduation readiness adapter
        └── store.ts             # localStorage persistence
```
