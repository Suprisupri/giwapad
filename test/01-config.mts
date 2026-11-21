/**
 * 01 — Create the GiwaPad Config on-chain.
 * Mirrors main.ts previewConfig() + createConfig() exactly:
 *  template loop (#12, fallback #13) -> planTeamConfig -> readiness check
 *  (must be qualified) -> sendTx -> parse receipt -> receipt-bound verification.
 *
 * Requires funding (gas only; Config creation has no fee beyond gas).
 * Run:  cd app && node ../test/01-config.mts
 */
import {
  buildCreateAmmoraV4Config,
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4ConfigCreatedReceipt,
} from "@ammora-protocol/sdk";
import {
  LAUNCH, errorMessage, explorerTx, freshBlock, loadState, log, paced,
  publicClient, requireFunded, saveState, sendTx, testAddress,
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

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  const state = loadState();
  if (state.config) {
    log(`Config already created in this test run: #${state.config.id} (${state.config.txHash}). Skipping.`);
    return;
  }
  await requireFunded(500_000_000_000_000n); // 0.0005 ETH minimum to start

  const block = await freshBlock();
  log(`Head block: ${block}`);
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
  if (!template || !pinnedHash) throw new Error(`No usable derivation template: ${lastErr}`);
  log(`Template: Config #${template.configId} (hash ${template.configHash})`);

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
  for (const c of checks) log(`  readiness ${c.pass ? "PASS" : "FAIL"} ${c.id} — ${c.detail}`);
  if (!qualified) throw new Error("Policy NOT qualified — creation blocked.");
  log(`Review hash: ${plan.reviewHash}`);

  const { hash, receipt } = await sendTx("Create Config", plan.transaction, (m) => log(m));
  log(`Create Config tx: ${hash} — ${explorerTx(hash)} (block ${receipt.blockNumber})`);

  const created = parseAmmoraV4ConfigCreatedReceipt(receipt, LAUNCH.configRegistry);
  log(`Parsed receipt: configId #${created.configId}, hash ${created.configHash}`);

  // Receipt-bound verification (as in main.ts createConfig).
  const confirmed = await paced(() =>
    getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, created.configId, receipt.blockNumber),
  );
  const rebuilt = buildCreateAmmoraV4Config(confirmed.config, confirmed.segments, testAddress);
  if (
    rebuilt.data !== plan.transaction.data ||
    confirmed.configHash !== created.configHash ||
    confirmed.identity.owner.toLowerCase() !== testAddress.toLowerCase() ||
    confirmed.identity.feeClaimer.toLowerCase() !== testAddress.toLowerCase()
  ) {
    throw new Error("Receipt-bound Config does not match the reviewed policy — do not use it.");
  }
  log(`Receipt-bound verification PASS: calldata, hash, owner and feeClaimer all match the plan.`);

  state.config = {
    id: created.configId.toString(),
    hash: created.configHash,
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    templateId: template.configId.toString(),
  };
  saveState(state);
  log(`=== 01 CONFIG CREATED: #${created.configId} ===`);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(1);
});
