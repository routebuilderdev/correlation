/**
 * Seed the testnet contract with the demo state:
 *
 *  1. the pinned model signer (the trust anchor the whole demo rests on),
 *  2. pool capital from the LP account,
 *  3. a swarm fingerprint of twenty agents,
 *  4. one policy bought with the premium.
 *
 * Amounts are derived from the LP balance, never hardcoded: a testnet faucet
 * hands out 10 NEAR per account, so a 100 NEAR pool cannot exist. Re-running is
 * safe — the signer and swarm are idempotent, a policy whose window has closed
 * is retired first, and nothing is bought while a live policy is still open.
 *
 * Flags for a two-policy take (the receipt keeps one entry per policy and agent,
 * so each demonstration arm needs its own policy):
 *
 *   --new              buy a fresh policy even while one is open
 *   --topup <NEAR>     deposit that much more LP capital into the pool
 *   --topup-to <NEAR>  deposit whatever makes free capital reach this much
 *   --limit <NEAR>     set the limit exactly, instead of 90% of free capital
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "@correlation/shared";

const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const CONTRACT_ID = process.env.CONTRACT_ID ?? "correlation.testnet";
const LP_ACCOUNT = process.env.LP_ACCOUNT ?? "correlation-lp.testnet";
const BUYER_ACCOUNT = process.env.BUYER_ACCOUNT ?? "correlation-buyer.testnet";
const MODEL = process.env.NEARAI_MODEL ?? "z-ai/glm-5.3-flash";
const SWARM_ID = process.env.SWARM_ID ?? "swarm-1";

const YOCTO = 10n ** 24n;
const TGAS = 10n ** 12n;
/** Left on the LP account for gas; a policy premium is separated from it. */
const RESERVE = (15n * YOCTO) / 10n;
const PREMIUM = YOCTO / 10n; // 0.1 NEAR
const WINDOW_LEAD_NS = 60n * 10n ** 9n;
// An hour: twenty real completions take minutes, and a policy that expires while
// the run is still posting receipts would reject them for the wrong reason.
const WINDOW_LENGTH_NS = 3600n * 10n ** 9n;
const GRACE_NS = 300n * 10n ** 9n;

const AGENTS = Array.from(
  { length: 20 },
  (_, index) => `agent-${String(index + 1).padStart(2, "0")}`,
);

const FIXTURES = join(import.meta.dirname, "..", "..", "contract", "tests", "fixtures");

interface Signer {
  public_key: string;
  address: string;
}

interface PoolView {
  total: string;
  committed: string;
  available: string;
  active_policies: number;
}

interface PolicyView {
  policy_id: number;
  status: string;
  window_start_ns: number;
  window_end_ns: number;
  limit: string;
  premium: string;
  failed: number;
  started: number;
}

function hash(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

function report(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(14)} ${value}\n`);
}

function near(yocto: bigint): string {
  return `${(Number(yocto) / Number(YOCTO)).toFixed(4)} NEAR`;
}

/** `--limit 7.1998` -> yocto, exactly: going through a float drifts by a yocto. */
function nearFlag(flag: string): bigint | null {
  const at = process.argv.indexOf(flag);
  if (at === -1) return null;
  const raw = process.argv[at + 1]?.trim();
  const parts = raw === undefined ? null : /^(\d+)(?:\.(\d{1,24}))?$/.exec(raw);
  if (!parts) {
    throw new Error(`${flag} needs an amount in NEAR, like 7.1998 (got ${raw ?? "nothing"})`);
  }
  const value = BigInt(parts[1] ?? "0") * YOCTO + BigInt(((parts[2] ?? "") + "0".repeat(24)).slice(0, 24));
  if (value <= 0n) throw new Error(`${flag} must be greater than zero`);
  return value;
}

function loadSigner(): Signer {
  const signer = JSON.parse(readFileSync(join(FIXTURES, "signer.json"), "utf8")) as Signer;
  if (!/^[0-9a-f]{128}$/i.test(signer.public_key)) {
    throw new Error("signer.json does not hold a 64-byte uncompressed key");
  }
  return signer;
}

async function account(name: string, privateKey: string | undefined) {
  if (!privateKey) throw new Error(`${name}: no private key in .env`);
  const { Account } = await import("@near-js/accounts");
  const { JsonRpcProvider } = await import("@near-js/providers");
  const { KeyPairSigner } = await import("@near-js/signers");
  const key = await KeyPairSigner.fromSecretKey(privateKey as never);
  return new Account(name, new JsonRpcProvider({ url: RPC }), key);
}

type Account = Awaited<ReturnType<typeof account>>;

async function view<T>(as: Account, method: string, args: Record<string, unknown>): Promise<T | null> {
  const result = await as.viewFunction({ contractId: CONTRACT_ID, methodName: method, args });
  return (result as T | null) ?? null;
}

async function call(
  as: Account,
  method: string,
  args: Record<string, unknown>,
  options: { deposit?: bigint; gas?: bigint } = {},
): Promise<string> {
  // A public RPC occasionally hands back a block hash that is already behind
  // the head and rejects the signed transaction as expired. That transaction
  // never landed, so signing it again cannot double-apply the deposit; any
  // other failure is real and is raised on the first attempt.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = (await as.callFunction({
        contractId: CONTRACT_ID,
        methodName: method,
        args,
        gas: options.gas ?? 100n * TGAS,
        deposit: options.deposit ?? 0n,
      })) as { transaction_outcome?: { id?: string } };
      return result.transaction_outcome?.id ?? "submitted";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/expired/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const signer = loadSigner();
  const owner = await account(CONTRACT_ID, process.env.CONTRACT_PRIVATE_KEY);
  const lp = await account(LP_ACCOUNT, process.env.LP_PRIVATE_KEY);
  const buyer = await account(BUYER_ACCOUNT, process.env.BUYER_PRIVATE_KEY);

  process.stdout.write(`contract ${CONTRACT_ID}\n`);

  // 1. The signer. Registered only once: re-registering would silently move the
  // trust anchor, and a demo that swaps keys mid-run proves nothing.
  const registered = await view<{ model_name: string }>(owner, "get_signer", {
    public_key: signer.public_key,
  });
  if (registered) {
    report("signer", `already registered for ${registered.model_name}`);
  } else {
    await call(owner, "register_signer", {
      args: {
        public_key: signer.public_key,
        model_name: MODEL,
        // Evidence fields. The key above is the anchor (D11); these record what
        // was checked off-chain and are never a gate.
        compose_hash: "0".repeat(64),
        os_image_hash: "0".repeat(64),
        policy_hash: hash(
          JSON.stringify({
            policy: "correlation-verifier/1",
            checks: ["eip191-recover", "signed-text-prefix", "raw-body-hash"],
            anchored: signer.address,
          }),
        ),
        verified_at_ns: Date.now() * 1_000_000,
        expires_at_ns: Number.MAX_SAFE_INTEGER,
      },
    });
    report("signer", `registered ${signer.public_key.slice(0, 16)}… for ${MODEL}`);
  }

  // 2. Capital. Derived so the script adapts to whatever the faucet left behind.
  const balance = await lp.getBalance();
  const target = balance - RESERVE;
  const pool = (await view<PoolView>(owner, "get_pool", { pool_id: 1 })) ?? {
    total: "0",
    committed: "0",
    available: "0",
    active_policies: 0,
  };
  const deposited = BigInt(pool.total);
  if (deposited >= target) {
    report("pool", `${near(deposited)} already deposited`);
  } else {
    const amount = target - deposited;
    if (amount <= 0n) {
      throw new Error(
        `${LP_ACCOUNT} holds ${near(balance)} against ${near(deposited)} deposited; nothing left above the ${near(RESERVE)} reserve`,
      );
    }
    await call(lp, "deposit", { pool_id: 1 }, { deposit: amount, gas: 50n * TGAS });
    report("deposit", near(amount));
  }

  // An explicit top-up: the first policy of a take has already committed most of
  // the pool, and every later limit is computed from what is left free.
  const topup = nearFlag("--topup");
  if (topup) {
    await call(lp, "deposit", { pool_id: 1 }, { deposit: topup, gas: 50n * TGAS });
    report("topup", near(topup));
  }

  // 3. The swarm. Anyone may register one; the fingerprint is what matters.
  await call(
    buyer,
    "register_swarm",
    {
      swarm_id: SWARM_ID,
      fingerprint: {
        model_id: MODEL,
        prompt_hash: hash("correlation/demo/prompt"),
        agent_ids: AGENTS,
      },
    },
    { gas: 50n * TGAS },
  );
  report("swarm", `${SWARM_ID}, ${AGENTS.length} agents`);

  // 4. The policy. A closed window is retired (which releases its commitment);
  // an open one is reused, because buying a second policy for the same run would
  // double the commitment without adding anything to show.
  const seen: PolicyView[] = [];
  for (let id = 1; id <= 64; id += 1) {
    const policy = await view<PolicyView>(buyer, "get_policy", { policy_id: id });
    if (!policy) break;
    seen.push(policy);
  }
  const live = seen.at(-1) ?? null;
  const now = BigInt(Date.now()) * 1_000_000n;

  // A retired policy's commitment is capital that the next limit is computed
  // from, and an Active policy whose window has closed is dead but still holds
  // it. --new skips the reuse, never this cleanup: leaving it out bought a
  // second demo policy with the 0.9 NEAR the first one had not committed yet.
  for (const policy of seen) {
    if (policy.status !== "Active") continue;
    if (now < BigInt(policy.window_end_ns) + GRACE_NS) continue;
    await call(buyer, "expire", { policy_id: policy.policy_id }, { gas: 50n * TGAS });
    report("expire", `#${policy.policy_id} (window closed)`);
  }

  const forceNew = process.argv.includes("--new");
  if (live && live.status === "Active" && !forceNew) {
    if (now < BigInt(live.window_end_ns) + GRACE_NS) {
      report("policy", `#${live.policy_id} still open, reusing it`);
      report("window", `${new Date(live.window_end_ns / 1e6).toISOString()} (${live.limit} limit)`);
      printSummary(await view<PoolView>(owner, "get_pool", { pool_id: 1 }), live);
      return;
    }
    // Retired by the loop above.
  }

  // Fund to an exact amount of *free* capital, after the stale commitments are
  // released: this is the only place that knows both numbers, so a caller can
  // ask for a limit and get it without guessing a top-up.
  const topupTo = nearFlag("--topup-to");
  if (topupTo) {
    const pool = await view<PoolView>(owner, "get_pool", { pool_id: 1 });
    const free = BigInt(pool?.available ?? "0");
    if (free < topupTo) {
      const amount = topupTo - free;
      const balance = await lp.getBalance();
      if (balance < amount + RESERVE) {
        throw new Error(
          `free capital is ${near(free)} and reaching ${near(topupTo)} needs ${near(amount)} more, but ${LP_ACCOUNT} holds ${near(balance)} (keeping ${near(RESERVE)} for gas)`,
        );
      }
      await call(lp, "deposit", { pool_id: 1 }, { deposit: amount, gas: 50n * TGAS });
      report("topup", `${near(amount)} (free capital to ${near(topupTo)})`);
    } else {
      report("topup", `free capital already ${near(free)}`);
    }
  }

  const windowStart = (now / 1_000_000_000n) * 1_000_000_000n + WINDOW_LEAD_NS;
  const windowEnd = windowStart + WINDOW_LENGTH_NS;

  // The limit must fit the pool's free capital (committed + limit <= total), and
  // a tenth is held back so the pool keeps headroom rather than being exactly
  // exhausted by one policy.
  const free = BigInt((await view<PoolView>(owner, "get_pool", { pool_id: 1 }))?.available ?? "0");
  const cap = (free * 9n) / 10n;
  let limit = free < cap ? free : cap;
  if (limit < PREMIUM) throw new Error(`only ${near(free)} free in the pool; deposit more capital`);
  // An explicit limit keeps a second policy's payout identical to the first.
  // Refuse loudly rather than silently shrinking it: the number appears on film.
  const requested = nearFlag("--limit");
  if (requested) {
    if (requested > free) {
      throw new Error(
        `--limit ${near(requested)} does not fit ${near(free)} of free capital; add ${near(requested - free)} with --topup, or pass --topup-to ${near(requested)}`,
      );
    }
    limit = requested;
  }

  const termsJson = JSON.stringify({
    limit: limit.toString(),
    premium: PREMIUM.toString(),
    trigger_bps: 2500,
    window_start_ns: Number(windowStart),
    window_end_ns: Number(windowEnd),
    min_agents: AGENTS.length,
    min_receipts: Math.ceil(AGENTS.length * 0.8),
    model_id: MODEL,
    signer_pubkey: signer.public_key,
  });

  await call(
    buyer,
    "buy_policy",
    {
      swarm_id: SWARM_ID,
      terms: { terms_json: termsJson, terms_hash: hash(termsJson) },
    },
    { deposit: PREMIUM, gas: 100n * TGAS },
  );

  let bought: PolicyView | null = null;
  for (let id = 1; id <= 64; id += 1) {
    const policy = await view<PolicyView>(buyer, "get_policy", { policy_id: id });
    if (!policy) break;
    bought = policy;
  }
  if (!bought) throw new Error("the policy was bought but cannot be read back");

  report("policy", `#${bought.policy_id} ${bought.status.toLowerCase()}, limit ${near(BigInt(bought.limit))}`);
  report("window", `${new Date(bought.window_start_ns / 1e6).toISOString()} → ${new Date(bought.window_end_ns / 1e6).toISOString()}`);
  printSummary(await view<PoolView>(owner, "get_pool", { pool_id: 1 }), bought);
}

function printSummary(pool: PoolView | null, policy: PolicyView | null): void {
  if (pool) {
    report("pool", `${near(BigInt(pool.total))} total, ${near(BigInt(pool.committed))} committed`);
  }
  if (policy) report("index", `${policy.failed} failed of ${policy.started} posted`);
}

await main();
