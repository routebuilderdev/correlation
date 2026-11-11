/**
 * One-off: create a faucet-sponsored testnet account, sweep it into the LP, delete it.
 *
 * The public helper funds a *new* account, so the only way to turn a faucet drip
 * into pool capital is to create one, move the money to the LP, and remove it.
 * The delete names the LP as beneficiary, so the dust left over after the sweep
 * lands there too and no orphan account is left on testnet.
 *
 * The private key never leaves this process and is never printed.
 *
 *   node --env-file=../.env scripts/faucet-fill.mjs correlation-fill.testnet
 */
import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const FAUCET = "https://helper.testnet.near.org/account";
const LP = process.env.LP_ACCOUNT ?? "correlation-lp.testnet";
const YOCTO = 10n ** 24n;

const name = (process.argv[2] ?? "").trim();
if (!/^[a-z0-9][a-z0-9_-]{1,56}\.testnet$/.test(name)) {
  throw new Error(`pass a top-level testnet name, e.g. correlation-fill.testnet (got "${name}")`);
}

const provider = new JsonRpcProvider({ url: RPC });

const near = (yocto) => {
  const value = BigInt(yocto);
  return `${value / YOCTO}.${((value % YOCTO) * 10_000n / YOCTO).toString().padStart(4, "0")}`;
};

async function balanceOf(accountId) {
  const { amount } = await provider.viewAccount(accountId);
  return BigInt(amount);
}

async function exists(accountId) {
  try {
    await provider.viewAccount(accountId);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (await exists(name)) throw new Error(`${name} already exists — pick another name, nothing was sent`);
  const lpBefore = await balanceOf(LP);
  process.stdout.write(`lp ${LP} holds ${near(lpBefore)}\n`);

  // 1. Faucet: creates the account and attaches this key.
  const keyPair = KeyPair.fromRandom("ed25519");
  const response = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: name, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  const text = (await response.text()).slice(0, 300);
  process.stdout.write(`faucet ${response.status} ${text.replace(/\s+/g, " ").trim()}\n`);
  if (!response.ok) throw new Error(`the faucet refused ${name}; nothing was moved`);

  // 2. Wait for it to appear on chain.
  let funded = 0n;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await exists(name)) {
      funded = await balanceOf(name);
      if (funded > 0n) break;
    }
    await sleep(3000);
  }
  if (funded === 0n) throw new Error(`${name} never showed a balance; nothing was moved`);
  process.stdout.write(`faucet gave ${name} ${near(funded)}\n`);

  // 3. Sweep, then remove it. Both actions in one transaction: either the money
  //    reaches the LP and the account goes, or nothing happens at all.
  const signer = await KeyPairSigner.fromSecretKey(keyPair.toString());
  const account = new Account(name, provider, signer);
  const keep = 5n * YOCTO / 10n; // gas headroom; the delete sends the rest to the LP
  const sweep = funded - keep;

  const send = async (actions, label) => {
    const result = await account.signAndSendTransaction({ receiverId: name, actions });
    const outcome = result?.transaction_outcome ?? {};
    const failure = outcome?.outcome?.status?.Failure ?? outcome?.status?.Failure;
    if (failure) throw new Error(`${label} failed on chain: ${JSON.stringify(failure)}`);
    process.stdout.write(`${label} ok · tx ${outcome.id ?? "submitted"}\n`);
    return outcome.id;
  };

  try {
    await send(
      [actionCreators.transfer(sweep), actionCreators.deleteAccount(LP)],
      `sweep ${near(sweep)} to ${LP} + delete`,
    );
  } catch (error) {
    process.stdout.write(`combined sweep failed (${error.message}); retrying delete-only\n`);
    await send([actionCreators.deleteAccount(LP)], `delete ${name} with ${LP} as beneficiary`);
  }

  // 4. Confirm on chain.
  const lpAfter = await balanceOf(LP);
  process.stdout.write(`lp ${LP} now holds ${near(lpAfter)} (+${near(lpAfter - lpBefore)})\n`);
  process.stdout.write(`${name} still exists: ${await exists(name)}\n`);
  if (lpAfter <= lpBefore) throw new Error("the LP balance did not increase — check the explorer");
}

await main();
