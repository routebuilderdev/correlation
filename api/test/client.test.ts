import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEARAI_API_KEY = "test-key";
process.env.NEARAI_BASE_URL = "https://example.invalid/v1";
const { completeExact } = await import("../src/nearai/client.ts");

interface Seen {
  url: string;
  init: RequestInit;
}

function stubFetch(body: string, status = 200): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return seen;
}

const CONTENT = '{"n":10000022,"a":999707}';
const RESPONSE = JSON.stringify({ id: "cmpl_123", choices: [{ message: { content: CONTENT } }] });

test("sends the body string untouched and hashes those same bytes", async () => {
  const seen = stubFetch(RESPONSE);
  const body = '{"model":"m","temperature":0}  ';

  const completion = await completeExact("m", body);

  assert.equal(seen[0]!.url, "https://example.invalid/v1/chat/completions");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal(seen[0]!.init.body, body);
  assert.equal(new TextDecoder().decode(completion.requestBytes), body);
  // The signature covers the exact body, envelope included — not the content.
  assert.equal(new TextDecoder().decode(completion.responseBytes), RESPONSE);
  assert.equal(completion.id, "cmpl_123");
});

test("sends the headers that make the signature checkable", async () => {
  const seen = stubFetch(RESPONSE);
  await completeExact("m", "{}");

  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Accept-Encoding"], "identity");
  assert.equal(headers["x-no-aliasing"], "true");
  assert.equal(headers.provider, "near");
  assert.equal(headers.Authorization, "Bearer test-key");
});

test("a non-2xx response fails instead of being hashed as a receipt", async () => {
  stubFetch('{"error":"quota"}', 402);
  await assert.rejects(() => completeExact("m", "{}"), /nearai 402/);
});

test("a response without an id fails", async () => {
  stubFetch("{}");
  await assert.rejects(() => completeExact("m", "{}"), /no id/);
});

