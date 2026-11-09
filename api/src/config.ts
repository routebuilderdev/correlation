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
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
  contractId: process.env.CONTRACT_ID ?? "correlation.testnet",
  // The evaluator posts receipts and calls evaluate; the buyer only claims.
  signerAccountId: process.env.EVAL_ACCOUNT ?? "",
  signerPrivateKey: process.env.EVAL_PRIVATE_KEY ?? "",
  // Claiming is restricted to the buyer on chain, so it needs the buyer's key.
  buyerAccountId: process.env.BUYER_ACCOUNT ?? "",
  buyerPrivateKey: process.env.BUYER_PRIVATE_KEY ?? "",
  poolId: 1,
  /** Four at a time: twenty parallel requests is how demos get rate limited. */
  concurrency: 4,
};

export function requireApiKey(): string {
  if (!config.nearaiApiKey) {
    throw new Error(
      "NEARAI_API_KEY is not set. Put it in spike/.env (never in git) or export it before starting the server.",
    );
  }
  return config.nearaiApiKey;
}
