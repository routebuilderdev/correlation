/**
 * Chain submission. Imports are dynamic so the rest of the app — and its tests —
 * run without a configured account.
 */
import { config } from "../config.ts";

const TGAS = 30n * 10n ** 12n;

export interface ReceiptSubmission {
  policyId: number;
  agentId: string;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  signatureJson: string;
}

/**
 * One Account per role, cached.
 *
 * A fresh Account reads the access-key nonce from the network before signing,
 * and twenty receipts submitted in a row read the same stale nonce: sixteen of
 * them were rejected as "must be larger than nonce of the used access key".
 * The cached instance keeps its own incrementing nonce, which is what the
 * chain expects for a burst of transactions from one key.
 */
const accounts = new Map<string, Promise<unknown>>();

/** Only the buyer may claim, so the payout is signed with the buyer's key. */
async function signerAs(accountId: string, privateKey: string) {
  if (!accountId || !privateKey) {
    throw new Error("an account id and private key are required to submit a transaction");
  }
  const cached = accounts.get(accountId);
  if (cached) return cached as Promise<import("@near-js/accounts").Account>;

  const created = (async () => {
    const { KeyPairSigner } = await import("@near-js/signers");
    const { Account } = await import("@near-js/accounts");
    const { JsonRpcProvider } = await import("@near-js/providers");
    const key = await KeyPairSigner.fromSecretKey(privateKey as never);
    const provider = new JsonRpcProvider({ url: config.rpcUrl });
    return new Account(accountId, provider, key);
  })();
  accounts.set(accountId, created);
  return created;
}

/**
 * Sign and send one function call, returning its transaction hash.
 *
 * `Account.callFunction` hides the hash in a shape its own types do not expose,
 * which left the UI (and the receipts table) showing "submitted". Building the
 * action here gives the hash a caller can paste into an explorer.
 */
async function functionCall(
  method: string,
  args: Record<string, unknown>,
  as: "evaluator" | "buyer" = "evaluator",
  deposit = 0n,
): Promise<string> {
  const account =
    as === "buyer"
      ? await signerAs(config.buyerAccountId, config.buyerPrivateKey)
      : await signerAs(config.signerAccountId, config.signerPrivateKey);
  const { actionCreators } = await import("@near-js/transactions");
  const outcome = await account.signAndSendTransaction({
    receiverId: config.contractId,
    actions: [
      actionCreators.functionCall(
        method,
        new TextEncoder().encode(JSON.stringify(args)),
        TGAS,
        deposit,
      ),
    ],
    waitUntil: "INCLUDED_FINAL",
  });
  return outcome.transaction_outcome?.id ?? "";
}

/** Pays the buyer. The contract caps at available capital and freezes the NFT. */
export async function claim(policyId: number): Promise<string> {
  return withRetry(() => functionCall("claim", { policy_id: policyId }, "buyer"));
}

/**
 * Retry transport failures and nonce collisions; never retry a receipt the
 * chain accepted. A nonce collision means a previous send is still settling, so
 * it needs a pause rather than an immediate second attempt.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /fetch|ECONN|timeout|502|503|504/i.test(message);
      const nonce = /must be larger than nonce/i.test(message);
      if (!transient && !nonce) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, nonce ? 2_000 : 500));
    }
  }
  throw lastError;
}

export async function postReceipt(a: ReceiptSubmission): Promise<string> {
  return withRetry(() =>
    functionCall("post_receipt", {
      policy_id: a.policyId,
      agent_id: a.agentId,
      // Vec<u8> over the JSON boundary is an array of numbers, not a string.
      request_bytes: Array.from(a.requestBytes),
      response_bytes: Array.from(a.responseBytes),
      signature_json: a.signatureJson,
    }),
  );
}

export async function evaluate(policyId: number): Promise<string> {
  return withRetry(() => functionCall("evaluate", { policy_id: policyId }));
}

export async function expire(policyId: number): Promise<string> {
  return withRetry(() => functionCall("expire", { policy_id: policyId }));
}

/**
 * The newest policy on the contract.
 *
 * A policy id cannot be hardcoded: every demo buys a new policy, and a page
 * pinned to an old one showed `Expired` while the run it was driving posted
 * receipts against a different policy. Ids are sequential from 1, so scan up
 * until `get_policy` stops answering. Cached briefly: the UI polls health.
 */
let latest: { id: number; at: number } | null = null;

/** Eight at a time: one round trip each (~3s), and a demo has a handful. */
const PROBE_WINDOW = 8;
const MAX_POLICY_ID = 64;

export async function latestPolicyId(): Promise<number> {
  if (latest && Date.now() - latest.at < 15_000) return latest.id;
  const { JsonRpcProvider } = await import("@near-js/providers");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });

  let found = 0;
  for (let base = 1; base <= MAX_POLICY_ID; base += PROBE_WINDOW) {
    const ids = Array.from({ length: PROBE_WINDOW }, (_, offset) => base + offset);
    // A retired id answers `null`, not an error, so `null` is the end marker.
    const views = await Promise.all(
      ids.map((id) =>
        provider
          .callFunction(config.contractId, "get_policy", { policy_id: id })
          .then((view) => (view ? id : null))
          .catch(() => null),
      ),
    );
    const lastPresent = views.reduce<number>((acc, id) => (id !== null ? id : acc), 0);
    if (lastPresent === 0) break;
    found = lastPresent;
    if (views.includes(null)) break;
  }

  if (found === 0) throw new Error(`no policies exist on ${config.contractId}`);
  latest = { id: found, at: Date.now() };
  return found;
}

/** One round trip for the UI: policy terms and pool state move together. */
export async function policyView(policyId: number): Promise<unknown> {
  const { JsonRpcProvider } = await import("@near-js/providers");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const [policy, pool] = await Promise.all([
    provider.callFunction(config.contractId, "get_policy", { policy_id: policyId }),
    provider.callFunction(config.contractId, "get_pool", { pool_id: config.poolId }),
  ]);
  return { policy, pool };
}
