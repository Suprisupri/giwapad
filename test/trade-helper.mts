/**
 * Shared trade helper — mirrors main.ts executeTrade() exactly:
 *  fresh block -> state check (Active) -> quote -> classify fill
 *  (full or graduation-boundary only) -> planSwapExactInput (1% slippage,
 *  20-min deadline) -> plan/quote fill-kind agreement check ->
 *  exact approvals -> sendTx -> parse receipt.
 */
import {
  classifyAmmoraV4ExactInputFill,
  parseAmmoraV4SwapReceipt,
} from "@ammora-protocol/sdk";
import type { Address } from "viem";
import {
  curveClient, ensureApprovals, errorMessage, explorerTx, fmt, freshBlock,
  log, paced, sendTx, testAddress,
} from "./harness.mts";

export type TradeResult = {
  hash: `0x${string}`;
  amountOut: bigint;
  consumedAmountIn: bigint;
  fee: bigint;
  amountLeft: bigint;
  fillKind: string;
};

export async function executeTrade(
  curve: Address,
  tokenDecimals: number,
  symbol: string,
  side: "buy" | "sell",
  amountIn: bigint,
): Promise<TradeResult> {
  const baseForQuote = side === "sell";
  const client = curveClient(curve);
  const block = await freshBlock();
  const state = await paced(() => client.getStateAtBlock(block));
  if (state.status !== 1) {
    throw new Error(`Curve is status ${state.status}, not Active (1).`);
  }
  const quote = await paced(() => client.quoteExactInputAtBlock(amountIn, baseForQuote, block));
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  log(`Quote: in ${fmt(amountIn, baseForQuote ? tokenDecimals : 18)} -> out ${fmt(quote.amountOut, baseForQuote ? 18 : tokenDecimals)} ` +
    `fee ${fmt(quote.fee, baseForQuote ? tokenDecimals : 18)} (fill: ${fill.kind})`);
  if (fill.kind !== "full" && fill.kind !== "graduation-boundary") {
    throw new Error(`This order would ${fill.kind}; reduce the amount and retry.`);
  }
  if (fill.kind === "graduation-boundary" && side === "sell") {
    throw new Error("Graduation-boundary fills apply to buys only.");
  }
  const plan = await paced(() =>
    client.planSwapExactInput({
      includedAmountIn: amountIn,
      baseForQuote,
      allowPartialFill: fill.allowPartialFill,
      slippageBps: 100,
      recipient: testAddress,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }),
  );
  const planFill = classifyAmmoraV4ExactInputFill(plan.quote, baseForQuote);
  if (planFill.kind !== fill.kind) {
    throw new Error(`Curve state moved between quote and plan (${fill.kind} -> ${planFill.kind}). Retry.`);
  }
  await ensureApprovals(plan.approvalRequirements, (m) => log(m));
  const { hash, receipt } = await sendTx(side === "buy" ? "Buy" : "Sell", plan.transaction, (m) => log(m));
  const parsed = parseAmmoraV4SwapReceipt(receipt, curve, {
    trader: testAddress,
    recipient: testAddress,
    baseForQuote,
    requestedAmountIn: amountIn,
    minimumAmountOut: plan.quote.minimumAmountOut,
  });
  log(`${side === "buy" ? "Bought" : "Sold"}: received ${fmt(parsed.amountOut, baseForQuote ? 18 : tokenDecimals)} ` +
    `${baseForQuote ? "WETH" : symbol} · consumed ${fmt(parsed.consumedAmountIn, baseForQuote ? tokenDecimals : 18)} ` +
    `· fee ${fmt(parsed.fee, baseForQuote ? tokenDecimals : 18)} · left ${fmt(parsed.amountLeft, baseForQuote ? tokenDecimals : 18)} — ${explorerTx(hash)}`);
  return {
    hash,
    amountOut: parsed.amountOut,
    consumedAmountIn: parsed.consumedAmountIn,
    fee: parsed.fee,
    amountLeft: parsed.amountLeft,
    fillKind: fill.kind,
  };
}
