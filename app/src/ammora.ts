/**
 * GiwaPad — Ammora SDK integration layer.
 *
 * All contract addresses come from the installed SDK's deployment catalog
 * (`giwaSepoliaAutoRouteDeployment`), never from hardcoded guesses. The only
 * address the app pins independently is the WETH predeploy, which the catalog
 * itself also reports as `contracts.tokens.wrappedNative` (verified equal).
 *
 * The SDK only plans transactions; the user's own wallet (MetaMask/Rabby via
 * EIP-1193 + viem WalletClient) is the only signer. This module never sees a
 * private key.
 */
import {
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  feeVaultAbi,
  giwaSepoliaAutoRouteDeployment,
  planERC20Approvals,
  verifyAmmoraV4CoreAtBlock,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  zeroAddress,
} from "viem";
import type {
  Account,
  Address,
  EIP1193Provider,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from "viem";

export const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
export const LAUNCH = DEPLOYMENT.contracts.launch;
export const CHAIN_ID = DEPLOYMENT.chain.id; // 91342
export const EXPLORER = DEPLOYMENT.chain.blockExplorerUrl;
export const FAUCET_URL = "https://faucet.giwa.io";
export const WETH = DEPLOYMENT.contracts.tokens.wrappedNative;
export const RPC_PRIMARY = "https://sepolia-rpc.giwa.io";
export const RPC_BACKUP = "https://giwa-sepolia-testnet.api.pocket.network";

if (WETH.toLowerCase() !== "0x4200000000000000000000000000000000000006") {
  throw new Error("Catalog WETH does not match the OP Stack predeploy; refusing to run.");
}

export const giwaSepolia = defineChain({
  id: CHAIN_ID,
  name: DEPLOYMENT.chain.name,
  nativeCurrency: DEPLOYMENT.chain.nativeCurrency,
  rpcUrls: {
    default: { http: [RPC_PRIMARY] },
    public: { http: [RPC_PRIMARY, RPC_BACKUP] },
  },
  blockExplorers: {
    default: { name: "GIWA Sepolia Explorer", url: EXPLORER },
  },
  testnet: true,
});

/**
 * Public client with a fallback RPC. The GIWA public endpoint is rate-limited
 * and slow (single reads have taken 5–45s in testing; eth_chainId alone took
 * 31s during a degraded period on 21 Nov 2026, and the Pocket backup was
 * unresponsive for 120s+ at the same time). Requests get a long timeout.
 * Per-transport retries are OFF and the fallback tries the list once: viem's
 * default retry stacking turned one slow read into 8+ minutes of retries.
 */
export const publicClient: PublicClient = createPublicClient({
  chain: giwaSepolia,
  transport: fallback(
    [http(RPC_PRIMARY, { timeout: 90_000, retryCount: 0 }), http(RPC_BACKUP, { timeout: 90_000, retryCount: 0 })],
    { retryCount: 1, retryDelay: 2_000 },
  ),
});

// ---------------------------------------------------------------------------
// RPC pacing: serialize heavy read operations with >=600ms between them, the
// interval the Ammora examples use (AMMORA_RPC_INTERVAL_MS=600).
// ---------------------------------------------------------------------------
let readQueue: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = readQueue.then(async () => {
    await sleep(600);
    return fn();
  });
  // Keep the chain alive even if this op rejects.
  readQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Fresh head block, bypassing viem's block-number cache. */
export function freshBlock(): Promise<bigint> {
  return paced(() => publicClient.getBlockNumber({ cacheTime: 0 }));
}

// ---------------------------------------------------------------------------
// Wallet (EIP-1193 via viem)
// ---------------------------------------------------------------------------
export function ethereumProvider(): EIP1193Provider | undefined {
  const w = window as unknown as { ethereum?: EIP1193Provider };
  return w.ethereum;
}

export function walletClient(): WalletClient {
  const provider = ethereumProvider();
  if (!provider) throw new Error("No EIP-1193 wallet found. Install MetaMask or Rabby and reload.");
  return createWalletClient({ chain: giwaSepolia, transport: custom(provider) });
}

/** Connect + ensure the wallet is on GIWA Sepolia (switch, or add the chain). */
export async function connectWallet(): Promise<{ account: Account; chainId: number }> {
  const wc = walletClient();
  const [address] = await wc.requestAddresses();
  if (!address) throw new Error("Wallet returned no accounts.");
  let chainId = await wc.getChainId();
  if (chainId !== CHAIN_ID) {
    try {
      await wc.switchChain({ id: CHAIN_ID });
    } catch (err) {
      const msg = errorMessage(err);
      if (!/4902|unknown chain|unrecognized chain|not added/i.test(msg)) throw err;
      await wc.addChain({ chain: giwaSepolia });
      await wc.switchChain({ id: CHAIN_ID });
    }
    chainId = await wc.getChainId();
  }
  if (chainId !== CHAIN_ID) throw new Error(`Wallet is on chain ${chainId}; GiwaPad needs GIWA Sepolia (${CHAIN_ID}).`);
  const account = { address, type: "json-rpc" } as Account;
  return { account, chainId };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function verifyDeployment(): Promise<void> {
  const block = await freshBlock();
  await paced(() =>
    verifyAmmoraV4CoreAtBlock(
      publicClient,
      {
        configRegistry: LAUNCH.configRegistry,
        launchFactory: LAUNCH.factory,
        graduationAdapter: LAUNCH.graduationAdapter,
        feePolicy: LAUNCH.feePolicy,
      },
      block,
    ),
  );
}

export function curveClient(curve: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(publicClient, curve, {
    launchFactory: LAUNCH.factory,
    feePolicy: LAUNCH.feePolicy,
  });
}

let cachedFeeVault: Address | undefined;
export async function feeVault(): Promise<Address> {
  if (cachedFeeVault) return cachedFeeVault;
  const vault = (await paced(() =>
    publicClient.readContract({
      address: LAUNCH.factory,
      abi: ammoraLaunchFactoryV4Abi,
      functionName: "feeVault",
    }),
  )) as Address;
  cachedFeeVault = vault;
  return vault;
}

export async function curveForToken(token: Address): Promise<Address> {
  return (await paced(() =>
    publicClient.readContract({
      address: LAUNCH.factory,
      abi: ammoraLaunchFactoryV4Abi,
      functionName: "curveForToken",
      args: [token],
    }),
  )) as Address;
}

export async function tokenForCurve(curve: Address): Promise<Address> {
  return (await paced(() =>
    publicClient.readContract({
      address: LAUNCH.factory,
      abi: ammoraLaunchFactoryV4Abi,
      functionName: "tokenForCurve",
      args: [curve],
    }),
  )) as Address;
}

export async function tokenInfo(
  token: Address,
): Promise<{ decimals: number; symbol: string; name: string }> {
  const [decimals, symbol, name] = await paced(() =>
    Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    ]),
  );
  return { decimals: Number(decimals), symbol: String(symbol), name: String(name) };
}

export async function erc20Balance(token: Address, owner: Address): Promise<bigint> {
  return paced(() =>
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
  );
}

export async function claimableInVault(feeToken: Address, beneficiary: Address): Promise<bigint> {
  const vault = await feeVault();
  return paced(() =>
    publicClient.readContract({
      address: vault,
      abi: feeVaultAbi,
      functionName: "claimable",
      args: [feeToken, beneficiary],
    }),
  );
}

export async function ethBalance(owner: Address): Promise<bigint> {
  return paced(() => publicClient.getBalance({ address: owner }));
}

// ---------------------------------------------------------------------------
// Sends: simulate first, then send via the wallet, then wait for a canonical
// receipt (13 confirmations on GIWA, as in the Ammora examples). Never resends.
// ---------------------------------------------------------------------------
export type PlannedTx = { to: Address; data: Hex; value?: bigint };

export async function sendTx(
  label: string,
  tx: PlannedTx,
  account: Account,
  onProgress?: (msg: string) => void,
): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  const wc = walletClient();
  onProgress?.(`${label}: simulating…`);
  await paced(() =>
    publicClient.call({ account: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n }),
  );
  onProgress?.(`${label}: waiting for wallet signature…`);
  const hash = await wc.sendTransaction({
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
  return { hash, receipt };
}

/** Exact-amount ERC-20 approvals for a plan's requirements (never infinite). */
export async function ensureApprovals(
  requirements: readonly { token: Address; spender: Address; amount: bigint }[],
  account: Account,
  onProgress?: (msg: string) => void,
): Promise<Hash[]> {
  const plans = await paced(() => planERC20Approvals(publicClient, account.address, requirements));
  const hashes: Hash[] = [];
  for (const plan of plans) {
    for (const tx of plan.transactions) {
      const { hash, receipt } = await sendTx(
        `Approve ${shortAddr(plan.requirement.token)}`,
        { to: tx.to, data: tx.data, value: tx.value },
        account,
        onProgress,
      );
      hashes.push(hash);
      const allowance = await paced(() =>
        publicClient.readContract({
          address: plan.requirement.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, plan.requirement.spender],
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
// Formatting helpers
// ---------------------------------------------------------------------------
export function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}
export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
export function explorerAddr(addr: string): string {
  return `${EXPLORER}/address/${addr}`;
}
export function fmt(value: bigint, decimals: number, maxDp = 6): string {
  const s = formatUnits(value, decimals);
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, maxDp).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}
/** Trim a (possibly huge) viem/SDK error to its first useful line. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const first = err.message.split("\n")[0] ?? "";
    // User rejection in the wallet.
    if (/user rejected|user denied|rejected the request/i.test(err.message)) {
      return "Rejected in wallet.";
    }
    if (/over rate limit|429|too many requests/i.test(err.message)) {
      return "RPC is rate-limiting. Wait a few seconds and retry — never resend a submitted transaction.";
    }
    return first.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

export { zeroAddress };
