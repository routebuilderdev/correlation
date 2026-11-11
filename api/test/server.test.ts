import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentResult } from "../src/swarm/agents.ts";

process.env.NEARAI_API_KEY ??= "test-key";
// A run is written to disk when it finishes, tests included. Without this, every
// `npm test` left fake runs next to the real ones, and ?run=<id> could render one.
process.env.RUNS_DIR = mkdtempSync(join(tmpdir(), "correlation-runs-"));
const { buildServer } = await import("../src/server.ts");

function result(index: number, ok: boolean): AgentResult {
  return {
    index,
    agentId: `agent-${String(index + 1).padStart(2, "0")}`,
    n: 10_000_020 + index,
    expected: 123,
    answer: ok ? 123 : 124,
    ok,
    error: ok ? null : "wrong answer",
    completionId: `cmpl-${index}`,
    requestBytes: new TextEncoder().encode("request"),
    responseBytes: new TextEncoder().encode("response"),
    signature: {
      text: "t",
      signature: "ab".repeat(65),
      signing_address: "0xabc",
      signing_public_key: "cd".repeat(64),
      signing_algo: "ecdsa",
      signature_kind: "provider_tee",
    },
  };
}

async function waitFor(
  run: () => Promise<{ status: string }>,
  wanted: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await run()).status === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run never reached ${wanted}`);
}

test("a run goes running -> complete -> evaluating -> triggered", async () => {
  const app = buildServer({
    runSwarm: async () => [result(0, true), result(1, false), result(2, true)],
    submitReceipt: async (r) => `tx-${r.agentId}`,
    evaluate: async () => "tx-evaluate",
    claim: async () => "tx-claim",
    policyView: async () => ({ policy: { status: "Triggered" } }),
  });

  const start = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { mode: "poisoned", policyId: 7 },
  });
  assert.equal(start.statusCode, 202);
  const runId = start.json().runId as string;

  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "triggered");

  const body = (await poll()).json();
  assert.equal(body.policyId, 7);
  assert.equal(body.mode, "poisoned");
  assert.equal(body.results.length, 3);
  assert.deepEqual(body.txHashes, {
    "agent-01": "tx-agent-01",
    "agent-02": "tx-agent-02",
    "agent-03": "tx-agent-03",
  });
  assert.equal(body.evaluateTx, "tx-evaluate");
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[0].requestSha256.length, 64);

  await app.close();
});

test("a duplicate receipt is not reported as an agent failure", async () => {
  const app = buildServer({
    runSwarm: async () => [result(0, true)],
    submitReceipt: async () => {
      throw new Error("E05 DUPLICATE");
    },
    evaluate: async () => "tx-evaluate",
    claim: async () => "tx-claim",
    policyView: async () => ({ policy: { status: "Triggered" } }),
  });

  const start = await app.inject({ method: "POST", url: "/api/runs", payload: { mode: "control" } });
  const runId = start.json().runId as string;
  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "triggered");

  assert.equal((await poll()).json().results[0].error, null);
  await app.close();
});

test("a receipt that lands on a retry leaves no error behind", async () => {
  // Every contract rejection reaches the client as the same opaque wasm trap,
  // and a send can fail after landing. So the run's final state is what counts:
  // once a retry puts the receipt on chain, the earlier E-submit line is
  // history. Leaving it there printed a red cell over a receipt that landed.
  let attempts = 0;
  const app = buildServer({
    runSwarm: async (options) => {
      const first = result(0, true);
      options.onAgent?.(first);
      return [first];
    },
    submitReceipt: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("WebAssembly trap: An `unreachable` opcode was executed.");
      }
      return "tx-agent-01";
    },
    receiptPosted: async () => false,
    evaluate: async () => "tx-evaluate",
    claim: async () => "tx-claim",
    policyView: async () => ({ policy: { status: "Triggered" } }),
  });

  const start = await app.inject({ method: "POST", url: "/api/runs", payload: { mode: "control" } });
  const runId = start.json().runId as string;
  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "triggered");

  const body = (await poll()).json();
  assert.equal(attempts, 2);
  assert.equal(body.results[0].error, null);
  assert.equal(body.txHashes["agent-01"], "tx-agent-01");
  await app.close();
});

test("an arm that stays below the trigger is complete, not triggered", async () => {
  // evaluate() succeeds below the threshold as well: it records the index and
  // returns. The label has to come from the contract, or the control arm showed
  // "triggered" next to a 0% gauge.
  const app = buildServer({
    runSwarm: async () => [result(0, true), result(1, true)],
    submitReceipt: async (r) => `tx-${r.agentId}`,
    evaluate: async () => "tx-evaluate",
    claim: async () => "tx-claim",
    policyView: async () => ({ policy: { status: "Active" } }),
  });

  const start = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { mode: "control", policyId: 7 },
  });
  const runId = start.json().runId as string;
  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "complete");

  const body = (await poll()).json();
  assert.equal(body.status, "complete");
  assert.equal(body.evaluateTx, "tx-evaluate");
  await app.close();
});

test("an unreadable policy view never reports a payout", async () => {
  const app = buildServer({
    runSwarm: async () => [result(0, false)],
    submitReceipt: async () => "tx",
    evaluate: async () => "tx-evaluate",
    claim: async () => "tx-claim",
    policyView: async () => {
      throw new Error("rpc unreachable");
    },
  });

  const start = await app.inject({ method: "POST", url: "/api/runs", payload: { mode: "poisoned" } });
  const runId = start.json().runId as string;
  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "complete");
  assert.equal((await poll()).json().status, "complete");
  await app.close();
});

test("rejects a bad mode and an unknown run", async () => {
  const app = buildServer({
    runSwarm: async () => [],
    submitReceipt: async () => "tx",
    evaluate: async () => "tx",
    claim: async () => "tx-claim",
    policyView: async () => ({}),
  });

  const bad = await app.inject({ method: "POST", url: "/api/runs", payload: { mode: "chaos" } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/runs/nope" })).statusCode, 404);
  await app.close();
});

test("claim returns the payout transaction and surfaces a contract refusal", async () => {
  const app = buildServer({
    runSwarm: async () => [],
    submitReceipt: async () => "tx",
    evaluate: async () => "tx",
    claim: async (policyId) => {
      if (policyId === 2) throw new Error("E02 NOT_ACTIVE");
      return "tx-claim-1";
    },
    policyView: async () => ({}),
  });

  const paid = await app.inject({ method: "POST", url: "/api/claim", payload: { policyId: 1 } });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().txHash, "tx-claim-1");

  const refused = await app.inject({ method: "POST", url: "/api/claim", payload: { policyId: 2 } });
  assert.equal(refused.statusCode, 502);
  assert.match(refused.json().error, /E02/);
  await app.close();
});

test("a reload is served the newest recorded run for its policy", async () => {
  const { saveRun } = await import("../src/store.ts");
  const recorded = (id: string, policyId: number, startedAt: string) => ({
    id,
    policyId,
    mode: "control",
    status: "complete",
    startedAt,
    error: null,
    evaluateTx: null,
    txHashes: {},
    results: [],
  });
  await saveRun("run-older-1", recorded("run-older-1", 9, "2026-11-11T10:00:00.000Z"));
  await saveRun("run-newer-2", recorded("run-newer-2", 9, "2026-11-11T12:00:00.000Z"));
  await saveRun("run-other-3", recorded("run-other-3", 10, "2026-11-11T13:00:00.000Z"));

  const app = buildServer({
    runSwarm: async () => [],
    submitReceipt: async () => "tx",
    evaluate: async () => "tx",
    claim: async () => "tx-claim",
    policyView: async () => ({}),
  });

  const newest = await app.inject({ method: "GET", url: "/api/policy/9/run" });
  assert.equal(newest.statusCode, 200);
  assert.equal(newest.json().id, "run-newer-2");

  const none = await app.inject({ method: "GET", url: "/api/policy/11/run" });
  assert.equal(none.statusCode, 404);

  const bad = await app.inject({ method: "GET", url: "/api/policy/zero/run" });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("health reports configuration without leaking the key", async () => {
  const app = buildServer({
    runSwarm: async () => [],
    submitReceipt: async () => "tx",
    evaluate: async () => "tx",
    claim: async () => "tx-claim",
    policyView: async () => ({}),
  });
  const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
  assert.equal(body.ok, true);
  assert.equal(body.model.length > 0, true);
  assert.equal(JSON.stringify(body).includes(process.env.NEARAI_API_KEY!), false);
  await app.close();
});
