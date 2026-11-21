import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const path = new URL("../.test-wallet.json", import.meta.url);
fs.writeFileSync(path, JSON.stringify({ address: account.address, privateKey: pk, chainId: 91342, purpose: "GiwaPad testnet-only test wallet, generated 2026-11-22", note: "TESTNET ONLY - never use on mainnet, never share" }, null, 2), { mode: 0o600 });
console.log("address:", account.address);
console.log("file mode:", (fs.statSync(path).mode & 0o777).toString(8));
