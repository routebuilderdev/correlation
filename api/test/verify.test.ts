import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ReceiptError, verifyLocally, type SignatureRecord } from "../src/nearai/verify.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "contract", "tests", "fixtures");
const MODEL = "z-ai/glm-5.3-flash";
const requestBytes = new Uint8Array(readFileSync(join(FIXTURES, "request.bin")));
const responseBytes = new Uint8Array(readFileSync(join(FIXTURES, "response.bin")));
const record = JSON.parse(
  readFileSync(join(FIXTURES, "signature.json"), "utf8"),
) as SignatureRecord;

function codeOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "no error",
    (error: unknown) => (error instanceof ReceiptError ? error.code : `raw:${String(error)}`),
  );
}

test("accepts the fixture the contract also accepts", async () => {
  const verified = await verifyLocally(
    record,
    requestBytes,
    responseBytes,
    MODEL,
    record.signing_public_key,
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.verdict.n, 10_000_022);
  assert.equal(verified.recovered, record.signing_public_key);
});

test("one flipped byte is E10, exactly like the chain", async () => {
  const tampered = responseBytes.slice();
  tampered[tampered.length - 1]! ^= 0x01;
  assert.equal(
    await codeOf(() => verifyLocally(record, requestBytes, tampered, MODEL)),
    "E10",
  );
});

test("a gateway signature is E07", async () => {
  const gateway = { ...record, signature_kind: "gateway" };
  assert.equal(
    await codeOf(() => verifyLocally(gateway, requestBytes, responseBytes, MODEL)),
    "E07",
  );
});

test("a non-ecdsa algorithm is E08", async () => {
  const ed = { ...record, signing_algo: "ed25519" };
  assert.equal(
    await codeOf(() => verifyLocally(ed, requestBytes, responseBytes, MODEL)),
    "E08",
  );
});

test("a different model is E09", async () => {
  assert.equal(
    await codeOf(() =>
      verifyLocally(record, requestBytes, responseBytes, "other/model"),
    ),
    "E09",
  );
});

test("an unexpected signer is E11", async () => {
  assert.equal(
    await codeOf(() =>
      verifyLocally(record, requestBytes, responseBytes, MODEL, "11".repeat(64)),
    ),
    "E11",
  );
});
