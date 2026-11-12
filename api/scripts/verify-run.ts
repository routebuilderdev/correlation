/**
 * Re-verify a recorded run from the chain instead of from the recording.
 *
 * The run file holds a hash, a signature and a verdict. This command treats
 * none of them as evidence: for every agent it fetches the `post_receipt`
 * transaction the evaluator actually sent, hashes the bytes in that call,
 * rebuilds the signed text, recovers the signer, re-derives the expected task
 * input from (policy id, agent position) and checks the arithmetic itself.
 *
 * Read-only: it sends no transactions and needs no key. The only inputs are the
 * public RPC and the recorded run, which is committed for policy 20.
 *
 *   npm run verify-run --workspace @correlation/api
 *   npm run verify-run --workspace @correlation/api -- --policy 19
 *   npm run verify-run --workspace @correlation/api -- --run run-mwcfqpck-zq6c
 */
import { createHash } from "node:crypto";

import { expectedAnswer, taskInput } from "@correlation/shared";

import { config } from "../src/config.ts";
import { verifyLocally, type SignatureRecord } from "../src/nearai/verify.ts";
import { latestRunFor, loadRun } from "../src/store.ts";

const DEFAULT_POLICY = 20;
/** On a chain read the sender only has to be right; it does not sign anything. */
const DEFAULT_SENDER = "correlation-eval.testnet";

interface RecordedResult {
  index: number;
  agentId: string;
  n: number;
  expected: number;
  answer: number | null;
  ok: boolean;
  requestSha256: string;
  responseSha256: string;
  signature: string | null;
  txHash: string | null;
}

interface RecordedRun {
  id: string;
  policyId: number;
  mode: string;
  status: string;
  results: RecordedResult[];
}

interface PolicyView {
  policy_id: number;
  model_id: string;
  signer_pubkey: string;
  status: string;
  failed: number;
  started: number;
  trigger_bps: number;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const short = (hash: string, width = 10): string => `${hash.slice(0, width)}…`;

function bytesFrom(value: unknown): Uint8Array {
  if (!Array.isArray(value)) throw new Error("receipt bytes are not an array");
  return Uint8Array.from(value as number[]);
}

/** What the contract does in `expected_task_input`: policy id and swarm position. */
function positionOf(agentId: string): number | null {
  const match = /^agent-(\d{2})$/.exec(agentId);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10) - 1;
}

async function loadRecorded(): Promise<RecordedRun> {
  const runId = arg("run");
  const policyId = Number(arg("policy") ?? DEFAULT_POLICY);
  const run = runId
    ? await loadRun<RecordedRun>(runId)
    : await latestRunFor<RecordedRun>(policyId);
  if (!run) {
    throw new Error(
      runId
        ? `no recorded run ${runId} in api/.runs`
        : `no recorded run for policy ${policyId} in api/.runs; pass --run <id> or run a demo first`,
    );
  }
  return run;
}

async function main(): Promise<void> {
  const run = await loadRecorded();
  const policyId = Number(arg("policy") ?? run.policyId);
  const sender = arg("sender") ?? (config.signerAccountId || DEFAULT_SENDER);

  const { JsonRpcProvider } = await import("@near-js/providers");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });

  const policy = (await provider.callFunction(
    config.contractId,
    "get_policy",
    { policy_id: policyId },
  )) as PolicyView | null;
  if (!policy) throw new Error(`policy ${policyId} is not on ${config.contractId}`);

  console.log(`run      ${run.id} (${run.mode}, recorded ${run.status})`);
  console.log(`policy   ${policyId} on ${config.contractId}, status ${policy.status}`);
  console.log(`model    ${policy.model_id}`);
  console.log(`signer   ${short(policy.signer_pubkey, 16)} (registered on chain)`);
  console.log(`sender   ${sender}, read-only over ${config.rpcUrl}`);
  console.log("");

  let checked = 0;
  let mismatched = 0;
  let failedAgents = 0;
  const posted = run.results.filter((result) => result.txHash).length;

  for (const result of run.results) {
    const label = result.agentId.padEnd(8);
    if (!result.txHash) {
      mismatched += 1;
      console.log(`${label} no transaction recorded`);
      continue;
    }

    const problems: string[] = [];
    try {
      const outcome = await provider.txStatus(result.txHash, sender);
      const actions = (outcome.transaction?.actions ?? []) as Array<{
        FunctionCall?: { method_name: string; args: string };
      }>;
      const call = actions
        .map((action) => action.FunctionCall)
        .find((candidate) => candidate?.method_name === "post_receipt");
      if (!call) throw new Error("transaction carries no post_receipt call");

      const args = JSON.parse(
        Buffer.from(call.args, "base64").toString("utf8"),
      ) as {
        policy_id: number;
        agent_id: string;
        request_bytes: number[];
        response_bytes: number[];
        signature_json: string;
      };

      if (args.policy_id !== policyId) problems.push(`policy ${args.policy_id}`);
      if (args.agent_id !== result.agentId) problems.push(`agent ${args.agent_id}`);

      const request = bytesFrom(args.request_bytes);
      const response = bytesFrom(args.response_bytes);

      // The bytes the account posted, hashed here, not the hash it recorded.
      if (sha256(request) !== result.requestSha256) problems.push("request hash");
      if (sha256(response) !== result.responseSha256) problems.push("response hash");

      const record = JSON.parse(args.signature_json) as SignatureRecord;
      const verified = await verifyLocally(
        record,
        request,
        response,
        policy.model_id,
        policy.signer_pubkey,
      );

      // The contract derives the task input; the recording is not consulted.
      const position = positionOf(result.agentId);
      if (position === null) problems.push("agent id is not positional");
      else if (verified.verdict.n !== taskInput(policyId, position)) {
        problems.push(`task input ${verified.verdict.n}`);
      }
      if (verified.ok !== (verified.verdict.a === expectedAnswer(verified.verdict.n))) {
        problems.push("arithmetic does not match the answer");
      }
      if (!verified.ok) failedAgents += 1;

      checked += 1;
      const verdict = verified.ok
        ? `ok ${verified.verdict.a}`
        : `wrong ${verified.verdict.a} ≠ ${expectedAnswer(verified.verdict.n)}`;
      const state = problems.length === 0 ? "verified" : `MISMATCH ${problems.join(", ")}`;
      if (problems.length > 0) mismatched += 1;
      console.log(
        `${label} ${short(result.txHash)}  ${verdict.padEnd(22)} ${state}`,
      );
    } catch (error) {
      mismatched += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${label} ${short(result.txHash)}  FAILED  ${message}`);
    }
  }

  const bps = checked === 0 ? 0 : Math.round((failedAgents / checked) * 10_000);
  console.log("");
  console.log(
    `${posted} receipts recorded, ${checked} re-verified, ${mismatched} mismatched`,
  );
  console.log(
    `${failedAgents} failed of ${checked} = ${bps} bps, trigger ${policy.trigger_bps} bps`,
  );
  console.log(
    `contract says ${policy.failed} failed of ${policy.started}, status ${policy.status}`,
  );

  // The printed comparison is the point: a disagreement with the chain is a
  // failure, not a footnote.
  if (failedAgents !== policy.failed) {
    console.log(`MISMATCH: ${failedAgents} failed here, contract says ${policy.failed}`);
    process.exitCode = 1;
  }
  if (checked !== policy.started) {
    console.log(`MISMATCH: ${checked} verified here, contract says ${policy.started} started`);
    process.exitCode = 1;
  }

  if (mismatched > 0) process.exitCode = 1;
  if (checked !== posted) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
