/**
 * Create the demo's testnet accounts, deploy the contract, and write `.env`.
 *
 * No `near` CLI and no GitHub: accounts come from the public testnet faucet and
 * the deploy goes through @near-js. Top-level accounts (not subaccounts) because
 * the faucet only funds top-level names, and 100 NEAR each is what the pool and
 * premiums need.
 *
 *   npm run testnet --workspace @correlation/api            # create + deploy
 *   npm run testnet --workspace @correlation/api -- --check # report only
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

const ROOT = join(import.meta.dirname, "..", "..");
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const FAUCET = "https://helper.testnet.near.org/account";
const WASM = join(ROOT, "contract", "target", "wasm32-unknown-unknown", "release", "correlation.wasm");

const ACCOUNTS = {
  CONTRACT_ID: "correlation.testnet",
  EVAL_ACCOUNT: "correlation-eval.testnet",
  BUYER_ACCOUNT: "correlation-buyer.testnet",
  LP_ACCOUNT: "correlation-lp.testnet",
} as const;

const provider = new JsonRpcProvider({ url: RPC });
const checkOnly = process.argv.includes("--check");

async function exists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount(accountId);
    return true;
  } catch {
    return false;
  }
}

async function balanceOf(accountId: string): Promise<string> {
  const { amount } = (await provider.viewAccount(accountId)) as { amount: string | bigint };
  const yocto = BigInt(amount);
  const whole = yocto / 10n ** 24n;
  const millis = (yocto % 10n ** 24n) / 10n ** 21n;
  return `${whole}.${millis.toString().padStart(3, "0")} NEAR`;
}

/** The faucet creates a top-level account and funds it. */
async function fromFaucet(accountId: string, publicKey: string): Promise<void> {
  const response = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  if (!response.ok) {
    throw new Error(`faucet refused ${accountId}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const keys: Record<string, string> = {};

  // Reuse keys already in .env so a re-run keeps the same identities.
  if (existsSync(join(ROOT, ".env"))) {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const match = /^(EVAL_PRIVATE_KEY|BUYER_PRIVATE_KEY|LP_PRIVATE_KEY)=(.*)$/.exec(line.trim());
      const name = match?.[1];
      const value = match?.[2];
      if (name && value) keys[name] = value;
    }
  }

  for (const [env, accountId] of Object.entries(ACCOUNTS)) {
    const present = await exists(accountId);
    process.stdout.write(`${present ? "exists " : "missing"} ${accountId}\n`);
    if (present || checkOnly) continue;
    if (env === "CONTRACT_ID") continue; // created below with the others

    const keyEnv = env.replace("_ACCOUNT", "_PRIVATE_KEY");
    const stored = keys[keyEnv] ?? "";
    const keyPair = stored ? KeyPair.fromString(stored as never) : KeyPair.fromRandom("ed25519");
    keys[keyEnv] = keyPair.toString();
    await fromFaucet(accountId, keyPair.getPublicKey().toString());
    process.stdout.write(`  created ${accountId}\n`);
  }

  if (checkOnly) {
    for (const accountId of Object.values(ACCOUNTS)) {
      if (await exists(accountId)) process.stdout.write(`${accountId} ${await balanceOf(accountId)}\n`);
    }
    const owner = await provider.viewAccount(ACCOUNTS.CONTRACT_ID);
    process.stdout.write(`contract code hash ${(owner as { code_hash?: string }).code_hash}\n`);
    return;
  }

  // The contract account: faucet, then deploy and initialise in one transaction.
  if (!(await exists(ACCOUNTS.CONTRACT_ID))) {
    const contractKey = KeyPair.fromRandom("ed25519");
    keys.CONTRACT_PRIVATE_KEY = contractKey.toString();
    await fromFaucet(ACCOUNTS.CONTRACT_ID, contractKey.getPublicKey().toString());
    process.stdout.write(`  created ${ACCOUNTS.CONTRACT_ID}\n`);

    if (!existsSync(WASM)) {
      throw new Error(`${WASM} is missing — build it: cd contract && cargo build --release --target wasm32-unknown-unknown`);
    }
    const signer = await KeyPairSigner.fromSecretKey(keys.CONTRACT_PRIVATE_KEY as never);
    const account = new Account(ACCOUNTS.CONTRACT_ID, provider, signer);
    const result = (await account.signAndSendTransaction({
      receiverId: ACCOUNTS.CONTRACT_ID,
      actions: [
        actionCreators.deployContract(readFileSync(WASM)),
        actionCreators.functionCall(
          "new",
          { owner: ACCOUNTS.CONTRACT_ID },
          100n * 10n ** 12n,
          0n,
        ),
      ],
    })) as { transaction_outcome?: { id?: string } };
    process.stdout.write(`  deployed ${WASM} (${result.transaction_outcome?.id ?? "submitted"})\n`);
  } else {
    process.stdout.write(`contract already at ${ACCOUNTS.CONTRACT_ID}; not redeploying\n`);
  }

  // Write .env: template defaults first, then whatever exists, then our values.
  // Starting from the template means the endpoint and policy defaults are present
  // instead of looking unset on the first preflight.
  const envPath = join(ROOT, ".env");
  const merged = new Map<string, string>();
  const absorb = (lines: string[]) => {
    for (const line of lines) {
      const key = /^([A-Z0-9_]+)=/.exec(line.trim())?.[1];
      if (key) merged.set(key, line.trim().slice(key.length + 1));
    }
  };
  absorb(readFileSync(join(ROOT, ".env.example"), "utf8").split("\n"));
  if (existsSync(envPath)) absorb(readFileSync(envPath, "utf8").split("\n"));
  for (const [key, value] of Object.entries({ ...ACCOUNTS, ...keys })) merged.set(key, value);
  writeFileSync(
    envPath,
    [...merged].map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
  );

  process.stdout.write("\nbalances\n");
  for (const accountId of Object.values(ACCOUNTS)) {
    process.stdout.write(`  ${accountId} ${await balanceOf(accountId)}\n`);
  }
  process.stdout.write(`\nwrote keys to .env (values not printed)\nnext: seed the pool and policy\n`);
}

await main();
