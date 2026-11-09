/**
 * Capture one real completion and its signature into `contract/tests/fixtures/`.
 *
 * Run this the moment `NEARAI_API_KEY` exists: it turns the synthetic fixture
 * into a real one, so T3 and the integration tests verify bytes the model TEE
 * actually signed. It refuses to write anything unless the signature verifies
 * locally first, so a bad capture cannot quietly replace a good fixture.
 *
 * Captures policy 1 / agent index 2, which is what `test_receipt.rs` expects.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectedAnswer, parseVerdict, taskInput } from "@correlation/shared";

import { config } from "../src/config.ts";
import { completeExact } from "../src/nearai/client.ts";
import { fetchSignature, verifyLocally } from "../src/nearai/verify.ts";
import { buildBody } from "../src/swarm/agents.ts";
import { CONTROL_CONTEXT } from "../src/swarm/poison.ts";

const POLICY_ID = 1;
const AGENT_INDEX = 2;
const FIXTURES = join(import.meta.dirname, "..", "..", "contract", "tests", "fixtures");

const n = taskInput(POLICY_ID, AGENT_INDEX);
const body = buildBody(config.model, CONTROL_CONTEXT, n);

process.stdout.write(`model   ${config.model}\nendpoint ${config.nearaiBaseUrl}\ntask    n=${n}\n`);

const completion = await completeExact(config.model, body);
process.stdout.write(`completion ${completion.id}\n`);

const record = await fetchSignature(completion.id, config.model, "ecdsa");
const verified = await verifyLocally(
  record,
  completion.requestBytes,
  completion.responseBytes,
  config.model,
);
const verdict = parseVerdict(completion.responseBytes);

if (!verified.ok) {
  throw new Error(
    `the model answered wrongly (n=${verdict.n}, a=${verdict.a}, expected ${expectedAnswer(verdict.n)}); ` +
      "fix the prompt before capturing a fixture",
  );
}
if (verdict.n !== n) {
  throw new Error(`E13 TASK_MISMATCH: asked for n=${n}, model answered n=${verdict.n}`);
}
if (record.signature_kind !== "provider_tee") {
  throw new Error(
    `E07 NOT_PROVIDER_TEE: signature_kind=${record.signature_kind}. ` +
      "Point NEARAI_BASE_URL at a direct *.completions.near.ai endpoint, not the gateway.",
  );
}

mkdirSync(FIXTURES, { recursive: true });
writeFileSync(join(FIXTURES, "request.bin"), completion.requestBytes);
writeFileSync(join(FIXTURES, "response.bin"), completion.responseBytes);
writeFileSync(join(FIXTURES, "signature.json"), `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(
  join(FIXTURES, "signer.json"),
  `${JSON.stringify(
    {
      public_key: record.signing_public_key,
      address: record.signing_address,
      note: `captured ${new Date().toISOString()} from ${completion.id}; policy ${POLICY_ID} / agent index ${AGENT_INDEX}`,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(
  `verified ${record.signing_public_key.slice(0, 16)}… ✓\nwrote fixtures to ${FIXTURES}\n`,
);
