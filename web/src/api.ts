export interface PolicyView {
  policy_id: number;
  swarm_id: string;
  buyer: string;
  token_id: string;
  status: "Active" | "Triggered" | "Paid" | "Expired";
  limit: string;
  premium: string;
  paid_amount: string;
  trigger_bps: number;
  window_start_ns: number;
  window_end_ns: number;
  min_agents: number;
  min_receipts: number;
  model_id: string;
  signer_pubkey: string;
  terms_hash: string;
  failed: number;
  started: number;
}

export interface PoolView {
  pool_id: number;
  total: string;
  committed: string;
  available: string;
  active_policies: number;
}

export interface PolicyResponse {
  policy: PolicyView;
  pool: PoolView;
}

export interface AgentRow {
  index: number;
  agentId: string;
  n: number;
  expected: number;
  answer: number | null;
  ok: boolean;
  error: string | null;
  completionId: string | null;
  signatureKind: string | null;
  signingAddress: string | null;
  requestSha256: string | null;
  responseSha256: string | null;
  signature: string | null;
  signingPublicKey: string | null;
  txHash: string | null;
}

export interface RunResponse {
  id: string;
  policyId: number;
  mode: "control" | "poisoned";
  status: "running" | "complete" | "evaluating" | "triggered" | "error";
  startedAt: string;
  error: string | null;
  evaluateTx: string | null;
  txHashes: Record<string, string>;
  results: AgentRow[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return (await response.json()) as T;
}

export function fetchPolicy(policyId: number): Promise<PolicyResponse> {
  return getJson<PolicyResponse>(`/api/policy/${policyId}`);
}

export function fetchRun(runId: string): Promise<RunResponse> {
  return getJson<RunResponse>(`/api/runs/${runId}`);
}

export async function startRun(
  mode: "control" | "poisoned",
  policyId: number,
): Promise<string> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, policyId }),
  });
  if (!response.ok) throw new Error(`run ${response.status}`);
  const body = (await response.json()) as { runId: string };
  return body.runId;
}
