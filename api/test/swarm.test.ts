/**
 * End-to-end without a network: a stubbed provider returns response bytes and
 * signs them with an ephemeral key using the same EIP-191 scheme the model TEE
 * uses. That exercises the real client, the real verifier and the real swarm
 * loop — the parts that a mocked fetch returning canned JSON would skip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Wallet } from "ethers";

import { expectedAnswer, signedText, taskInput } from "@correlation/shared";

process.env.NEARAI_API_KEY = "test-key";
process.env.NEARAI_BASE_URL = "https://example.invalid/v1";
const { runSwarm } = await import("../src/swarm/agents.ts");

const MODEL = "z-ai/glm-5.3-flash";

/** Poisoned agents fail at these indices: 7 of 20. */
const WRONG = new Set([0, 3, 6, 9, 12, 15, 18]);

/** Structural type: ethers returns HDNodeWallet from createRandom(), not Wallet. */
interface EphemeralSigner {
  address: string;
  signingKey: { publicKey: string };
  signMessage(message: string): Promise<string>;
}

function installFakeProvider(wallet: EphemeralSigner, poisoned: boolean): void {
  const records = new Map<string, unknown>();
  let counter = 0;
  // Real completion ids are unique; the verifier caches signatures by id, so a
  // reused id across tests would replay a stale signature and mask a bug.
  const tag = Math.random().toString(36).slice(2, 8);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/chat/completions")) {
      const body = String(init?.body ?? "");
      const n = Number(/n = (\d+)/.exec(body)![1]);
      const index = (n - 10_000_000) % 20;
      const correct = expectedAnswer(n);

      let answer = correct;
      if (poisoned && WRONG.has(index)) answer = correct + 1;
      // An agent that is merely confused still returns schema-valid JSON.
      const content = JSON.stringify({ n, a: answer });
      const id = `cmpl-${tag}-${counter++}`;
      // The signature covers the raw response body, envelope included.
      const envelope = JSON.stringify({ id, choices: [{ message: { content } }] });
      const responseBytes = new TextEncoder().encode(envelope);

      const text = signedText(MODEL, new TextEncoder().encode(body), responseBytes);
      records.set(id, {
        text,
        signature: (await wallet.signMessage(text)).slice(2),
        signing_address: wallet.address,
        signing_public_key: wallet.signingKey.publicKey.slice(4),
        signing_algo: "ecdsa",
        signature_kind: "provider_tee",
      });

      return new Response(envelope, { status: 200 });
    }

    if (url.includes("/signature/")) {
      const id = decodeURIComponent(url.split("/signature/")[1]!.split("?")[0]!);
      return new Response(JSON.stringify(records.get(id)), { status: 200 });
    }

    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
}

test("a control run is twenty correct, verified receipts", async () => {
  const wallet = Wallet.createRandom();
  installFakeProvider(wallet, false);

  const results = await runSwarm({
    policyId: 1,
    windowStartNs: 0n,
    seed: 1,
    poison: false,
    concurrency: 4,
    model: MODEL,
  });

  assert.equal(results.length, 20);
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(results.every((r) => r.signature?.signature_kind === "provider_tee"), true);
  assert.equal(results[0]!.n, taskInput(1, 0));
});

test("a poisoned run is partial failure, and every receipt still verifies", async () => {
  const wallet = Wallet.createRandom();
  installFakeProvider(wallet, true);

  const results = await runSwarm({
    policyId: 1,
    windowStartNs: 0n,
    seed: 1,
    poison: true,
    concurrency: 4,
    model: MODEL,
  });

  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 7);
  assert.equal(results.length - failed.length, 13);

  // The receipts are honest: the signatures check out, the answers are wrong.
  for (const result of results) {
    assert.notEqual(result.signature, null, "every receipt is signed");
    assert.equal(result.signature!.signing_public_key.length, 128);
  }
  assert.equal(
    results.filter((r) => r.error === "wrong answer").length,
    7,
    "poisoned agents are marked wrong, not unverified",
  );
});

test("an unverifiable receipt is an error, not a wrong answer", async () => {
  const wallet = Wallet.createRandom();
  const records = new Map<string, unknown>();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      const body = String(init?.body ?? "");
      const n = Number(/n = (\d+)/.exec(body)![1]);
      const id = `cmpl-${records.size}`;
      const envelope = JSON.stringify({
        id,
        choices: [{ message: { content: JSON.stringify({ n, a: 0 }) } }],
      });
      const responseBytes = new TextEncoder().encode(envelope);
      const text = signedText(MODEL, new TextEncoder().encode(body), responseBytes);
      // Signed by a *different* key than the one it claims.
      records.set(id, {
        text,
        signature: (await wallet.signMessage(text)).slice(2),
        signing_address: "0x0000000000000000000000000000000000000000",
        signing_public_key: "11".repeat(64),
        signing_algo: "ecdsa",
        signature_kind: "provider_tee",
      });
      return new Response(envelope, { status: 200 });
    }
    const id = decodeURIComponent(url.split("/signature/")[1]!.split("?")[0]!);
    const record = records.get(id) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...record, text: `${MODEL}:deadbeef:${"0".repeat(64)}` }), {
      status: 200,
    });
  }) as typeof fetch;

  const results = await runSwarm({
    policyId: 1,
    windowStartNs: 0n,
    seed: 1,
    poison: false,
    concurrency: 1,
    model: MODEL,
  });

  assert.equal(results[0]!.ok, false);
  assert.match(String(results[0]!.error), /E10/);
});
