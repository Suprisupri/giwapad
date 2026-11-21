/** GiwaPad local persistence (localStorage). No server, no account. */
import type { Address, Hash } from "viem";

export type StoredConfig = {
  configId: string;
  configHash: string;
  txHash: Hash;
  blockNumber: string;
  createdAt: number;
};

export type LpPosition = { tokenId: string; owner: Address };

export type StoredToken = {
  token: Address;
  curve: Address;
  name: string;
  symbol: string;
  decimals: number;
  configId: string;
  launchTx: Hash;
  launchBlock: string;
  canonicalPool?: Address;
  migrationTx?: Hash;
  positions?: LpPosition[];
  imported: boolean;
};

export type ActivityEntry = {
  label: string;
  hash: Hash;
  ts: number;
  status: "submitted" | "confirmed" | "failed";
};

const KEYS = {
  config: "giwapad:config",
  tokens: "giwapad:tokens",
  activity: "giwapad:activity",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full/blocked: the app still works, it just forgets.
  }
}

export const store = {
  getConfig(): StoredConfig | null {
    return read<StoredConfig | null>(KEYS.config, null);
  },
  setConfig(c: StoredConfig): void {
    write(KEYS.config, c);
  },
  clearConfig(): void {
    localStorage.removeItem(KEYS.config);
  },
  getTokens(): StoredToken[] {
    return read<StoredToken[]>(KEYS.tokens, []);
  },
  upsertToken(t: StoredToken): void {
    const tokens = store.getTokens();
    const i = tokens.findIndex((x) => x.curve.toLowerCase() === t.curve.toLowerCase());
    if (i >= 0) tokens[i] = { ...tokens[i], ...t };
    else tokens.unshift(t);
    write(KEYS.tokens, tokens);
  },
  getActivity(): ActivityEntry[] {
    return read<ActivityEntry[]>(KEYS.activity, []);
  },
  addActivity(e: ActivityEntry): void {
    const list = store.getActivity();
    list.unshift(e);
    write(KEYS.activity, list.slice(0, 50));
  },
  updateActivity(hash: Hash, status: ActivityEntry["status"]): void {
    const list = store.getActivity();
    const e = list.find((x) => x.hash === hash);
    if (e) {
      e.status = status;
      write(KEYS.activity, list);
    }
  },
};
