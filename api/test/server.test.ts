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
    policyView: async () => ({ status: "Active" }),
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
    policyView: async () => ({}),
  });

  const start = await app.inject({ method: "POST", url: "/api/runs", payload: { mode: "control" } });
  const runId = start.json().runId as string;
  const poll = () => app.inject({ method: "GET", url: `/api/runs/${runId}` });
  await waitFor(async () => (await poll()).json(), "triggered");

  assert.equal((await poll()).json().results[0].error, null);
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
