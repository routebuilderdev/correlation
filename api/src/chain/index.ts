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

/** Only the buyer may claim, so the payout is signed with the buyer's key. */
async function signerAs(accountId: string, privateKey: string) {
  if (!accountId || !privateKey) {
    throw new Error("an account id and private key are required to submit a transaction");
  }
  const { KeyPairSigner } = await import("@near-js/signers");
  const { Account } = await import("@near-js/accounts");
  const { JsonRpcProvider } = await import("@near-js/providers");
  const key = await KeyPairSigner.fromSecretKey(privateKey as never);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  return new Account(accountId, provider, key);
}

async function functionCall(
  method: string,
  args: Record<string, unknown>,
  as: "evaluator" | "buyer" = "evaluator",
) {
  const account =
    as === "buyer"
      ? await signerAs(config.buyerAccountId, config.buyerPrivateKey)
      : await signerAs(config.signerAccountId, config.signerPrivateKey);
  return account.callFunction({
    contractId: config.contractId,
    methodName: method,
    args,
    gas: TGAS,
    deposit: 0n,
  });
}

/** Pays the buyer. The contract caps at available capital and freezes the NFT. */
export async function claim(policyId: number): Promise<string> {
  const result = (await withRetry(() =>
    functionCall("claim", { policy_id: policyId }, "buyer"),
  )) as { transaction_outcome?: { id?: string } };
  return result.transaction_outcome?.id ?? "submitted";
}

/** Retry once on a transport error; never retry a receipt the chain accepted. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transient = /fetch|ECONN|timeout|502|503|504/i.test(message);
    if (!transient) throw error;
    return run();
  }
}

export async function postReceipt(a: ReceiptSubmission): Promise<string> {
  const result = (await withRetry(() =>
    functionCall("post_receipt", {
      policy_id: a.policyId,
      agent_id: a.agentId,
      // Vec<u8> over the JSON boundary is an array of numbers, not a string.
      request_bytes: Array.from(a.requestBytes),
      response_bytes: Array.from(a.responseBytes),
      signature_json: a.signatureJson,
    }),
  )) as { transaction_outcome?: { id?: string } } | string;

  if (typeof result === "string") return result;
  return result.transaction_outcome?.id ?? "submitted";
}

export async function evaluate(policyId: number): Promise<string> {
  const result = (await withRetry(() => functionCall("evaluate", { policy_id: policyId }))) as {
    transaction_outcome?: { id?: string };
  };
  return result.transaction_outcome?.id ?? "submitted";
}

export async function expire(policyId: number): Promise<string> {
  const result = (await withRetry(() => functionCall("expire", { policy_id: policyId }))) as {
    transaction_outcome?: { id?: string };
  };
  return result.transaction_outcome?.id ?? "submitted";
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
