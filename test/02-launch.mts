/**
 * 02 — Launch a token on the GiwaPad Config.
 * Mirrors main.ts launchToken() exactly: re-read Config at a fresh block,
 * check enabled + 9 decimals, buildCreateAmmoraV4Launch, sendTx, parse
 * receipt, verify configId/configHash match.
 *
 * WATCH ITEM: the app defaults token metadata to a data:application/json;base64
 * URI. This script tries the default FIRST. If the launch simulation reverts,
 * it retries ONCE with an https:// override and records which worked.
 *
 * Requires: 01-config done. Run:  cd app && node ../test/02-launch.mts
 */
import {
  buildCreateAmmoraV4Launch,
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4LaunchCreatedReceipt,
} from "@ammora-protocol/sdk";
import {
  LAUNCH, errorMessage, explorerTx, freshBlock, loadState, log, paced,
  publicClient, requireFunded, saveState, sendTx, testAddress,
} from "./harness.mts";
import { GIWAPAD_TOKEN_DECIMALS, buildMetadataURI } from "../app/src/policy.ts";

const TOKEN_NAME = "GiwaPad Test";
const TOKEN_SYMBOL = "GPTEST";
const METADATA_FALLBACK = "https://suprisupri.github.io/giwapad/gptest.json";

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  const state = loadState();
  if (!state.config) throw new Error("No Config in test/state.json — run 01-config.mts first.");
  if (state.token) {
    log(`Token already launched in this test run: ${state.token.token} (${state.token.symbol}). Skipping.`);
    return;
  }
  await requireFunded(500_000_000_000_000n);

  const configId = BigInt(state.config.id);
  const block = await freshBlock();
  const entry = await paced(() =>
    getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, configId, block),
  );
  if (!entry.enabled) throw new Error(`Config #${configId} is disabled.`);
  if (entry.config.tokenDecimals !== GIWAPAD_TOKEN_DECIMALS) {
    throw new Error("Config token decimals do not match the GiwaPad policy.");
  }
  log(`Config #${configId} enabled, poolCreationFee ${entry.config.poolCreationFee} wei.`);

  const dataURI = buildMetadataURI({ name: TOKEN_NAME, symbol: TOKEN_SYMBOL, description: "GiwaPad on-chain test token (GIWA Sepolia testnet)." });
  log(`Default metadata URI (data:): ${dataURI.slice(0, 80)}… (${dataURI.length} chars)`);

  const attempts: { uri: string; label: string }[] = [
    { uri: dataURI, label: "data: URI (app default)" },
    { uri: METADATA_FALLBACK, label: "https:// override (documented fallback)" },
  ];

  let launched: { hash: `0x${string}`; receipt: Awaited<ReturnType<typeof sendTx>>["receipt"] } | null = null;
  let usedURI = "";
  let firstError = "";
  for (const attempt of attempts) {
    log(`Attempting launch with ${attempt.label}…`);
    try {
      const tx = buildCreateAmmoraV4Launch(
        { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, metadataURI: attempt.uri, creatorMetadataURI: attempt.uri, tokenDecimals: GIWAPAD_TOKEN_DECIMALS },
        configId,
        entry.config.poolCreationFee,
      );
      launched = await sendTx("Launch token", { to: LAUNCH.factory, data: tx.data, value: tx.value }, (m) => log(m));
      usedURI = attempt.uri;
      log(`Launch SUCCEEDED with ${attempt.label}.`);
      break;
    } catch (e) {
      firstError = errorMessage(e);
      log(`Launch FAILED with ${attempt.label}: ${firstError}`);
      // Only retry once with the documented fallback, and only if the first
      // attempt was the data: URI (i.e. nothing was submitted yet — a revert
      // at simulation means no tx went out).
    }
  }
  if (!launched) throw new Error(`Launch failed on both metadata URIs. First error: ${firstError}`);

  const { hash, receipt } = launched;
  log(`Launch tx: ${hash} — ${explorerTx(hash)} (block ${receipt.blockNumber})`);
  const created = parseAmmoraV4LaunchCreatedReceipt(receipt, LAUNCH.factory);
  if (created.configId !== configId || created.configHash !== entry.configHash) {
    throw new Error("Launch receipt does not match the selected Config — do not trust the token addresses.");
  }
  log(`Token: ${created.token}`);
  log(`Curve: ${created.curve}`);
  log(`Metadata URI that worked: ${usedURI === dataURI ? "data: URI (app default)" : "https:// override"}`);

  state.token = {
    token: created.token,
    curve: created.curve,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    decimals: GIWAPAD_TOKEN_DECIMALS,
    configId: created.configId.toString(),
    launchTx: hash,
    launchBlock: receipt.blockNumber.toString(),
    metadataURIUsed: usedURI === dataURI ? "data:" : "https://",
  };
  saveState(state);
  log(`=== 02 TOKEN LAUNCHED: ${TOKEN_NAME} (${TOKEN_SYMBOL}) ===`);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(1);
});
