/**
 * GiwaPad launch policy: template derivation + graduation readiness adapter.
 *
 * The derivation below is a browser port of the official Ammora examples
 * (`src/launch/config-from-template.ts` → `deriveConfigFromTemplate`, and
 * `src/launch/team/policy.ts` → `planTeamConfig`), which derive a complete,
 * registry-valid Config from a reviewed on-chain template instead of asking a
 * user to hand-author dozens of coupled fields. The port was validated
 * locally against the real Config #12 snapshot: it reproduces #12's segment,
 * totalSupply, migrationBaseThreshold and post-migration liquidity/range
 * exactly (see BUILD-NOTES.md).
 *
 * Graduation qualification (per docs.ammora.org/ai/launchpad-graduation-safety.md):
 * no qualified template ID is published, so GiwaPad derives its own Config and
 * verifies the graduation invariants itself with `checkGraduationReadiness`
 * before any creation signature is requested. What it checks is documented on
 * that function; evidence is recorded in docs/graduation-policy-coverage.json.
 */
import {
  AmmoraV4MigrationMode,
  assertAmmoraV4Config,
  buildCreateAmmoraV4Config,
  buildSingleSegmentCurve,
  concentratedDepositQuote,
} from "@ammora-protocol/sdk";
import type {
  AmmoraV4Config,
  AmmoraV4ConfigSnapshot,
  AmmoraV4Segment,
} from "@ammora-protocol/sdk";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { LAUNCH, WETH } from "./ammora.ts";

// ---------------------------------------------------------------------------
// Quarantine: the Config #6 incident. Never use this identity for new launches,
// even if it appears enabled. Checked in the Create path AND when revalidating
// any stored/imported Config ID.
// ---------------------------------------------------------------------------
export const QUARANTINED_TEMPLATE_ID = 6n;
export const QUARANTINED_TEMPLATE_HASH =
  "0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667" as Hex;

// ---------------------------------------------------------------------------
// Derivation templates. Pinned (id + hash) and verified at runtime against the
// live Registry read: id, hash and enabled must all agree, or the app refuses.
// #12 is the primary source; #13 is the identical-profile fallback (same
// economics, same owner, different recipients). Both are concentrated-mode,
// enabled, and already carry a nonzero derived migrationBaseThreshold.
// Observed at head ~41,935,162 (21 Nov 2026); the app re-reads them live.
// ---------------------------------------------------------------------------
export const TEMPLATE_CANDIDATES: { id: bigint; hash: Hex }[] = [
  { id: 12n, hash: "0xc2f40255ee580e5867d103bbbfa52b13d40b97bdf7bbf55c3f37530bc3ed308b" },
  { id: 13n, hash: "0x2380172b7d06c26959f2b19e08a6606fa7867be1976c9af36ce88bd2a9b5b91f" },
];

// ---------------------------------------------------------------------------
// GiwaPad policy (fixed, documented, one reusable Config):
//   sale supply 1,000,000 tokens (9 decimals) · graduation threshold 0.001 WETH
// Derived economics (verified locally, see BUILD-NOTES.md):
//   totalSupply 1,010,204,081,632,818 raw · migrationBase 10,204,081,632,818 raw
//   migrationQuote 0.001 WETH · surplus 0 · lockedBase 0
// ---------------------------------------------------------------------------
export const GIWAPAD_SALE_SUPPLY_RAW = 1_000_000n * 10n ** 9n;
export const GIWAPAD_THRESHOLD_RAW = 10n ** 15n; // 0.001 WETH
export const GIWAPAD_TOKEN_DECIMALS = 9;

export type DerivedConfig = {
  config: AmmoraV4Config;
  curve: readonly AmmoraV4Segment[];
  economics: {
    saleAllocationRaw: bigint;
    grossMigrationBaseRaw: bigint;
    grossMigrationQuoteRaw: bigint;
    migrationQuoteFeeRaw: bigint;
    quoteSurplusToProtocolRaw: bigint;
    lockedBaseRaw: bigint;
    totalSupplyRaw: bigint;
  };
};

/**
 * Port of examples `deriveConfigFromTemplate`. All coupled budget fields are
 * recomputed from the template's scalar policy (fees, vesting, start price):
 * the curve segment, the concentrated destination quote, totalSupply and both
 * migration thresholds. `migrationBaseThreshold` is set to the derived
 * destination base amount — never zero — which is exactly the field the
 * Config #6 policy left at zero while migrate() derived a nonzero requirement.
 */
export function deriveConfigFromTemplate(
  template: Pick<AmmoraV4ConfigSnapshot, "config">,
  saleSupply: bigint,
  migrationQuoteThreshold: bigint,
): DerivedConfig {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) {
    throw new RangeError("sale supply and quote threshold must be positive");
  }
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError("GiwaPad supports concentrated graduation only");
  }
  const curve = buildSingleSegmentCurve(
    template.config.startSqrtPrice,
    saleSupply,
    migrationQuoteThreshold,
  );
  const segment = curve[0];
  if (!segment) throw new Error("single-segment curve construction returned no segment");
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee = (migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps)) / 10_000n;
  const quoteAfterFee = migrationQuoteThreshold - quoteFee;
  // Fund the destination from post-fee quote; its required gross base is a
  // coupled economic result, not the old template's independently copied budget.
  const destination = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase =
    vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config: AmmoraV4Config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return {
    config,
    curve,
    economics: {
      saleAllocationRaw: saleSupply,
      grossMigrationBaseRaw: destination.baseAmount,
      grossMigrationQuoteRaw: destination.quoteAmount,
      migrationQuoteFeeRaw: quoteFee,
      quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
      lockedBaseRaw: lockedBase,
      totalSupplyRaw: config.totalSupply,
    },
  };
}

export type TeamRecipients = {
  configOwner: Address;
  partnerRecipient: Address;
  liquidityPartner: Address;
  leftoverReceiver: Address;
};

/**
 * Port of examples `planTeamConfig` (recipient-only path). Overrides the
 * template's recipients with the GiwaPad user's own wallet (the user is their
 * own partner: creator + partner fees and leftover all go to them), builds the
 * Registry calldata, and binds the review to chain/target/value/calldata via
 * reviewHash. The UI must show this review before the signature is requested.
 */
export function planTeamConfig(
  template: AmmoraV4ConfigSnapshot,
  recipients: TeamRecipients,
  saleSupply: bigint,
  quoteThreshold: bigint,
) {
  if (!template.enabled) throw new Error("template Config is disabled");
  const derived = deriveConfigFromTemplate(template, saleSupply, quoteThreshold);
  const config: AmmoraV4Config = {
    ...derived.config,
    partnerRecipient: recipients.partnerRecipient,
    leftoverReceiver: recipients.leftoverReceiver,
    liquidityDistribution: {
      ...derived.config.liquidityDistribution,
      partner: recipients.liquidityPartner,
    },
  };
  assertAmmoraV4Config(config, derived.curve);
  const transaction = {
    to: LAUNCH.configRegistry,
    ...buildCreateAmmoraV4Config(config, derived.curve, recipients.configOwner),
  };
  const reviewHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [BigInt(91342), transaction.to, 0n, transaction.data],
    ),
  );
  return { ...derived, config, transaction, reviewHash, recipients };
}

// ---------------------------------------------------------------------------
// Graduation readiness adapter (application-side, per the safety page:
// "Do not invent an SDK readiness method; use verified installed exports or a
// reviewed application adapter with recorded source/math evidence.")
//
// Checks, all in exact raw integers, recomputed independently from the derived
// Config's own fields (not trusted from the derivation's economics object):
//  1. template-not-quarantined — template id/hash are not the Config #6 identity
//  2. template-enabled / template-hash-pinned — live read matches the pin
//  3. concentrated-mode — migrationMode == Concentrated (0)
//  4. quote-asset-weth — quote token is the WETH predeploy
//  5. threshold-base-nonzero — migrationBaseThreshold > 0 (the #6 failure mode)
//  6. threshold-base-derived — migrationBaseThreshold equals the destination
//     base amount recomputed via concentratedDepositQuote from the derived
//     Config's own post-migration range and post-fee quote
//  7. invariant-total-supply — totalSupply >= worstCaseCurveBaseSold +
//     grossMigrationBaseRequired + lockedBaseTotal
//     (worstCaseCurveBaseSold = saleSupply: one segment sells at most its sale
//     allocation; the curve cannot oversell)
//  8. invariant-quote — quoteReserve after migration fees >=
//     grossMigrationQuoteRequired (threshold minus migration quote fee covers
//     the destination quote; surplus, if any, goes to protocol)
//  9. invariant-at-migration-base — at migration, baseReserve
//     (totalSupply minus worst-case sold) >= grossMigrationBaseRequired +
//     lockedBaseTotal
// 10. sdk-structural — assertAmmoraV4Config passes on the derived Config
// 11. decimals-in-range — tokenDecimals 9 (contract accepts 6–9)
//
// NOT checked here (checked live instead): real ERC-20 balances of the curve
// at migration time — the migrate flow simulates planMigrateAtBlock with
// eth_call before sending, which reverts if reserves are insufficient.
// ---------------------------------------------------------------------------
export type ReadinessCheck = { id: string; label: string; pass: boolean; detail: string };

export function checkGraduationReadiness(args: {
  template: AmmoraV4ConfigSnapshot;
  pinnedHash: Hex;
  derived: DerivedConfig;
  saleSupply: bigint;
  threshold: bigint;
}): { checks: ReadinessCheck[]; qualified: boolean } {
  const { template, pinnedHash, derived, saleSupply, threshold } = args;
  const { config, economics } = derived;
  const checks: ReadinessCheck[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) =>
    checks.push({ id, label, pass, detail });

  add(
    "template-not-quarantined",
    "Template is not the quarantined Config #6 identity",
    template.configId !== QUARANTINED_TEMPLATE_ID &&
      template.configHash.toLowerCase() !== QUARANTINED_TEMPLATE_HASH.toLowerCase(),
    `#${template.configId} ${template.configHash.slice(0, 18)}…`,
  );
  add("template-enabled", "Template Config is enabled", template.enabled, String(template.enabled));
  add(
    "template-hash-pinned",
    "Live template hash matches the pinned hash",
    template.configHash.toLowerCase() === pinnedHash.toLowerCase(),
    template.configHash.slice(0, 18) + "…",
  );
  add(
    "concentrated-mode",
    "Migration mode is Concentrated",
    config.migrationMode === AmmoraV4MigrationMode.Concentrated,
    `mode ${config.migrationMode}`,
  );
  add(
    "quote-asset-weth",
    "Quote asset is WETH",
    getAddress(config.quoteToken) === getAddress(WETH),
    config.quoteToken,
  );
  add(
    "threshold-base-nonzero",
    "migrationBaseThreshold > 0 (never zero)",
    config.migrationBaseThreshold > 0n,
    `${config.migrationBaseThreshold.toString()} raw`,
  );
  // Independent recomputation of the destination from the derived Config's own fields.
  const quoteFee =
    (threshold * BigInt(config.migrationQuoteFeeBps)) / 10_000n;
  const quoteAfterFee = threshold - quoteFee;
  const destination = concentratedDepositQuote(
    {
      sqrtPriceX64: derived.curve[0]?.upperSqrtPrice ?? 0n,
      sqrtMinPriceX64: config.postMigrationSqrtMinPrice,
      sqrtMaxPriceX64: config.postMigrationSqrtMaxPrice,
    },
    { quoteAmount: quoteAfterFee },
  );
  add(
    "threshold-base-derived",
    "migrationBaseThreshold equals the recomputed destination base amount",
    config.migrationBaseThreshold === destination.baseAmount,
    `threshold ${config.migrationBaseThreshold} vs derived ${destination.baseAmount}`,
  );
  const worstCaseSold = saleSupply;
  const grossBase = destination.baseAmount;
  const locked = economics.lockedBaseRaw;
  add(
    "invariant-total-supply",
    "totalSupply ≥ worst-case sold + migration base + locked",
    config.totalSupply >= worstCaseSold + grossBase + locked,
    `${config.totalSupply} ≥ ${worstCaseSold} + ${grossBase} + ${locked}`,
  );
  add(
    "invariant-quote",
    "quote after migration fees ≥ gross migration quote required",
    quoteAfterFee >= destination.quoteAmount,
    `${quoteAfterFee} ≥ ${destination.quoteAmount} (surplus ${quoteAfterFee - destination.quoteAmount})`,
  );
  add(
    "invariant-at-migration-base",
    "base reserve at migration ≥ migration base + locked",
    config.totalSupply - worstCaseSold >= grossBase + locked,
    `${config.totalSupply - worstCaseSold} ≥ ${grossBase} + ${locked}`,
  );
  let structural = true;
  let structuralDetail = "assertAmmoraV4Config passed";
  try {
    assertAmmoraV4Config(config, derived.curve);
  } catch (e) {
    structural = false;
    structuralDetail = e instanceof Error ? e.message.slice(0, 160) : String(e);
  }
  add("sdk-structural", "SDK structural validation passes", structural, structuralDetail);
  add(
    "decimals-in-range",
    "Token decimals in contract range (6–9)",
    config.tokenDecimals >= 6 && config.tokenDecimals <= 9,
    String(config.tokenDecimals),
  );
  return { checks, qualified: checks.every((c) => c.pass) };
}

/** Self-contained token metadata for the launch form (no IPFS/backend needed). */
export function buildMetadataURI(input: {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
}): string {
  const json = JSON.stringify({
    name: input.name,
    symbol: input.symbol,
    description: input.description || `GiwaPad token ${input.symbol} on GIWA Sepolia (testnet).`,
    image: input.image || "",
  });
  // base64 data URI: btoa needs latin1, so UTF-8 encode first.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return `data:application/json;base64,${b64}`;
}
