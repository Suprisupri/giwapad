/**
 * 00 — Read-only smoke test. No funds needed, no transactions sent.
 *
 * Mirrors the builder's in-app smoke test + the app's previewConfig flow:
 *  - fresh block read
 *  - verifyDeployment (SDK runtime pins)
 *  - template #12 (fallback #13) read: id/hash/enabled/quarantine checks
 *  - planTeamConfig + checkGraduationReadiness (must be qualified)
 *  - FeeVault read from the Factory
 *  - KILN curve (Config #6, read-only) state matches the safety page
 *  - tokenForCurve / curveForToken round-trip on the KILN curve
 *
 * Run:  cd app && node ../test/00-smoke-reads.mts
 */
import { getAmmoraV4ConfigAtBlock } from "@ammora-protocol/sdk";
import {
  LAUNCH, WETH, curveClient, curveForToken, errorMessage, feeVault, fmt,
  freshBlock, log, paced, publicClient, testAddress, tokenForCurve,
  verifyDeployment,
} from "./harness.mts";
import {
  GIWAPAD_SALE_SUPPLY_RAW,
  GIWAPAD_THRESHOLD_RAW,
  QUARANTINED_TEMPLATE_HASH,
  QUARANTINED_TEMPLATE_ID,
  TEMPLATE_CANDIDATES,
  checkGraduationReadiness,
  planTeamConfig,
} from "../app/src/policy.ts";

const KILN_CURVE = "0x5DBf2731BF5F62Db48fF01f71c1cec87A6D49384" as const;

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  log("=== 00 smoke (read-only) ===");

  const block = await freshBlock();
  log(`Head block: ${block}`);
  check("fresh block read", block > 0n, `block ${block}`);

  try {
    await verifyDeployment();
    check("verifyDeployment (SDK runtime pins)", true);
  } catch (e) {
    check("verifyDeployment (SDK runtime pins)", false, errorMessage(e));
  }

  // Template loop — identical to main.ts previewConfig().
  let template = null;
  let pinnedHash = null;
  let lastErr = "";
  for (const cand of TEMPLATE_CANDIDATES) {
    try {
      const snap = await paced(() =>
        getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, cand.id, block),
      );
      if (
        snap.configId === QUARANTINED_TEMPLATE_ID ||
        snap.configHash.toLowerCase() === QUARANTINED_TEMPLATE_HASH.toLowerCase()
      ) {
        throw new Error(`template #${cand.id} is the quarantined Config #6 identity`);
      }
      if (!snap.enabled) throw new Error(`template #${cand.id} is disabled`);
      if (snap.configHash.toLowerCase() !== cand.hash.toLowerCase()) {
        throw new Error(`template #${cand.id} hash does not match the pinned hash`);
      }
      template = snap;
      pinnedHash = cand.hash;
      break;
    } catch (e) {
      lastErr = errorMessage(e);
      log(`template #${cand.id} rejected: ${lastErr}`);
    }
  }
  check("derivation template found (#12 or #13)", template !== null, lastErr);
  if (!template || !pinnedHash) throw new Error("No usable derivation template.");

  const plan = planTeamConfig(
    template,
    {
      configOwner: testAddress,
      partnerRecipient: testAddress,
      liquidityPartner: testAddress,
      leftoverReceiver: testAddress,
    },
    GIWAPAD_SALE_SUPPLY_RAW,
    GIWAPAD_THRESHOLD_RAW,
  );
  const { checks, qualified } = checkGraduationReadiness({
    template,
    pinnedHash,
    derived: plan,
    saleSupply: GIWAPAD_SALE_SUPPLY_RAW,
    threshold: GIWAPAD_THRESHOLD_RAW,
  });
  for (const c of checks) check(`readiness: ${c.id}`, c.pass, c.detail);
  check("policy qualified", qualified);
  log(`Derived: totalSupply ${plan.economics.totalSupplyRaw} raw, ` +
    `migrationBase ${plan.economics.grossMigrationBaseRaw} raw, ` +
    `migrationQuote ${fmt(plan.economics.grossMigrationQuoteRaw, 18)} WETH, ` +
    `reviewHash ${plan.reviewHash}`);

  const vault = await feeVault();
  check("FeeVault read from Factory", vault !== "0x0000000000000000000000000000000000000000", vault);
  log(`FeeVault: ${vault}`);

  // KILN curve (Config #6) — read-only, must match the safety page exactly.
  const kiln = await paced(() => curveClient(KILN_CURVE).getStateAtBlock(block));
  check("KILN curve status == ReadyToMigrate (2)", kiln.status === 2, `status ${kiln.status}`);
  check("KILN curve baseReserve == 2 raw", kiln.baseReserve === 2n, `${kiln.baseReserve}`);
  check(
    "KILN curve quoteReserve == 0.050000000000000001 WETH",
    kiln.quoteReserve === 50000000000000001n,
    `${fmt(kiln.quoteReserve, 18)} WETH`,
  );
  const tok = await tokenForCurve(KILN_CURVE);
  const back = await curveForToken(tok);
  check("tokenForCurve/curveForToken round-trip", back.toLowerCase() === KILN_CURVE.toLowerCase(), tok);

  log(`WETH (catalog): ${WETH}`);
  log(failures === 0 ? "=== 00 SMOKE: ALL PASS ===" : `=== 00 SMOKE: ${failures} FAILURE(S) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(2);
});
