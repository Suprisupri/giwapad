/**
 * 04 — Buy up to the 0.001 WETH graduation threshold, then migrate.
 * Mirrors main.ts executeTrade() (final-fill path) + migrate().
 *
 * The final buy is sized at remaining-to-threshold x 1.5 (capped by WETH
 * balance): the SDK classifies it as a graduation-boundary fill and only
 * consumes what the curve needs — unused input stays in the wallet. The loop
 * re-quotes after each buy (max 3 buys) in case the first buy lands short
 * (e.g. fees/slippage). Migration is a separate permissionless tx.
 *
 * Requires: 03-wrap-trade done. Run:  cd app && node ../test/04-graduate.mts
 */
import {
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4MigratedReceipt,
  resolveAmmoraV4ConcentratedMigrationPositionsReceipt,
} from "@ammora-protocol/sdk";
import {
  CHAIN_ID, LAUNCH, WETH, curveClient, erc20Balance, errorMessage, explorerTx,
  fmt, freshBlock, loadState, log, paced, publicClient, requireFunded,
  saveState, sendTx, testAddress,
} from "./harness.mts";
import { executeTrade } from "./trade-helper.mts";

async function curveStatus(curve: `0x${string}`): Promise<{ status: number; progressBps: number; current: bigint; target: bigint }> {
  const block = await freshBlock();
  const client = curveClient(curve);
  const [state, progress] = await paced(() =>
    Promise.all([client.getStateAtBlock(block), client.getMigrationProgressAtBlock(block)]),
  );
  return { status: state.status, progressBps: progress.progressBps, current: progress.current, target: progress.target };
}

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  const state = loadState();
  if (!state.token) throw new Error("No token in test/state.json — run 02-launch.mts first.");
  await requireFunded(200_000_000_000_000n); // gas for the migrate tx

  const { token, curve, decimals, symbol } = state.token;

  // --- Buy to threshold (unless already ReadyToMigrate / Migrated) ---
  for (let attempt = 1; attempt <= 3; attempt++) {
    const s = await curveStatus(curve);
    log(`Curve status ${s.status} — progress ${(s.progressBps / 100).toFixed(2)}% (${fmt(s.current, 18)} / ${fmt(s.target, 18)} WETH)`);
    if (s.status === 3) {
      log("Curve already Migrated — skipping final buys.");
      break;
    }
    if (s.status === 2) {
      log("Curve is ReadyToMigrate — no more buys needed.");
      break;
    }
    if (s.status !== 1) throw new Error(`Curve status ${s.status} — cannot buy.`);
    const remaining = s.target - s.current;
    const wethBal = await erc20Balance(WETH, testAddress);
    let buyAmount = (remaining * 3n) / 2n; // 1.5x remaining; final-fill consumes only what's needed
    if (buyAmount > wethBal) buyAmount = wethBal;
    if (buyAmount <= 0n) throw new Error(`No WETH left to buy (balance ${fmt(wethBal, 18)}).`);
    log(`Final-fill buy attempt ${attempt}: ${fmt(buyAmount, 18)} WETH (remaining to threshold ${fmt(remaining, 18)} WETH)`);
    const r = await executeTrade(curve, decimals, symbol, "buy", buyAmount);
    log(`Final buy tx: ${r.hash} (fill: ${r.fillKind}, consumed ${fmt(r.consumedAmountIn, 18)} WETH)`);
  }

  const after = await curveStatus(curve);
  log(`After final buys: status ${after.status}, progress ${(after.progressBps / 100).toFixed(2)}%`);
  if (after.status === 3) {
    log("Curve already migrated (by someone else) — recording state and skipping migrate tx.");
    const block = await freshBlock();
    const st = await paced(() => curveClient(curve).getStateAtBlock(block));
    state.token.canonicalPool = st.canonicalPool;
    saveState(state);
    log(`=== 04 GRADUATION DONE (already migrated) — pool ${st.canonicalPool} ===`);
    return;
  }
  if (after.status !== 2) {
    throw new Error(`Curve did not reach ReadyToMigrate after final buys (status ${after.status}, ${(after.progressBps / 100).toFixed(2)}%). Graduation NOT reached — see TEST-REPORT.`);
  }

  // --- Migrate (mirrors main.ts migrate) ---
  const client = curveClient(curve);
  const block = await freshBlock();
  const plan = await paced(() => client.planMigrateAtBlock(block));
  const { hash, receipt } = await sendTx("Migrate", plan.transaction, (m) => log(m));
  log(`Migrate tx: ${hash} — ${explorerTx(hash)} (block ${receipt.blockNumber})`);
  const migrated = parseAmmoraV4MigratedReceipt(receipt, curve);
  const afterState = await paced(() => client.getStateAtBlock(receipt.blockNumber));
  if (afterState.status !== 3 || afterState.canonicalPool.toLowerCase() !== migrated.canonicalPool.toLowerCase()) {
    throw new Error("Migration event/state mismatch — reconcile before continuing.");
  }
  log(`Migrated to ARL pool ${migrated.canonicalPool} · base ${fmt(migrated.baseAmount, decimals)} · quote ${fmt(migrated.quoteAmount, 18)} WETH`);

  // Resolve LP (Manager NFT) positions from the migration receipt.
  let positions: { tokenId: string; owner: `0x${string}` }[] | undefined;
  try {
    const cfg = await paced(() =>
      getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, afterState.configId, receipt.blockNumber),
    );
    const resolved = resolveAmmoraV4ConcentratedMigrationPositionsReceipt({
      chainId: CHAIN_ID,
      receipt,
      expectedTransactionHash: hash,
      curve,
      positionManager: LAUNCH.concentratedPositionManager,
      canonicalPool: migrated.canonicalPool,
      creator: afterState.creator,
      partner: cfg.config.liquidityDistribution.partner,
    });
    positions = resolved.positions.map((p) => ({ tokenId: p.tokenId.toString(), owner: p.owner }));
    log(`LP positions resolved: ${positions.map((p) => `#${p.tokenId} owner ${p.owner}`).join(", ")}`);
  } catch (e) {
    log(`WARNING: migration positions could not be resolved from the receipt: ${errorMessage(e)}`);
  }

  state.token.canonicalPool = migrated.canonicalPool;
  state.token.migrationTx = hash;
  state.token.positions = positions;
  saveState(state);
  log(`=== 04 GRADUATED + MIGRATED — pool ${migrated.canonicalPool} ===`);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(1);
});
