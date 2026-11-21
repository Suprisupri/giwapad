import "./style.css";
import {
  AMMORA_FEE_POLICY_VERSION,
  buildAmmoraPortableWrapTransaction,
  buildClaimFeeVaultFor,
  buildCreateAmmoraV4Config,
  buildCreateAmmoraV4Launch,
  classifyAmmoraV4ExactInputFill,
  DammV2Client,
  getAmmoraV4ConfigAtBlock,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  resolveAmmoraV4ConcentratedMigrationPositionsReceipt,
} from "@ammora-protocol/sdk";
import type {
  AmmoraV4ConfigSnapshot,
  AmmoraV4LaunchCurveState,
} from "@ammora-protocol/sdk";
import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import type { Account, Address, Hash, Hex } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT,
  EXPLORER,
  FAUCET_URL,
  LAUNCH,
  WETH,
  claimableInVault,
  connectWallet,
  curveClient,
  curveForToken,
  ensureApprovals,
  erc20Balance,
  errorMessage,
  ethBalance,
  ethereumProvider,
  explorerAddr,
  explorerTx,
  feeVault,
  fmt,
  freshBlock,
  paced,
  publicClient,
  sendTx,
  shortAddr,
  shortHash,
  tokenForCurve,
  tokenInfo,
  verifyDeployment,
  walletClient,
} from "./ammora.ts";
import {
  GIWAPAD_SALE_SUPPLY_RAW,
  GIWAPAD_THRESHOLD_RAW,
  GIWAPAD_TOKEN_DECIMALS,
  QUARANTINED_TEMPLATE_HASH,
  QUARANTINED_TEMPLATE_ID,
  TEMPLATE_CANDIDATES,
  buildMetadataURI,
  checkGraduationReadiness,
  planTeamConfig,
} from "./policy.ts";
import type { ReadinessCheck } from "./policy.ts";
import { store } from "./store.ts";
import type { StoredToken } from "./store.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type CurveProgress = {
  ready: boolean;
  migrated: boolean;
  current: bigint;
  target: bigint;
  progressBps: number;
  canonicalPool: Address;
  asOfBlock: bigint;
};

const S = {
  account: null as Account | null,
  chainId: null as number | null,
  eth: 0n,
  weth: 0n,
  deployStatus: "pending" as "pending" | "ok" | "failed",
  configValid: null as null | { id: bigint; hash: string },
  configPreview: null as null | {
    plan: ReturnType<typeof planTeamConfig>;
    template: AmmoraV4ConfigSnapshot;
    pinnedHash: Hex;
    checks: ReadinessCheck[];
    qualified: boolean;
  },
  tokens: store.getTokens(),
  tokenStatus: new Map<string, { status: number; progressBps: number }>(),
  selected: null as StoredToken | null,
  curveState: null as AmmoraV4LaunchCurveState | null,
  progress: null as CurveProgress | null,
  selectedInfo: null as { decimals: number; symbol: string; name: string } | null,
  baseBal: 0n,
  busy: false,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function setStatus(id: string, html: string, kind: "" | "error" | "ok" = ""): void {
  const el = $(id);
  el.className = `status ${kind}`;
  el.innerHTML = html;
}
function spin(msg: string): string {
  return `<span class="spinner">↻</span>${esc(msg)}`;
}
function statusName(status: number): string {
  return ["Uninitialized", "Active", "ReadyToMigrate", "Migrated"][status] ?? `Unknown (${status})`;
}
function statusBadge(status: number): string {
  const cls = status === 1 ? "ok" : status === 2 ? "warn" : status === 3 ? "info" : "bad";
  return `<span class="badge ${cls}">${statusName(status)}</span>`;
}
function addrLink(a: Address, short = true): string {
  return `<a class="mono" href="${explorerAddr(a)}" target="_blank" rel="noopener">${short ? shortAddr(a) : a}</a>`;
}
function txLink(h: string): string {
  return `<a class="mono" href="${explorerTx(h)}" target="_blank" rel="noopener">${shortHash(h)}</a>`;
}

/** Guard: one on-chain operation at a time (the RPC is slow and rate-limited). */
async function guarded<T>(label: string, statusId: string, fn: () => Promise<T>): Promise<T | null> {
  if (S.busy) {
    setStatus(statusId, "Another operation is running — wait for it to finish.", "error");
    return null;
  }
  S.busy = true;
  setStatus(statusId, spin(label));
  try {
    return await fn();
  } catch (e) {
    setStatus(statusId, esc(errorMessage(e)), "error");
    return null;
  } finally {
    S.busy = false;
  }
}

function requireAccount(statusId: string): Account | null {
  if (!S.account) {
    setStatus(statusId, "Connect your wallet first.", "error");
    return null;
  }
  return S.account;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<header>
  <div>
    <div class="brand">Giwa<span>Pad</span></div>
    <div class="tagline">Token launchpad on GIWA Sepolia · Ammora SDK 0.3.9 · testnet only</div>
  </div>
  <div class="row">
    <span id="net-badge" class="badge">GIWA Sepolia · 91342</span>
    <button id="connect-btn" type="button">Connect wallet</button>
  </div>
</header>
<main>
  <div class="notice danger"><strong>Testnet only.</strong> GiwaPad runs on GIWA Sepolia (chain 91342).
  All tokens, ETH and WETH here are valueless test assets — never send real funds.
  The public RPC is slow and rate-limited; reads can take 10–60s. Never resend a submitted transaction.</div>

  <div class="card" id="wallet-card">
    <h2>Wallet</h2>
    <p class="desc">Any EIP-1193 wallet (MetaMask / Rabby). GiwaPad never sees your keys — the SDK only plans, your wallet signs.</p>
    <div id="wallet-info"><span class="badge">Not connected</span></div>
    <div class="status" id="wallet-status"></div>
    <div class="status" id="deploy-status">${spin("Verifying Ammora core contracts against the SDK pins…")}</div>
  </div>

  <div class="card" id="config-card">
    <h2>1 · GiwaPad Config <span id="config-badge" class="badge">No Config yet</span></h2>
    <p class="desc">One reusable Config for every GiwaPad launch. It is derived from a reviewed
    on-chain template (Config #12, fallback #13) with a fully reconciled graduation budget:
    <strong>1,000,000 tokens</strong> sale supply, <strong>0.001 WETH</strong> graduation threshold,
    concentrated migration. The readiness check must pass before any signature is requested.
    The quarantined Config #6 policy is rejected outright.</p>
    <div id="config-status-line"></div>
    <div class="row" style="margin-top:10px">
      <button id="btn-preview-config" type="button" class="secondary">Preview policy + readiness check</button>
      <button id="btn-create-config" type="button" disabled>Create Config</button>
    </div>
    <div id="config-preview"></div>
    <div class="status" id="config-status"></div>
  </div>

  <div class="card" id="launch-card">
    <h2>2 · Launch a token</h2>
    <p class="desc">Issues a new token on the GiwaPad Config with its own bonding curve.
    The Config's pool creation fee is 0 — you pay gas only.</p>
    <div class="grid2">
      <div class="field"><label for="launch-name">Token name</label><input id="launch-name" maxlength="32" placeholder="e.g. Giwa Cat" /></div>
      <div class="field"><label for="launch-symbol">Symbol</label><input id="launch-symbol" maxlength="10" placeholder="e.g. GCAT" /></div>
    </div>
    <div class="field"><label for="launch-desc">Description (optional)</label><input id="launch-desc" maxlength="200" placeholder="What is this token?" /></div>
    <div class="field"><label for="launch-image">Image URL (optional)</label><input id="launch-image" maxlength="300" placeholder="https://…/image.png" /></div>
    <div class="field"><label for="launch-meta">Metadata URI override (optional — defaults to an inline data: URI)</label><input id="launch-meta" maxlength="500" placeholder="https://… or ipfs://…" /></div>
    <button id="btn-launch" type="button">Launch token</button>
    <div id="launch-result"></div>
    <div class="status" id="launch-status"></div>
  </div>

  <div class="card" id="tokens-card">
    <h2>3 · Tokens</h2>
    <p class="desc">Tokens launched through GiwaPad (stored in this browser) plus any Ammora V4
    token/curve you look up. Click a token to trade it.</p>
    <div class="row" style="margin-bottom:12px">
      <input id="lookup-input" placeholder="Paste a token or curve address (0x…)" style="flex:1" />
      <button id="btn-lookup" type="button" class="secondary">Look up</button>
      <button id="btn-refresh-tokens" type="button" class="secondary">Refresh states</button>
    </div>
    <div class="status" id="lookup-status"></div>
    <div id="token-list"></div>
  </div>

  <div class="card" id="trade-card" hidden>
    <h2>Trade <span id="trade-title"></span></h2>
    <div id="trade-body"></div>
    <div class="status" id="trade-status"></div>
  </div>

  <div class="card" id="claims-card">
    <h2>4 · Fee claims</h2>
    <p class="desc">Trading fees accrue to creators/partners in the Ammora FeeVault, and LP fees
    to migration position (NFT) owners. Claimable amounts are read live from the chain.</p>
    <div class="row"><button id="btn-refresh-claims" type="button" class="secondary">Refresh claimable</button></div>
    <div id="claims-body"><p class="desc">Connect your wallet and select a token, then refresh.</p></div>
    <div class="status" id="claims-status"></div>
  </div>

  <div class="card" id="activity-card">
    <h2>Activity</h2>
    <p class="desc">Transactions sent through GiwaPad in this browser.</p>
    <ul class="activity" id="activity-list"></ul>
  </div>
</main>
<footer>
  <p>GiwaPad · built with <a href="https://www.npmjs.com/package/@ammora-protocol/sdk" target="_blank" rel="noopener">@ammora-protocol/sdk 0.3.9</a> + viem on GIWA Sepolia (91342).
  <a href="https://docs.ammora.org" target="_blank" rel="noopener">Ammora docs</a> ·
  <a href="${EXPLORER}" target="_blank" rel="noopener">Explorer</a> ·
  <a href="${FAUCET_URL}" target="_blank" rel="noopener">Faucet</a></p>
  <p class="addrs mono">Registry ${LAUNCH.configRegistry}<br/>Factory ${LAUNCH.factory}<br/>Graduation adapter ${LAUNCH.graduationAdapter}<br/>Fee policy ${LAUNCH.feePolicy}<br/>WETH ${WETH}<br/>Deployment slot ${DEPLOYMENT.slot} · protocol v${LAUNCH.protocolVersion}</p>
  <p>All addresses above are read from the SDK deployment catalog at runtime. Testnet only — no real funds.</p>
</footer>
`;

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
function renderWallet(): void {
  const info = $("wallet-info");
  if (!S.account) {
    info.innerHTML = `<span class="badge">Not connected</span>`;
    $("connect-btn").textContent = "Connect wallet";
    return;
  }
  info.innerHTML = `
    <table class="kv">
      <tr><td>Address</td><td>${addrLink(S.account.address, false)}</td></tr>
      <tr><td>Test ETH</td><td><strong>${fmt(S.eth, 18)}</strong> ETH &nbsp;<a href="${FAUCET_URL}" target="_blank" rel="noopener">Get test ETH (faucet)</a></td></tr>
      <tr><td>WETH</td><td><strong>${fmt(S.weth, 18)}</strong> WETH <span style="color:var(--muted)">(buys on the curve spend WETH, not ETH)</span></td></tr>
    </table>
    <div class="row" style="margin-top:10px">
      <input id="wrap-amount" placeholder="ETH to wrap, e.g. 0.002" style="max-width:220px" />
      <button id="btn-wrap" type="button" class="secondary">Wrap ETH → WETH</button>
    </div>`;
  $("connect-btn").textContent = shortAddr(S.account.address);
  $("btn-wrap").addEventListener("click", () => void wrapEth());
}

async function refreshBalances(): Promise<void> {
  if (!S.account) return;
  const [eth, weth] = await Promise.all([
    ethBalance(S.account.address),
    erc20Balance(WETH, S.account.address),
  ]);
  S.eth = eth;
  S.weth = weth;
  renderWallet();
}

async function connect(): Promise<void> {
  await guarded("Connecting wallet…", "wallet-status", async () => {
    const { account, chainId } = await connectWallet();
    S.account = account;
    S.chainId = chainId;
    setStatus("wallet-status", `Connected as ${shortAddr(account.address)} on GIWA Sepolia.`, "ok");
    await refreshBalances();
    if (S.selected) await selectToken(S.selected, true);
  });
}

async function silentConnect(): Promise<void> {
  try {
    if (!ethereumProvider()) return;
    const wc = walletClient();
    const addrs = await wc.getAddresses();
    if (addrs.length === 0) return;
    const chainId = await wc.getChainId();
    if (chainId !== CHAIN_ID) {
      setStatus("wallet-status", `Wallet is on chain ${chainId}. Click Connect to switch to GIWA Sepolia (91342).`, "error");
      return;
    }
    S.account = { address: addrs[0]!, type: "json-rpc" } as Account;
    S.chainId = chainId;
    await refreshBalances();
  } catch {
    // Silent connect is best-effort; the Connect button remains.
  }
}

async function wrapEth(): Promise<void> {
  const account = requireAccount("wallet-status");
  if (!account) return;
  const raw = ($("wrap-amount") as HTMLInputElement).value.trim();
  let amount: bigint;
  try {
    amount = parseUnits(raw, 18);
  } catch {
    setStatus("wallet-status", "Invalid ETH amount.", "error");
    return;
  }
  if (amount <= 0n) {
    setStatus("wallet-status", "Amount must be positive.", "error");
    return;
  }
  if (amount >= S.eth) {
    setStatus("wallet-status", "Wrapping would leave no ETH for gas. Wrap less than your balance.", "error");
    return;
  }
  await guarded("Wrapping ETH…", "wallet-status", async () => {
    const tx = buildAmmoraPortableWrapTransaction(
      {
        kind: "WRAPPED_ERC20",
        nativeDecimals: 18,
        wrappedToken: WETH,
        wrappedTokenDecimals: 18,
        nativeRouter: DEPLOYMENT.contracts.routers.native,
      },
      amount,
    );
    const { hash } = await sendTx("Wrap ETH → WETH", tx, account, (m) =>
      setStatus("wallet-status", spin(m)),
    );
    store.addActivity({ label: `Wrap ${fmt(amount, 18)} ETH → WETH`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    setStatus("wallet-status", `Wrapped ${fmt(amount, 18)} ETH → WETH. ${txLink(hash)}`, "ok");
    await refreshBalances();
  });
}

// ---------------------------------------------------------------------------
// Deployment verification + Config revalidation (read-only, background)
// ---------------------------------------------------------------------------
async function verifyDeploymentBackground(): Promise<void> {
  try {
    await verifyDeployment();
    S.deployStatus = "ok";
    setStatus("deploy-status", "✓ Ammora core contracts verified against the SDK runtime pins (Registry, Factory, Graduation adapter, Fee policy).", "ok");
  } catch (e) {
    S.deployStatus = "failed";
    setStatus("deploy-status", `⚠ Deployment verification failed: ${esc(errorMessage(e))} (the RPC may be lagging — writes still simulate before signing).`, "error");
  }
}

async function revalidateStoredConfig(): Promise<void> {
  const stored = store.getConfig();
  const badge = $("config-badge");
  const line = $("config-status-line");
  if (!stored) {
    badge.textContent = "No Config yet";
    badge.className = "badge";
    line.innerHTML = "";
    return;
  }
  badge.textContent = `Config #${stored.configId} — revalidating…`;
  badge.className = "badge";
  try {
    const block = await freshBlock();
    const snap = await paced(() =>
      getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, BigInt(stored.configId), block),
    );
    if (
      snap.configId === QUARANTINED_TEMPLATE_ID ||
      snap.configHash.toLowerCase() === QUARANTINED_TEMPLATE_HASH.toLowerCase()
    ) {
      store.clearConfig();
      badge.textContent = "Blocked";
      badge.className = "badge bad";
      line.innerHTML = `<div class="notice danger">Stored Config #${stored.configId} matches the quarantined Config #6 identity. It was removed and will not be used.</div>`;
      return;
    }
    if (!snap.enabled) {
      badge.textContent = `Config #${stored.configId} — disabled`;
      badge.className = "badge bad";
      line.innerHTML = `<div class="notice danger">Config #${stored.configId} is disabled on-chain and cannot be launched on. Create a new Config.</div>`;
      return;
    }
    if (snap.configHash.toLowerCase() !== stored.configHash.toLowerCase()) {
      badge.textContent = `Config #${stored.configId} — hash mismatch`;
      badge.className = "badge bad";
      line.innerHTML = `<div class="notice danger">On-chain hash for Config #${stored.configId} does not match the stored hash. Create a new Config.</div>`;
      return;
    }
    S.configValid = { id: snap.configId, hash: snap.configHash };
    badge.textContent = `Config #${stored.configId} ready`;
    badge.className = "badge ok";
    line.innerHTML = `<table class="kv">
      <tr><td>Config ID</td><td>#${stored.configId}</td></tr>
      <tr><td>Config hash</td><td class="mono">${stored.configHash.slice(0, 18)}…</td></tr>
      <tr><td>Created</td><td>${txLink(stored.txHash)} · block ${stored.blockNumber}</td></tr>
      <tr><td>Policy</td><td>1,000,000 tokens sale · 0.001 WETH threshold · concentrated migration · 9 decimals</td></tr>
    </table>`;
  } catch (e) {
    badge.textContent = `Config #${stored.configId} — could not revalidate`;
    badge.className = "badge warn";
    line.innerHTML = `<div class="notice">Could not re-read Config #${stored.configId} (${esc(errorMessage(e))}). Launching is blocked until it revalidates — reload to retry.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Config: preview + create
// ---------------------------------------------------------------------------
async function previewConfig(): Promise<void> {
  const account = requireAccount("config-status");
  if (!account) return;
  await guarded("Reading derivation template from the Registry…", "config-status", async () => {
    const block = await freshBlock();
    let template: AmmoraV4ConfigSnapshot | null = null;
    let pinnedHash: Hex | null = null;
    let lastErr = "";
    for (const cand of TEMPLATE_CANDIDATES) {
      try {
        const snap = await paced(() =>
          getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, cand.id, block),
        );
        if (snap.configId === QUARANTINED_TEMPLATE_ID || snap.configHash.toLowerCase() === QUARANTINED_TEMPLATE_HASH.toLowerCase()) {
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
      }
    }
    if (!template || !pinnedHash) {
      throw new Error(`No usable derivation template (tried #12, #13): ${lastErr}`);
    }
    const plan = planTeamConfig(
      template,
      {
        configOwner: account.address,
        partnerRecipient: account.address,
        liquidityPartner: account.address,
        leftoverReceiver: account.address,
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
    S.configPreview = { plan, template, pinnedHash, checks, qualified };
    renderConfigPreview();
    setStatus(
      "config-status",
      qualified
        ? "Policy qualified: all readiness checks pass. Review below, then Create Config."
        : "Policy NOT qualified — creation is blocked. See the failed checks below.",
      qualified ? "ok" : "error",
    );
  });
}

function renderConfigPreview(): void {
  const el = $("config-preview");
  const btn = $("btn-create-config") as HTMLButtonElement;
  const p = S.configPreview;
  if (!p) {
    el.innerHTML = "";
    btn.disabled = true;
    return;
  }
  const { plan, template, checks, qualified } = p;
  const ec = plan.economics;
  el.innerHTML = `
    <h3>Policy preview — derived from template Config #${template.configId} (block ${template.asOfBlock})</h3>
    <table class="kv">
      <tr><td>Template hash</td><td class="mono">${template.configHash.slice(0, 18)}… (pinned ✓)</td></tr>
      <tr><td>Sale supply</td><td>1,000,000 tokens (${ec.saleAllocationRaw.toString()} raw, 9 decimals)</td></tr>
      <tr><td>Graduation threshold</td><td>0.001 WETH (${GIWAPAD_THRESHOLD_RAW.toString()} raw)</td></tr>
      <tr><td>Total supply</td><td>${fmt(ec.totalSupplyRaw, 9)} tokens (${ec.totalSupplyRaw.toString()} raw)</td></tr>
      <tr><td>Migration base (derived)</td><td>${fmt(ec.grossMigrationBaseRaw, 9)} tokens — migrationBaseThreshold is set to this, never zero</td></tr>
      <tr><td>Migration quote</td><td>${fmt(ec.grossMigrationQuoteRaw, 18)} WETH · surplus to protocol ${fmt(ec.quoteSurplusToProtocolRaw, 18)} WETH · locked base ${fmt(ec.lockedBaseRaw, 9)}</td></tr>
      <tr><td>Owner / partner / LP / leftover</td><td class="mono">${shortAddr(plan.recipients.configOwner)} (your wallet — all roles)</td></tr>
      <tr><td>Review hash</td><td class="mono">${plan.reviewHash}</td></tr>
    </table>
    <h3>Graduation readiness</h3>
    <ul class="checks">
      ${checks.map((c) => `<li class="${c.pass ? "pass" : "fail"}">${esc(c.label)} — <span style="color:var(--muted)">${esc(c.detail)}</span></li>`).join("")}
    </ul>`;
  btn.disabled = !qualified;
}

async function createConfig(): Promise<void> {
  const account = requireAccount("config-status");
  if (!account) return;
  const preview = S.configPreview;
  if (!preview || !preview.qualified) {
    setStatus("config-status", "Run the preview first — creation requires a qualified policy.", "error");
    return;
  }
  await guarded("Creating Config…", "config-status", async () => {
    const { hash, receipt } = await sendTx("Create Config", preview.plan.transaction, account, (m) =>
      setStatus("config-status", spin(m)),
    );
    store.addActivity({ label: "Create GiwaPad Config", hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    const created = parseAmmoraV4ConfigCreatedReceipt(receipt, LAUNCH.configRegistry);
    // Receipt-bound verification (as in the Ammora examples): re-read the Config
    // at the receipt block and confirm the calldata, hash, owner and fee claimer
    // match the reviewed plan exactly.
    const confirmed = await paced(() =>
      getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, created.configId, receipt.blockNumber),
    );
    const rebuilt = buildCreateAmmoraV4Config(confirmed.config, confirmed.segments, account.address);
    if (
      rebuilt.data !== preview.plan.transaction.data ||
      confirmed.configHash !== created.configHash ||
      confirmed.identity.owner.toLowerCase() !== account.address.toLowerCase() ||
      confirmed.identity.feeClaimer.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("Receipt-bound Config does not match the reviewed policy — do not use it. See BUILD-NOTES.");
    }
    store.setConfig({
      configId: created.configId.toString(),
      configHash: created.configHash,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      createdAt: Date.now(),
    });
    S.configPreview = null;
    renderConfigPreview();
    setStatus("config-status", `Config #${created.configId} created. ${txLink(hash)}`, "ok");
    await revalidateStoredConfig();
  });
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
async function launchToken(): Promise<void> {
  const account = requireAccount("launch-status");
  if (!account) return;
  if (!S.configValid) {
    setStatus("launch-status", "No validated GiwaPad Config yet — create one in step 1 first.", "error");
    return;
  }
  const name = ($("launch-name") as HTMLInputElement).value.trim();
  const symbol = ($("launch-symbol") as HTMLInputElement).value.trim().toUpperCase();
  const description = ($("launch-desc") as HTMLInputElement).value.trim();
  const image = ($("launch-image") as HTMLInputElement).value.trim();
  const metaOverride = ($("launch-meta") as HTMLInputElement).value.trim();
  if (!name || !symbol) {
    setStatus("launch-status", "Token name and symbol are required.", "error");
    return;
  }
  if (!/^[A-Za-z0-9 ]+$/.test(symbol)) {
    setStatus("launch-status", "Symbol must be letters and digits only.", "error");
    return;
  }
  const metadataURI = metaOverride || buildMetadataURI({ name, symbol, description, image });
  await guarded("Reading Config + building launch…", "launch-status", async () => {
    const block = await freshBlock();
    const entry = await paced(() =>
      getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, S.configValid!.id, block),
    );
    if (!entry.enabled) throw new Error(`Config #${S.configValid!.id} is disabled.`);
    if (entry.config.tokenDecimals !== GIWAPAD_TOKEN_DECIMALS) {
      throw new Error("Config token decimals do not match the GiwaPad policy.");
    }
    const tx = buildCreateAmmoraV4Launch(
      { name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: GIWAPAD_TOKEN_DECIMALS },
      S.configValid!.id,
      entry.config.poolCreationFee,
    );
    const { hash, receipt } = await sendTx(
      "Launch token",
      { to: LAUNCH.factory, data: tx.data, value: tx.value },
      account,
      (m) => setStatus("launch-status", spin(m)),
    );
    store.addActivity({ label: `Launch ${name} (${symbol})`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    const created = parseAmmoraV4LaunchCreatedReceipt(receipt, LAUNCH.factory);
    if (created.configId !== S.configValid!.id || created.configHash !== entry.configHash) {
      throw new Error("Launch receipt does not match the selected Config — do not trust the token addresses below.");
    }
    const token: StoredToken = {
      token: created.token,
      curve: created.curve,
      name,
      symbol,
      decimals: GIWAPAD_TOKEN_DECIMALS,
      configId: created.configId.toString(),
      launchTx: hash,
      launchBlock: receipt.blockNumber.toString(),
      imported: false,
    };
    store.upsertToken(token);
    S.tokens = store.getTokens();
    renderTokenList();
    $("launch-result").innerHTML = `
      <h3>Launched ${esc(name)} (${esc(symbol)})</h3>
      <table class="kv">
        <tr><td>Token</td><td>${addrLink(created.token, false)}</td></tr>
        <tr><td>Curve</td><td>${addrLink(created.curve, false)}</td></tr>
        <tr><td>Config</td><td>#${created.configId}</td></tr>
        <tr><td>Transaction</td><td>${txLink(hash)}</td></tr>
      </table>`;
    setStatus("launch-status", `Token launched. ${txLink(hash)}`, "ok");
    await selectToken(token, true);
  });
}

// ---------------------------------------------------------------------------
// Token list + lookup
// ---------------------------------------------------------------------------
function renderTokenList(): void {
  const el = $("token-list");
  if (S.tokens.length === 0) {
    el.innerHTML = `<p class="desc">No tokens yet. Launch one above, or look up an existing Ammora V4 token/curve.</p>`;
    return;
  }
  el.innerHTML = S.tokens
    .map((t) => {
      const st = S.tokenStatus.get(t.curve.toLowerCase());
      const selected = S.selected?.curve.toLowerCase() === t.curve.toLowerCase();
      return `<div class="token-row ${selected ? "selected" : ""}" data-curve="${t.curve}">
        <div>
          <div class="name">${esc(t.name)} (${esc(t.symbol)})</div>
          <div class="sub">token ${shortAddr(t.token)} · curve ${shortAddr(t.curve)} · Config #${t.configId}${t.imported ? " · imported" : ""}</div>
          <div class="sub"><a class="mono" href="${explorerAddr(t.token)}" target="_blank" rel="noopener">explorer: token</a> · <a class="mono" href="${explorerAddr(t.curve)}" target="_blank" rel="noopener">curve</a>${t.canonicalPool ? ` · <a class="mono" href="${explorerAddr(t.canonicalPool)}" target="_blank" rel="noopener">pool</a>` : ""}</div>
        </div>
        <div>${st ? `${statusBadge(st.status)}<div class="sub">${(st.progressBps / 100).toFixed(1)}% to graduation</div>` : `<span class="badge">state unknown</span>`}</div>
      </div>`;
    })
    .join("");
  el.querySelectorAll<HTMLElement>(".token-row").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).tagName === "A") return;
      const t = S.tokens.find((x) => x.curve === row.dataset.curve);
      if (t) void selectToken(t);
    });
  });
}

async function lookupAddress(): Promise<void> {
  const raw = ($("lookup-input") as HTMLInputElement).value.trim();
  if (!isAddress(raw)) {
    setStatus("lookup-status", "Enter a valid 0x address.", "error");
    return;
  }
  const addr = getAddress(raw);
  await guarded("Resolving address on-chain…", "lookup-status", async () => {
    const code = await paced(() => publicClient.getCode({ address: addr }));
    if (!code || code === "0x") throw new Error("No contract at that address on GIWA Sepolia.");
    const block = await freshBlock();
    let curve: Address | null = null;
    let state: AmmoraV4LaunchCurveState | null = null;
    // Try it as a curve first.
    try {
      const st = await paced(() => curveClient(addr).getStateAtBlock(block));
      const bound = await tokenForCurve(addr);
      if (
        bound !== zeroAddress &&
        bound.toLowerCase() === st.baseToken.toLowerCase() &&
        st.feePolicy.toLowerCase() === LAUNCH.feePolicy.toLowerCase() &&
        st.feePolicyVersion === AMMORA_FEE_POLICY_VERSION
      ) {
        curve = addr;
        state = st;
      }
    } catch {
      // Not a curve — fall through to the token path.
    }
    if (!curve || !state) {
      const c = await curveForToken(addr);
      if (c === zeroAddress) {
        throw new Error("That address is neither an Ammora V4 curve nor a launched token (factory has no curve for it).");
      }
      const st = await paced(() => curveClient(c).getStateAtBlock(block));
      if (
        st.feePolicy.toLowerCase() !== LAUNCH.feePolicy.toLowerCase() ||
        st.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
      ) {
        throw new Error("Curve is not bound to the reviewed V4 factory and fee policy.");
      }
      curve = c;
      state = st;
    }
    const info = await tokenInfo(state.baseToken);
    const existing = S.tokens.find((x) => x.curve.toLowerCase() === curve!.toLowerCase());
    const token: StoredToken = {
      token: state.baseToken,
      curve,
      name: existing?.name ?? info.name,
      symbol: existing?.symbol ?? info.symbol,
      decimals: info.decimals,
      configId: state.configId.toString(),
      launchTx: existing?.launchTx ?? ("0x" as Hash),
      launchBlock: existing?.launchBlock ?? "0",
      canonicalPool: state.canonicalPool !== zeroAddress ? state.canonicalPool : existing?.canonicalPool,
      imported: existing?.imported ?? true,
    };
    store.upsertToken(token);
    S.tokens = store.getTokens();
    renderTokenList();
    setStatus("lookup-status", `Found ${esc(info.name)} (${esc(info.symbol)}) — ${statusName(state.status)}.`, "ok");
    await selectToken(token, true);
  });
}

async function refreshAllTokenStates(): Promise<void> {
  if (S.tokens.length === 0) {
    setStatus("lookup-status", "No tokens to refresh.", "error");
    return;
  }
  await guarded("Refreshing token states…", "lookup-status", async () => {
    const block = await freshBlock();
    for (let i = 0; i < S.tokens.length; i++) {
      const t = S.tokens[i]!;
      setStatus("lookup-status", spin(`Refreshing ${i + 1}/${S.tokens.length}: ${t.symbol}…`));
      try {
        const [state, progress] = await paced(() =>
          Promise.all([
            curveClient(t.curve).getStateAtBlock(block),
            curveClient(t.curve).getMigrationProgressAtBlock(block),
          ]),
        );
        S.tokenStatus.set(t.curve.toLowerCase(), { status: state.status, progressBps: progress.progressBps });
        if (state.status === 3 && state.canonicalPool !== zeroAddress && t.canonicalPool !== state.canonicalPool) {
          store.upsertToken({ ...t, canonicalPool: state.canonicalPool });
          S.tokens = store.getTokens();
        }
      } catch (e) {
        S.tokenStatus.set(t.curve.toLowerCase(), { status: -1, progressBps: 0 });
        console.warn(`refresh failed for ${t.curve}:`, e);
      }
      renderTokenList();
    }
    setStatus("lookup-status", `Refreshed ${S.tokens.length} token(s) at block ${block}.`, "ok");
  });
}

// ---------------------------------------------------------------------------
// Trade panel
// ---------------------------------------------------------------------------
async function selectToken(t: StoredToken, force = false): Promise<void> {
  if (!force && S.selected?.curve === t.curve && S.curveState) return;
  S.selected = t;
  S.curveState = null;
  S.progress = null;
  ($("trade-card") as HTMLElement).hidden = false;
  $("trade-title").textContent = `${t.name} (${t.symbol})`;
  $("trade-body").innerHTML = `<p class="desc">${spin("Loading live curve state…")}</p>`;
  setStatus("trade-status", "");
  renderTokenList();
  try {
    const block = await freshBlock();
    const client = curveClient(t.curve);
    const [state, progress, info] = await paced(() =>
      Promise.all([
        client.getStateAtBlock(block),
        client.getMigrationProgressAtBlock(block),
        tokenInfo(t.token),
      ]),
    );
    // Authenticate the curve against the reviewed factory before displaying it.
    const bound = await tokenForCurve(t.curve);
    if (
      bound === zeroAddress ||
      bound.toLowerCase() !== state.baseToken.toLowerCase() ||
      state.feePolicy.toLowerCase() !== LAUNCH.feePolicy.toLowerCase() ||
      state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
    ) {
      throw new Error("Curve is not bound to the reviewed V4 factory and fee policy.");
    }
    S.curveState = state;
    S.progress = progress;
    S.selectedInfo = info;
    S.tokenStatus.set(t.curve.toLowerCase(), { status: state.status, progressBps: progress.progressBps });
    if (S.account) {
      S.baseBal = await erc20Balance(t.token, S.account.address);
      await refreshBalances();
    }
    renderTokenList();
    renderTrade();
  } catch (e) {
    $("trade-body").innerHTML = `<div class="notice danger">Could not load curve state: ${esc(errorMessage(e))}</div>`;
  }
}

function renderTrade(): void {
  const t = S.selected;
  const st = S.curveState;
  const pg = S.progress;
  const info = S.selectedInfo;
  if (!t || !st || !pg || !info) return;
  const isCreator = S.account?.address.toLowerCase() === st.creator.toLowerCase();
  const pct = (pg.progressBps / 100).toFixed(2);
  $("trade-body").innerHTML = `
    <div class="row" style="margin-bottom:10px">${statusBadge(st.status)}
      <span class="badge">Config #${st.configId}</span>
      <span class="badge">block ${st.asOfBlock}</span>
      <button id="btn-refresh-trade" type="button" class="secondary small">Refresh</button>
    </div>
    <table class="kv">
      <tr><td>Token</td><td>${addrLink(st.baseToken, false)} (${esc(info.symbol)}, ${info.decimals} dec)</td></tr>
      <tr><td>Curve</td><td>${addrLink(t.curve, false)}</td></tr>
      <tr><td>Creator</td><td>${addrLink(st.creator)}${isCreator ? " (you)" : ""}</td></tr>
      <tr><td>Quote reserve</td><td>${fmt(st.quoteReserve, 18)} WETH</td></tr>
      <tr><td>Base reserve</td><td>${fmt(st.baseReserve, info.decimals)} ${esc(info.symbol)}</td></tr>
      <tr><td>Graduation threshold</td><td>${fmt(st.migrationQuoteThreshold, 18)} WETH · migration base ${fmt(st.migrationBaseThreshold, info.decimals)} ${esc(info.symbol)}</td></tr>
      <tr><td>Fee</td><td>${st.currentFeeBps} bps${st.currentDynamicFeeBps ? ` (+${st.currentDynamicFeeBps} dynamic)` : ""}</td></tr>
      ${st.status === 3 ? `<tr><td>Canonical pool</td><td>${addrLink(st.canonicalPool, false)}</td></tr>` : ""}
    </table>
    <h3>Graduation progress — ${pct}%</h3>
    <div class="progress"><div style="width:${Math.min(100, pg.progressBps / 100)}%"></div></div>
    <p class="desc">${fmt(pg.current, 18)} / ${fmt(pg.target, 18)} WETH ${pg.ready ? "— ready to migrate" : pg.migrated ? "— migrated" : ""}</p>
    <h3>Your balances</h3>
    <p class="desc">WETH <strong>${fmt(S.weth, 18)}</strong> · ${esc(info.symbol)} <strong>${fmt(S.baseBal, info.decimals)}</strong> · ETH <strong>${fmt(S.eth, 18)}</strong>
    ${S.account ? "" : "(connect your wallet to see balances)"}</p>
    ${st.status === 1 ? `
    <div class="grid2">
      <div>
        <h3>Buy with WETH</h3>
        <div class="field"><input id="buy-amount" placeholder="WETH amount, e.g. 0.0001" inputmode="decimal" /></div>
        <div id="buy-quote" class="status"></div>
        <button id="btn-buy" type="button">Buy ${esc(info.symbol)}</button>
      </div>
      <div>
        <h3>Sell ${esc(info.symbol)}</h3>
        <div class="field"><input id="sell-amount" placeholder="Token amount, e.g. 1000" inputmode="decimal" /></div>
        <div id="sell-quote" class="status"></div>
        <button id="btn-sell" type="button" class="secondary">Sell for WETH</button>
      </div>
    </div>
    <p class="desc" style="margin-top:8px">Slippage 1%. Quotes are live SDK quotes at a fresh block; the trade re-quotes and simulates before signing.</p>
    ` : st.status === 2 ? `
    <div class="notice"><strong>Ready to migrate.</strong> The curve is full — no more curve trades. Migration is a separate permissionless transaction (anyone can pay the gas).</div>
    <button id="btn-migrate" type="button">Migrate to ARL pool</button>
    ` : st.status === 3 ? `
    <div class="notice">This token graduated. Curve trading is closed; trade on the canonical ARL pool instead: ${addrLink(st.canonicalPool, false)}</div>
    ` : `
    <div class="notice danger">Curve status is ${statusName(st.status)} — trading is unavailable.</div>`}
    ${isCreator ? `
    <hr class="sep" />
    <h3>Creator actions</h3>
    <div class="row">
      <button id="btn-claim-surplus" type="button" class="secondary small">Claim surplus</button>
      <button id="btn-withdraw-leftover" type="button" class="secondary small">Withdraw leftover</button>
    </div>
    <p class="desc">Surplus/leftover claims are creator-only and only meaningful after graduation (leftover) or when surplus exists.</p>` : ""}
  `;
  $("btn-refresh-trade").addEventListener("click", () => void selectToken(t, true));
  const buyInput = document.getElementById("buy-amount") as HTMLInputElement | null;
  const sellInput = document.getElementById("sell-amount") as HTMLInputElement | null;
  if (buyInput) {
    buyInput.addEventListener("input", () => scheduleQuote("buy"));
    $("btn-buy").addEventListener("click", () => void executeTrade("buy"));
  }
  if (sellInput) {
    sellInput.addEventListener("input", () => scheduleQuote("sell"));
    $("btn-sell").addEventListener("click", () => void executeTrade("sell"));
  }
  const migrateBtn = document.getElementById("btn-migrate");
  if (migrateBtn) migrateBtn.addEventListener("click", () => void migrate());
  const surplusBtn = document.getElementById("btn-claim-surplus");
  if (surplusBtn) surplusBtn.addEventListener("click", () => void creatorClaim("surplus"));
  const leftoverBtn = document.getElementById("btn-withdraw-leftover");
  if (leftoverBtn) leftoverBtn.addEventListener("click", () => void creatorClaim("leftover"));
}

let quoteTimer: ReturnType<typeof setTimeout> | null = null;
let quoteSeq = 0;
function scheduleQuote(side: "buy" | "sell"): void {
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => void refreshQuote(side), 700);
}

async function refreshQuote(side: "buy" | "sell"): Promise<void> {
  const t = S.selected;
  const st = S.curveState;
  const info = S.selectedInfo;
  const mySeq = ++quoteSeq;
  const boxId = side === "buy" ? "buy-quote" : "sell-quote";
  const inputId = side === "buy" ? "buy-amount" : "sell-amount";
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!t || !st || !info || !input) return;
  const raw = input.value.trim();
  if (!raw) {
    setStatus(boxId, "");
    return;
  }
  let amountIn: bigint;
  try {
    amountIn = parseUnits(raw, side === "buy" ? 18 : info.decimals);
  } catch {
    setStatus(boxId, "Invalid amount.", "error");
    return;
  }
  if (amountIn <= 0n) {
    setStatus(boxId, "Amount must be positive.", "error");
    return;
  }
  if (st.status !== 1) {
    setStatus(boxId, "Curve is not Active — no quote.", "error");
    return;
  }
  setStatus(boxId, spin("Quoting…"));
  try {
    const block = await freshBlock();
    const quote = await paced(() =>
      curveClient(t.curve).quoteExactInputAtBlock(amountIn, side === "sell", block),
    );
    if (mySeq !== quoteSeq) return; // superseded by a newer keystroke
    const fill = classifyAmmoraV4ExactInputFill(quote, side === "sell");
    const outDec = side === "buy" ? info.decimals : 18;
    const outSym = side === "buy" ? info.symbol : "WETH";
    const feeDec = side === "buy" ? 18 : info.decimals;
    const feeSym = side === "buy" ? "WETH" : info.symbol;
    let note = "";
    if (fill.kind === "graduation-boundary") {
      note = `<br/><strong>Final buy:</strong> consumes ${fmt(fill.consumedAmountIn, 18)} WETH, ${fmt(fill.refundableAmountIn, 18)} WETH stays in your wallet. Migration is a separate step after this.`;
    } else if (fill.kind !== "full") {
      note = `<br/><span style="color:var(--danger)">This order would ${fill.kind} — it will be rejected. Reduce the amount.</span>`;
    }
    setStatus(
      boxId,
      `You receive ≈ <strong>${fmt(quote.amountOut, outDec)} ${esc(outSym)}</strong> · fee ${fmt(quote.fee, feeDec)} ${esc(feeSym)}${note}`,
      fill.kind === "full" || fill.kind === "graduation-boundary" ? "ok" : "error",
    );
  } catch (e) {
    if (mySeq !== quoteSeq) return;
    setStatus(boxId, esc(errorMessage(e)), "error");
  }
}

async function executeTrade(side: "buy" | "sell"): Promise<void> {
  const account = requireAccount("trade-status");
  if (!account) return;
  const t = S.selected;
  const info = S.selectedInfo;
  if (!t || !info) return;
  const input = document.getElementById(side === "buy" ? "buy-amount" : "sell-amount") as HTMLInputElement | null;
  const raw = input?.value.trim() ?? "";
  let amountIn: bigint;
  try {
    amountIn = parseUnits(raw, side === "buy" ? 18 : info.decimals);
  } catch {
    setStatus("trade-status", "Invalid amount.", "error");
    return;
  }
  if (amountIn <= 0n) {
    setStatus("trade-status", "Amount must be positive.", "error");
    return;
  }
  if (side === "buy" && amountIn > S.weth) {
    setStatus("trade-status", `Not enough WETH (${fmt(S.weth, 18)}). Wrap ETH first (Wallet section).`, "error");
    return;
  }
  if (side === "sell" && amountIn > S.baseBal) {
    setStatus("trade-status", `Not enough ${info.symbol} (${fmt(S.baseBal, info.decimals)}).`, "error");
    return;
  }
  const baseForQuote = side === "sell";
  await guarded(side === "buy" ? "Planning buy…" : "Planning sell…", "trade-status", async () => {
    const client = curveClient(t.curve);
    const block = await freshBlock();
    const state = await paced(() => client.getStateAtBlock(block));
    if (state.status !== 1) throw new Error(`Curve is ${statusName(state.status)}, not Active.`);
    const quote = await paced(() => client.quoteExactInputAtBlock(amountIn, baseForQuote, block));
    const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
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
        recipient: account.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      }),
    );
    const planFill = classifyAmmoraV4ExactInputFill(plan.quote, baseForQuote);
    if (planFill.kind !== fill.kind) {
      throw new Error(`Curve state moved between quote and plan (${fill.kind} → ${planFill.kind}). Retry.`);
    }
    await ensureApprovals(plan.approvalRequirements, account, (m) => setStatus("trade-status", spin(m)));
    const { hash, receipt } = await sendTx(
      side === "buy" ? "Buy" : "Sell",
      plan.transaction,
      account,
      (m) => setStatus("trade-status", spin(m)),
    );
    const parsed = parseAmmoraV4SwapReceipt(receipt, t.curve, {
      trader: account.address,
      recipient: account.address,
      baseForQuote,
      requestedAmountIn: amountIn,
      minimumAmountOut: plan.quote.minimumAmountOut,
    });
    store.addActivity({
      label: `${side === "buy" ? "Buy" : "Sell"} ${info.symbol} (${fmt(parsed.consumedAmountIn, side === "buy" ? 18 : info.decimals)} in)`,
      hash,
      ts: Date.now(),
      status: "confirmed",
    });
    renderActivity();
    const outDec = side === "buy" ? info.decimals : 18;
    const outSym = side === "buy" ? info.symbol : "WETH";
    setStatus(
      "trade-status",
      `${side === "buy" ? "Bought" : "Sold"}: received ${fmt(parsed.amountOut, outDec)} ${esc(outSym)} · consumed ${fmt(parsed.consumedAmountIn, side === "buy" ? 18 : info.decimals)} · fee ${fmt(parsed.fee, side === "buy" ? 18 : info.decimals)} · left ${fmt(parsed.amountLeft, side === "buy" ? 18 : info.decimals)}. ${txLink(hash)}`,
      "ok",
    );
    await selectToken(t, true);
  });
}

async function migrate(): Promise<void> {
  const account = requireAccount("trade-status");
  if (!account) return;
  const t = S.selected;
  if (!t) return;
  await guarded("Planning migration…", "trade-status", async () => {
    const client = curveClient(t.curve);
    const block = await freshBlock();
    const state = await paced(() => client.getStateAtBlock(block));
    if (state.status === 3) {
      setStatus("trade-status", `Already migrated to ${addrLink(state.canonicalPool, false)}.`, "ok");
      return;
    }
    if (state.status !== 2) {
      throw new Error(`Migration requires ReadyToMigrate (2); curve is ${statusName(state.status)}.`);
    }
    const plan = await paced(() => client.planMigrateAtBlock(block));
    const { hash, receipt } = await sendTx("Migrate", plan.transaction, account, (m) =>
      setStatus("trade-status", spin(m)),
    );
    store.addActivity({ label: `Migrate ${t.symbol} to ARL`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    const migrated = parseAmmoraV4MigratedReceipt(receipt, t.curve);
    const after = await paced(() => client.getStateAtBlock(receipt.blockNumber));
    if (after.status !== 3 || after.canonicalPool.toLowerCase() !== migrated.canonicalPool.toLowerCase()) {
      throw new Error("Migration event/state mismatch — reconcile before continuing.");
    }
    // Resolve the LP (Manager NFT) positions created by migration.
    let positions: StoredToken["positions"] = t.positions;
    try {
      const cfg = await paced(() =>
        getAmmoraV4ConfigAtBlock(publicClient, LAUNCH.configRegistry, state.configId, receipt.blockNumber),
      );
      const resolved = resolveAmmoraV4ConcentratedMigrationPositionsReceipt({
        chainId: CHAIN_ID,
        receipt,
        expectedTransactionHash: hash,
        curve: t.curve,
        positionManager: LAUNCH.concentratedPositionManager,
        canonicalPool: migrated.canonicalPool,
        creator: state.creator,
        partner: cfg.config.liquidityDistribution.partner,
      });
      positions = resolved.positions.map((p) => ({ tokenId: p.tokenId.toString(), owner: p.owner }));
    } catch (e) {
      console.warn("migration positions could not be resolved from the receipt:", e);
    }
    store.upsertToken({ ...t, canonicalPool: migrated.canonicalPool, migrationTx: hash, positions });
    S.tokens = store.getTokens();
    S.selected = S.tokens.find((x) => x.curve === t.curve) ?? t;
    renderTokenList();
    setStatus(
      "trade-status",
      `Migrated to ARL pool ${addrLink(migrated.canonicalPool, false)} · base ${fmt(migrated.baseAmount, S.selectedInfo?.decimals ?? 9)} · quote ${fmt(migrated.quoteAmount, 18)} WETH. ${txLink(hash)}`,
      "ok",
    );
    await selectToken(S.selected, true);
  });
}

async function creatorClaim(kind: "surplus" | "leftover"): Promise<void> {
  const account = requireAccount("trade-status");
  if (!account) return;
  const t = S.selected;
  if (!t) return;
  await guarded(kind === "surplus" ? "Claiming surplus…" : "Withdrawing leftover…", "trade-status", async () => {
    const client = curveClient(t.curve);
    const plan =
      kind === "surplus"
        ? await paced(() => client.planClaimSurplus(account.address))
        : await paced(() => client.planWithdrawLeftover(account.address));
    const { hash } = await sendTx(kind === "surplus" ? "Claim surplus" : "Withdraw leftover", plan.transaction, account, (m) =>
      setStatus("trade-status", spin(m)),
    );
    store.addActivity({ label: `${kind === "surplus" ? "Claim surplus" : "Withdraw leftover"} (${t.symbol})`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    setStatus("trade-status", `${kind === "surplus" ? "Surplus claimed" : "Leftover withdrawn"}. ${txLink(hash)}`, "ok");
    await selectToken(t, true);
  });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------
const ERC721_OWNER_ABI = [
  { type: "function", name: "ownerOf", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

async function refreshClaims(): Promise<void> {
  const account = requireAccount("claims-status");
  if (!account) return;
  await guarded("Reading claimable fees…", "claims-status", async () => {
    const vault = await feeVault();
    const wethClaimable = await claimableInVault(WETH, account.address);
    const t = S.selected;
    let baseClaimable = 0n;
    if (t) baseClaimable = await claimableInVault(t.token, account.address);
    let lpRows = "";
    if (t?.canonicalPool && t.positions?.length) {
      const rows: string[] = [];
      for (const p of t.positions) {
        let owner: Address = p.owner;
        try {
          owner = (await paced(() =>
            publicClient.readContract({
              address: LAUNCH.concentratedPositionManager,
              abi: ERC721_OWNER_ABI,
              functionName: "ownerOf",
              args: [BigInt(p.tokenId)],
            }),
          )) as Address;
        } catch {
          // Position may have been burned/transferred; keep the stored owner.
        }
        const mine = owner.toLowerCase() === account.address.toLowerCase();
        rows.push(`<tr><td>LP position #${p.tokenId}</td><td>owner ${addrLink(owner)}${mine ? " (you)" : ""}</td><td>${mine ? `<button type="button" class="small" data-lp-claim="${p.tokenId}">Claim LP fees</button>` : "—"}</td></tr>`);
      }
      lpRows = rows.join("");
    }
    $("claims-body").innerHTML = `
      <table class="kv">
        <tr><td>FeeVault</td><td>${addrLink(vault, false)}</td></tr>
        <tr><td>WETH claimable (creator/partner)</td><td><strong>${fmt(wethClaimable, 18)} WETH</strong> ${wethClaimable > 0n ? `<button type="button" class="small" id="btn-claim-weth">Claim</button>` : ""}</td></tr>
        ${t ? `<tr><td>${esc(t.symbol)} claimable (creator/partner)</td><td><strong>${fmt(baseClaimable, t.decimals)} ${esc(t.symbol)}</strong> ${baseClaimable > 0n ? `<button type="button" class="small" id="btn-claim-base">Claim</button>` : ""}</td></tr>` : `<tr><td>Base-token fees</td><td>Select a token to check its base-token claimable.</td></tr>`}
        ${lpRows}
      </table>
      ${t?.canonicalPool && !t.positions?.length ? `<p class="desc">This token migrated but no LP positions were recorded for it (positions resolve from the migration receipt — re-run migration through GiwaPad, or import the token again after migrating).</p>` : ""}`;
    const wethBtn = document.getElementById("btn-claim-weth");
    if (wethBtn) wethBtn.addEventListener("click", () => void claimVaultFee(WETH, "WETH"));
    const baseBtn = document.getElementById("btn-claim-base");
    if (baseBtn && t) baseBtn.addEventListener("click", () => void claimVaultFee(t.token, t.symbol));
    document.querySelectorAll<HTMLButtonElement>("[data-lp-claim]").forEach((b) => {
      b.addEventListener("click", () => void claimLpFees(BigInt(b.dataset.lpClaim!)));
    });
    setStatus("claims-status", "Claimable amounts refreshed from the chain.", "ok");
  });
}

async function claimVaultFee(feeToken: Address, label: string): Promise<void> {
  const account = requireAccount("claims-status");
  if (!account) return;
  await guarded(`Claiming ${label} fees…`, "claims-status", async () => {
    const vault = await feeVault();
    const tx = buildClaimFeeVaultFor(feeToken, account.address, account.address);
    const { hash } = await sendTx(`Claim ${label} fees`, { to: vault, data: tx.data }, account, (m) =>
      setStatus("claims-status", spin(m)),
    );
    store.addActivity({ label: `Claim ${label} fees`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    setStatus("claims-status", `${label} fees claimed. ${txLink(hash)}`, "ok");
    await refreshClaims();
  });
}

async function claimLpFees(tokenId: bigint): Promise<void> {
  const account = requireAccount("claims-status");
  if (!account) return;
  const t = S.selected;
  if (!t?.canonicalPool) return;
  await guarded(`Claiming LP fees for position #${tokenId}…`, "claims-status", async () => {
    const damm = new DammV2Client(
      publicClient,
      t.canonicalPool!,
      "concentrated",
      LAUNCH.concentratedFactory,
      LAUNCH.concentratedPositionManager,
    );
    const tx = await paced(() =>
      damm.planClaimManagedConcentratedFees(tokenId, account.address, account.address),
    );
    const { hash } = await sendTx("Claim LP fees", tx, account, (m) =>
      setStatus("claims-status", spin(m)),
    );
    store.addActivity({ label: `Claim LP fees (#${tokenId})`, hash, ts: Date.now(), status: "confirmed" });
    renderActivity();
    setStatus("claims-status", `LP fees claimed for position #${tokenId}. ${txLink(hash)}`, "ok");
  });
}

// ---------------------------------------------------------------------------
// Activity + init
// ---------------------------------------------------------------------------
function renderActivity(): void {
  const list = store.getActivity();
  $("activity-list").innerHTML =
    list.length === 0
      ? `<li class="desc">No transactions yet.</li>`
      : list
          .map(
            (e) =>
              `<li><span class="badge ${e.status === "confirmed" ? "ok" : e.status === "failed" ? "bad" : ""}">${e.status}</span> ${esc(e.label)} — ${txLink(e.hash)} <span style="color:var(--muted)">${new Date(e.ts).toLocaleString()}</span></li>`,
          )
          .join("");
}

$("connect-btn").addEventListener("click", () => void connect());
$("btn-preview-config").addEventListener("click", () => void previewConfig());
$("btn-create-config").addEventListener("click", () => void createConfig());
$("btn-launch").addEventListener("click", () => void launchToken());
$("btn-lookup").addEventListener("click", () => void lookupAddress());
$("btn-refresh-tokens").addEventListener("click", () => void refreshAllTokenStates());
$("btn-refresh-claims").addEventListener("click", () => void refreshClaims());

// React to wallet account/chain changes.
const provider = ethereumProvider() as unknown as
  | { on?: (ev: string, fn: (...args: unknown[]) => void) => void }
  | undefined;
provider?.on?.("accountsChanged", () => void silentConnect());
provider?.on?.("chainChanged", () => void silentConnect());

renderWallet();
renderTokenList();
renderActivity();
void verifyDeploymentBackground();
void revalidateStoredConfig();
void silentConnect();
