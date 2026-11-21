/**
 * 03 — Wrap ETH -> WETH, buy on the curve, sell a portion.
 * Mirrors main.ts wrapEth() + executeTrade().
 *
 * Amounts: wrap 0.002 ETH (leaves ~0.003 ETH for gas from a 0.005 faucet
 * claim); buy 0.0001 WETH; sell 25% of the tokens received.
 *
 * Requires: 02-launch done. Run:  cd app && node ../test/03-wrap-trade.mts
 */
import { buildAmmoraPortableWrapTransaction } from "@ammora-protocol/sdk";
import {
  DEPLOYMENT, WETH, erc20Balance, errorMessage, ethBalance, explorerTx,
  fmt, loadState, log, requireFunded, sendTx, testAddress,
} from "./harness.mts";
import { executeTrade } from "./trade-helper.mts";

const WRAP_AMOUNT = 2_000_000_000_000_000n; // 0.002 ETH
const BUY_AMOUNT = 100_000_000_000_000n; // 0.0001 WETH

async function main(): Promise<void> {
  log(`Test wallet: ${testAddress}`);
  const state = loadState();
  if (!state.token) throw new Error("No token in test/state.json — run 02-launch.mts first.");
  await requireFunded(WRAP_AMOUNT + 500_000_000_000_000n);

  // --- Wrap (mirrors main.ts wrapEth) ---
  const wethBefore = await erc20Balance(WETH, testAddress);
  log(`WETH before wrap: ${fmt(wethBefore, 18)}`);
  if (wethBefore < BUY_AMOUNT * 2n) {
    const tx = buildAmmoraPortableWrapTransaction(
      {
        kind: "WRAPPED_ERC20",
        nativeDecimals: 18,
        wrappedToken: WETH,
        wrappedTokenDecimals: 18,
        nativeRouter: DEPLOYMENT.contracts.routers.native,
      },
      WRAP_AMOUNT,
    );
    const { hash } = await sendTx("Wrap ETH -> WETH", tx, (m) => log(m));
    log(`Wrap tx: ${hash} — ${explorerTx(hash)}`);
  } else {
    log("Already hold enough WETH — skipping wrap.");
  }
  const wethAfter = await erc20Balance(WETH, testAddress);
  log(`WETH after wrap: ${fmt(wethAfter, 18)} (ETH ${fmt(await ethBalance(testAddress), 18)})`);
  if (wethAfter < BUY_AMOUNT) throw new Error("Not enough WETH for the buy.");

  // --- Buy 0.0001 WETH ---
  const buy = await executeTrade(state.token.curve, state.token.decimals, state.token.symbol, "buy", BUY_AMOUNT);
  log(`Buy tx: ${buy.hash}`);
  const baseBal = await erc20Balance(state.token.token, testAddress);
  log(`${state.token.symbol} balance after buy: ${fmt(baseBal, state.token.decimals)}`);

  // --- Sell 25% of what we hold ---
  const sellAmount = baseBal / 4n;
  if (sellAmount <= 0n) throw new Error("Token balance too small to sell 25%.");
  const sell = await executeTrade(state.token.curve, state.token.decimals, state.token.symbol, "sell", sellAmount);
  log(`Sell tx: ${sell.hash}`);
  log(`${state.token.symbol} balance after sell: ${fmt(await erc20Balance(state.token.token, testAddress), state.token.decimals)}`);
  log(`WETH balance after sell: ${fmt(await erc20Balance(WETH, testAddress), 18)}`);
  log(`=== 03 WRAP + BUY + SELL DONE ===`);
}

main().catch((e) => {
  log(`FATAL: ${errorMessage(e)}`);
  process.exit(1);
});
