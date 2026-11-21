/**
 * GiwaPad test harness (Node, testnet only).
 *
 * Drives the app's OWN code paths (app/src/ammora.ts + app/src/policy.ts)
 * with a viem wallet client built from the fresh testnet-only key in
 * ../.test-wallet.json (mode 600, gitignored).
 *
 * What is reused verbatim from the app:
 *   publicClient, paced, freshBlock, curveClient, feeVault, curveForToken,
 *   tokenForCurve, tokenInfo, erc20Balance, ethBalance, claimableInVault,
 *   verifyDeployment, formatting helpers, DEPLOYMENT/LAUNCH/WETH constants,
 *   and (in the step scripts) planTeamConfig / checkGraduationReadiness /
 *   buildMetadataURI from policy.ts plus the SDK builders/parsers main.ts uses.
 *
 * What is necessarily reimplemented (documented deviation):
 *   sendTx / ensureApprovals — the app's versions sign through
 *   window.ethereum (EIP-1193, browser-only). The Node harness keeps the
 *   EXACT same pattern (eth_call simulation -> send -> wait 13 confirmations
 *   -> canonical-block check -> never resend) but signs with a viem
 *   privateKeyToAccount wallet client. No other logic differs.
 *
 * NEVER prints the private key. State (addresses, tx hashes) lives in
 * test/state.json — no secrets in it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, http } from "viem";
import type { Account, Address, Hash, Hex, TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { planERC20Approvals } from "@ammora-protocol/sdk";
import {
  CHAIN_ID,
  DEPLOYMENT,
  EXPLORER,
  LAUNCH,
  RPC_PRIMARY,
  WETH,
  claimableInVault,
  curveClient,
  curveForToken,
  erc20Balance,
  errorMessage,
  ethBalance,
  explorerAddr,
  explorerTx,
  feeVault,
  fmt,
  freshBlock,
  giwaSepolia,
  paced,
  publicClient,
  shortAddr,
  shortHash,
  tokenForCurve,
  tokenInfo,
  verifyDeployment,
} from "../app/src/ammora.ts";

export {
  CHAIN_ID, DEPLOYMENT, EXPLORER, LAUNCH, RPC_PRIMARY, WETH,
  claimableInVault, curveClient, curveForToken, erc20Balance, errorMessage,
  ethBalance, explorerAddr, explorerTx, feeVault, fmt, freshBlock,
  giwaSepolia, paced, publicClient, shortAddr, shortHash, tokenForCurve,
  tokenInfo, verifyDeployment,
};

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(TEST_DIR, "state.json");
const WALLET_PATH = path.join(TEST_DIR, "..", ".test-wallet.json");

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export function loadWallet(): { account: Account; address: Address } {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
  const account = privateKeyToAccount(raw.privateKey as Hex);
  return { account, address: account.address };
}

const { account, address: TEST_ADDRESS } = loadWallet();
export const testAccount: Account = account;
export const testAddress: Address = TEST_ADDRESS;

/** Node wallet client (private-key signer) — the browser EIP-1193 equivalent. */
export const nodeWalletClient = createWalletClient({
  account,
  chain: giwaSepolia,
  transport: http(RPC_PRIMARY, { timeout: 90_000, retryCount: 0 }),
});

export type PlannedTx = { to: Address; data: Hex; value?: bigint };

/**
 * Mirror of app sendTx (ammora.ts): simulate -> sign -> send -> 13
 * confirmations -> canonical-block check. Never resends.
 */
export async function sendTx(
  label: string,
  tx: PlannedTx,
  onProgress?: (msg: string) => void,
): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  onProgress?.(`${label}: simulating…`);
  await paced(() =>
    publicClient.call({ account: testAddress, to: tx.to, data: tx.data, value: tx.value ?? 0n }),
  );
  onProgress?.(`${label}: signing + sending…`);
  const hash = await nodeWalletClient.sendTransaction({
    account,
    chain: giwaSepolia,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  onProgress?.(`${label}: submitted ${shortHash(hash)} — waiting for 13 confirmations…`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 13,
    pollingInterval: 3_000,
    timeout: 300_000,
    retryCount: 0,
  });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted on-chain: ${explorerTx(hash)}`);
  }
  const canonical = await paced(() => publicClient.getBlock({ blockNumber: receipt.blockNumber }));
  if (canonical.hash !== receipt.blockHash) {
    throw new Error(`Non-canonical receipt for ${hash}; reconcile before continuing.`);
  }
  recordTx(label, hash, receipt.blockNumber);
  return { hash, receipt };
}

/** Mirror of app ensureApprovals (ammora.ts): exact amounts, never infinite. */
export async function ensureApprovals(
  requirements: readonly { token: Address; spender: Address; amount: bigint }[],
  onProgress?: (msg: string) => void,
): Promise<Hash[]> {
  const { erc20Abi } = await import("viem");
  const plans = await paced(() => planERC20Approvals(publicClient, testAddress, requirements));
  const hashes: Hash[] = [];
  for (const plan of plans) {
    for (const ptx of plan.transactions) {
      const { hash, receipt } = await sendTx(
        `Approve ${shortAddr(plan.requirement.token)}`,
        { to: ptx.to, data: ptx.data, value: ptx.value },
        onProgress,
      );
      hashes.push(hash);
      const allowance = await paced(() =>
        publicClient.readContract({
          address: plan.requirement.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [testAddress, plan.requirement.spender],
          blockNumber: receipt.blockNumber,
        }),
      );
      if (allowance < plan.requirement.amount) {
        throw new Error("Approval confirmed but allowance is below the required amount; aborting.");
      }
    }
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// Shared state (no secrets): test/state.json
// ---------------------------------------------------------------------------
export type TestState = {
  wallet: Address;
  funded: boolean;
  fundingTx?: string;
  config: null | { id: string; hash: string; txHash: string; blockNumber: string; templateId: string };
  token: null | {
    token: Address; curve: Address; name: string; symbol: string; decimals: number;
    configId: string; launchTx: string; launchBlock: string; metadataURIUsed: string;
    canonicalPool?: Address; migrationTx?: string;
    positions?: { tokenId: string; owner: Address }[];
  };
  txs: { label: string; hash: string; url: string; block: string; at: string }[];
};

export function loadState(): TestState {
  if (!fs.existsSync(STATE_PATH)) {
    return { wallet: testAddress, funded: false, config: null, token: null, txs: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as TestState;
}

export function saveState(s: TestState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

export function recordTx(label: string, hash: Hash, block: bigint): void {
  const s = loadState();
  s.txs.push({
    label,
    hash,
    url: explorerTx(hash),
    block: block.toString(),
    at: new Date().toISOString(),
  });
  saveState(s);
}

export async function requireFunded(minEth: bigint): Promise<bigint> {
  const bal = await ethBalance(testAddress);
  log(`Test wallet ETH balance: ${fmt(bal, 18)} ETH`);
  if (bal < minEth) {
    throw new Error(
      `Insufficient funds: have ${fmt(bal, 18)} ETH, need >= ${fmt(minEth, 18)} ETH. ` +
        `Fund ${testAddress} from https://faucet.giwa.io first.`,
    );
  }
  return bal;
}
