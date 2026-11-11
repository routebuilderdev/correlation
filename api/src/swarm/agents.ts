import { VERDICT_SCHEMA, expectedAnswer, taskInput } from "@correlation/shared";

import { config } from "../config.ts";
import { completeExact } from "../nearai/client.ts";
import {
  SignatureUnavailable,
  fetchSignature,
  verifyLocally,
  type SignatureRecord,
} from "../nearai/verify.ts";
import { systemPrompt } from "./poison.ts";
import { agentId, promptFor } from "./task.ts";

export interface AgentResult {
  index: number;
  agentId: string;
  n: number;
  expected: number;
  answer: number | null;
  ok: boolean;
  /** Contract error code when the agent produced nothing usable. */
  error: string | null;
  completionId: string | null;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  signature: SignatureRecord | null;
}

export interface SwarmOptions {
  policyId: number;
  windowStartNs: bigint;
  seed: number;
  poison: boolean;
  concurrency?: number;
  model?: string;
  /** Fires as each agent settles, so the UI fills in instead of waiting. */
  onAgent?: (result: AgentResult) => void;
}

/**
 * The request body is built once as a string and sent as that string. The same
 * string is what gets hashed, so the signed text is reproducible offline.
 */
export function buildBody(model: string, system: string, n: number): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: promptFor(n) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA },
    },
    temperature: 0,
    stream: false,
  });
}

async function runAgent(
  policyId: number,
  index: number,
  poison: boolean,
  model: string,
): Promise<AgentResult> {
  const n = taskInput(policyId, index);
  const expected = expectedAnswer(n);
  const id = agentId(index);
  const body = buildBody(model, systemPrompt(poison), n);

  const result: AgentResult = {
    index,
    agentId: id,
    n,
    expected,
    answer: null,
    ok: false,
    error: null,
    completionId: null,
    requestBytes: new TextEncoder().encode(body),
    responseBytes: new Uint8Array(),
    signature: null,
  };

  // A completion is only useful to us if it is signed. When NEAR AI is busy, a
  // request can be served outside the enclave: the answer looks fine and its
  // signature never appears, so it has to be asked again rather than recorded as
  // a failure. Deterministic verification failures are never retried.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= config.swarmAttempts; attempt += 1) {
    try {
      const completion = await completeExact(model, body);
      result.completionId = completion.id;
      result.responseBytes = completion.responseBytes;

      const record = await fetchSignature(completion.id, model, "ecdsa");
      result.signature = record;
      const verified = await verifyLocally(
        record,
        completion.requestBytes,
        completion.responseBytes,
        model,
        undefined,
      );
      result.answer = verified.verdict.a;
      result.ok = verified.ok;
      if (!verified.ok) result.error = "wrong answer";
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof SignatureUnavailable ||
        /aborted due to timeout|fetch failed|ECONN/i.test(message);
      if (!retryable) break;
      // A signature lookup can land on a different instance than the one that
      // served the completion (docs.near.ai: direct endpoints keep signatures in
      // per-instance memory, cloud-api#1087), so an instant second ask tends to
      // reach the same instance and miss again. Back off a little.
      if (attempt < config.swarmAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * attempt + Math.random() * 300),
        );
      }
    }
  }

  result.error =
    lastError instanceof Error ? lastError.message : String(lastError);
  return result;
}

/** Twenty runs, `concurrency` at a time. Never twenty at once (§7.3). */
export async function runSwarm(options: SwarmOptions): Promise<AgentResult[]> {
  const model = options.model ?? config.model;
  const concurrency = options.concurrency ?? config.concurrency;
  const indices = Array.from({ length: 20 }, (_, i) => i);
  const results: AgentResult[] = new Array(indices.length);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < indices.length) {
      const index = indices[cursor++]!;
      results[index] = await runAgent(
        options.policyId,
        index,
        options.poison,
        model,
      );
      options.onAgent?.(results[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, indices.length) }, () =>
      worker(),
    ),
  );

  // A cell with no signature is a hole the contract will not accept: it needs
  // every agent (`trigger.rs`: `started >= min_agents`), so one unsigned agent
  // makes the policy unpayable no matter how many failures the rest produced.
  // Re-run just the missing agents as whole new completions — the only useful
  // answer to a signature that never appears — twice at most.
  for (let pass = 0; pass < 2; pass += 1) {
    const missing = results.filter((result) => result && !result.signature);
    if (!missing.length) break;
    for (const previous of missing) {
      results[previous.index] = await runAgent(
        options.policyId,
        previous.index,
        options.poison,
        model,
      );
      options.onAgent?.(results[previous.index]!);
    }
  }
  return results;
}
