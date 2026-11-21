/**
 * 05 — Fee claims: Creator/Partner FeeVault (WETH + base token) and LP fees,
 * plus creator surplus / leftover.
 * Mirrors main.ts refreshClaims() / claimVaultFee() / claimLpFees() /
 * creatorClaim().
 *
 * Notes:
 *  - FeeVault claims only run when claimable > 0 (the app only shows the
 *    button then); a zero claimable is recorded, not forced.
 *  - LP fee claims run for stored positions owned by the test wallet. If the
 *    position accrued no fees (no post-graduation trades), the claim may
 *    revert at simulation — that is recorded as "no fees to claim", not a bug.
 *  - Surplus is 0 by derivation, so claimSurplus is expected to fail at
 *    simulation; it is attempted once and recorded.
 *  - Leftover (unsold sale tokens) is expected to be > 0 after migration and
 *    withdrawLeftover should succeed.
 *
 * Requires: 04-graduate done. Run:  cd app && node ../test/05-claims.mts
 */
import { DammV2Client, buildClaimFeeVaultFor } from "@ammora-protocol/sdk";
import {
  LAUNCH, WETH, claimableInVault, curveClient, erc20Balance, errorMessage,
  explorerTx, feeVault, fmt, loadState, log, paced, publicClient, sendTx,
  testAddress,
} from "./harness.mts";

const ERC721_OWNER_ABI = [
  { type: "function", name: "ownerOf", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

async function tryClaim(label: string, fn: () => Promise<{ hash: `0x${string}` }>): Promise<boolean> {
  try {
    const { hash } = await fn();
    log(`${label}: CLAIMED — ${hash} (${explorerTx(hash)})`);
    return true;
  } catch (e) {
    log(`${label}: NOT CLAIMED — ${errorMessage(e)}`);
    return false;
  }
}

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  const state = loadState();
  if (!state.token) throw new Error("No token in test/state.json — run 02-launch.mts first.");
  const { token, curve, symbol, decimals } = state.token;

  const vault = await feeVault();
  log(`FeeVault: ${vault}`);

  const wethClaimable = await claimableInVault(WETH, testAddress);
  log(`WETH claimable (creator/partner): ${fmt(wethClaimable, 18)} WETH`);
  if (wethClaimable > 0n) {
    await tryClaim("Claim WETH fees", async () => {
      const tx = buildClaimFeeVaultFor(WETH, testAddress, testAddress);
      return sendTx("Claim WETH fees", { to: vault, data: tx.data }, (m) => log(m));
    });
    log(`WETH claimable after claim: ${fmt(await claimableInVault(WETH, testAddress), 18)}`);
  } else {
    log("WETH claimable is 0 — no claim tx (app hides the button in this case).");
  }

  const baseClaimable = await claimableInVault(token, testAddress);
  log(`${symbol} claimable (creator/partner): ${fmt(baseClaimable, decimals)} ${symbol}`);
  if (baseClaimable > 0n) {
    await tryClaim(`Claim ${symbol} fees`, async () => {
      const tx = buildClaimFeeVaultFor(token, testAddress, testAddress);
      return sendTx(`Claim ${symbol} fees`, { to: vault, data: tx.data }, (m) => log(m));
    });
    log(`${symbol} claimable after claim: ${fmt(await claimableInVault(token, testAddress), decimals)}`);
  } else {
    log(`${symbol} claimable is 0 — no claim tx.`);
  }

  // LP fee claims (owned migration positions only).
  if (state.token.canonicalPool && state.token.positions?.length) {
    for (const p of state.token.positions) {
      let owner: `0x${string}` = p.owner;
      try {
        owner = (await paced(() =>
          publicClient.readContract({
            address: LAUNCH.concentratedPositionManager,
            abi: ERC721_OWNER_ABI,
            functionName: "ownerOf",
            args: [BigInt(p.tokenId)],
          }),
        )) as `0x${string}`;
      } catch {
        log(`LP position #${p.tokenId}: ownerOf read failed; using stored owner ${p.owner}.`);
      }
      if (owner.toLowerCase() !== testAddress.toLowerCase()) {
        log(`LP position #${p.tokenId} owned by ${owner} — not ours, skipping.`);
        continue;
      }
      await tryClaim(`Claim LP fees (#${p.tokenId})`, async () => {
        const damm = new DammV2Client(
          publicClient,
          state.token!.canonicalPool!,
          "concentrated",
          LAUNCH.concentratedFactory,
          LAUNCH.concentratedPositionManager,
        );
        const tx = await paced(() =>
          damm.planClaimManagedConcentratedFees(BigInt(p.tokenId), testAddress, testAddress),
        );
        return sendTx("Claim LP fees", tx, (m) => log(m));
      });
    }
  } else {
    log("No canonical pool / LP positions recorded — LP fee claim not applicable.");
  }

  // Creator surplus (expected 0 by derivation) + leftover (expected > 0).
  const client = curveClient(curve);
  await tryClaim("Claim surplus (creator)", async () => {
    const plan = await paced(() => client.planClaimSurplus(testAddress));
    return sendTx("Claim surplus", plan.transaction, (m) => log(m));
  });
  const baseBefore = await erc20Balance(token, testAddress);
  await tryClaim("Withdraw leftover (creator)", async () => {
    const plan = await paced(() => client.planWithdrawLeftover(testAddress));
    return sendTx("Withdraw leftover", plan.transaction, (m) => log(m));
  });
  const baseAfter = await erc20Balance(token, testAddress);
  log(`${symbol} balance: ${fmt(baseBefore, decimals)} -> ${fmt(baseAfter, decimals)} (leftover received: ${fmt(baseAfter - baseBefore, decimals)})`);

  log(`=== 05 CLAIMS DONE ===`);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(1);
});
