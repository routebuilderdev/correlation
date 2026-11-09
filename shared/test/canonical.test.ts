/**
 * Cross-language vectors: every expectation here is a value the Rust contract
 * already asserts against the same files, so a disagreement fails on one side
 * instead of silently drifting.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  RECEIPT_GRACE_NS,
  expectedAnswer,
  eip191Digest,
  fromHex,
  parseVerdict,
  recoverReceiptPublicKey,
  sha256Hex,
  signedText,
  taskInput,
  toHex,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "contract", "tests", "fixtures");
const MODEL = "z-ai/glm-5.3-flash";

const requestBytes = new Uint8Array(readFileSync(join(FIXTURES, "request.bin")));
const responseBytes = new Uint8Array(readFileSync(join(FIXTURES, "response.bin")));
const signature = JSON.parse(
  readFileSync(join(FIXTURES, "signature.json"), "utf8"),
) as {
  text: string;
  signature: string;
  signing_public_key: string;
  signing_address: string;
  signing_algo: string;
  signature_kind: string;
};

test("sha256 matches the hash the provider signed", () => {
  const [model, requestHash, responseHash] = signature.text.split(":");
  assert.equal(model, MODEL);
  assert.equal(sha256Hex(requestBytes), requestHash);
  assert.equal(sha256Hex(responseBytes), responseHash);
});

test("signedText rebuilds the exact signed string", () => {
  assert.equal(signedText(MODEL, requestBytes, responseBytes), signature.text);
});

test("the signature recovers the pinned public key", () => {
  const recovered = recoverReceiptPublicKey(signature.text, signature.signature);
  assert.equal(recovered, signature.signing_public_key);
});

test("one flipped byte changes the recovered signer", () => {
  const tampered = responseBytes.slice();
  tampered[tampered.length - 1]! ^= 0x01;
  const recovered = recoverReceiptPublicKey(
    signedText(MODEL, requestBytes, tampered),
    signature.signature,
  );
  assert.notEqual(recovered, signature.signing_public_key);
});

test("the verdict satisfies the arithmetic the contract recomputes", () => {
  const verdict = parseVerdict(responseBytes);
  assert.equal(verdict.n, 10_000_022);
  assert.equal(verdict.a, expectedAnswer(verdict.n));
  assert.equal(verdict.a, 999_707);
});

test("taskInput is derived, not chosen", () => {
  assert.equal(taskInput(1, 2), 10_000_022);
  // The policy offset is part of the input: policy 1 starts at 10_000_020.
  assert.equal(taskInput(1, 0), 10_000_020);
  assert.equal(taskInput(1, 19), 10_000_039);
  assert.equal(taskInput(2, 0), 10_000_040);
  // Unique within a policy for N <= 20_000: the modulo keeps indices apart.
  assert.notEqual(taskInput(1, 3), taskInput(1, 4));
});

test("digest is 32 bytes and prefixed per EIP-191", () => {
  assert.equal(eip191Digest(signature.text).length, 32);
  assert.equal(fromHex(toHex(eip191Digest(signature.text))).length, 32);
});

test("grace period matches the contract constant", () => {
  assert.equal(RECEIPT_GRACE_NS, 300_000_000_000n);
});

test("a non-verdict body is rejected rather than coerced", () => {
  assert.throws(() => parseVerdict(new TextEncoder().encode('{"n":"1000","a":1}')));
  assert.throws(() => parseVerdict(new TextEncoder().encode("not json")));
});
