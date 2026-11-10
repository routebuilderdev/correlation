/** Everything configurable lives here; nothing else reads `process.env`. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Direct model endpoint, not the cloud-api gateway: only direct endpoints sign
  // "<model>:<req>:<resp>" as provider_tee, which is what the contract accepts.
  // Discovered from the public list at https://completions.near.ai/endpoints.
  nearaiBaseUrl: (
    process.env.NEARAI_BASE_URL ?? "https://glm-5-3-flash.completions.near.ai/v1"
  ).replace(/\/$/, ""),
  nearaiApiKey: process.env.NEARAI_API_KEY ?? "",
  model: process.env.NEARAI_MODEL ?? "z-ai/glm-5.3-flash",
  networkId: process.env.NEAR_NETWORK ?? "testnet",
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
  contractId: process.env.CONTRACT_ID ?? "correlation.testnet",
  // The evaluator posts receipts and calls evaluate; the buyer only claims.
  signerAccountId: process.env.EVAL_ACCOUNT ?? "",
  signerPrivateKey: process.env.EVAL_PRIVATE_KEY ?? "",
  // Claiming is restricted to the buyer on chain, so it needs the buyer's key.
  buyerAccountId: process.env.BUYER_ACCOUNT ?? "",
  buyerPrivateKey: process.env.BUYER_PRIVATE_KEY ?? "",
  poolId: 1,
  /**
   * Two at a time. Higher parallelism gets the run finished sooner but pushes
   * requests onto non-TEE capacity, and an unsigned completion is worthless
   * here: the contract cannot verify it.
   */
  concurrency: Number(process.env.SWARM_CONCURRENCY ?? 2),
  /**
   * Every request needs a deadline. Without one a single stalled socket keeps
   * the run "running" forever, and the demo has no failure to show.
   */
  completionTimeoutMs: Number(process.env.NEARAI_COMPLETION_TIMEOUT_MS ?? 90_000),
  signatureTimeoutMs: Number(process.env.NEARAI_SIGNATURE_TIMEOUT_MS ?? 20_000),
  /** A missing signature is usually "not yet", not "never". */
  signatureAttempts: Number(process.env.NEARAI_SIGNATURE_ATTEMPTS ?? 10),
  signatureRetryMs: Number(process.env.NEARAI_SIGNATURE_RETRY_MS ?? 1_500),
  /** Completions that come back unsigned or timed out are worth another ask. */
  swarmAttempts: Number(process.env.SWARM_ATTEMPTS ?? 3),
};

export function requireApiKey(): string {
  if (!config.nearaiApiKey) {
    throw new Error(
      "NEARAI_API_KEY is not set. Put it in .env at the repository root (never in git) or export it before starting the server.",
    );
  }
  return config.nearaiApiKey;
}
