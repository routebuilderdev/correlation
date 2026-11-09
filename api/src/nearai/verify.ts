/**
 * A local mirror of `contract/src/verify.rs`. It must reach the same verdict on
 * the same inputs, including which error it raises — when they disagree, the
 * contract is right and this file is the bug.
 */
import { config, requireApiKey } from "../config.ts";
import {
  expectedAnswer,
  parseVerdict,
  recoverReceiptPublicKey,
  signedText,
  type Verdict,
} from "@correlation/shared";

export interface SignatureRecord {
  text: string;
  signature: string;
  signing_address: string;
  signing_public_key: string;
  signing_algo: string;
  signature_kind: string;
  /** Present on some provider responses; when it is, it must agree. */
  model?: string;
}

export interface VerifiedReceipt {
  ok: boolean;
  verdict: Verdict;
  /** Uncompressed pubkey that actually produced the signature, no 0x04. */
  recovered: string;
  signer: string;
  text: string;
}

export class ReceiptError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code} ${message}`);
  }
}

/** `GET /signature/:id` — cached per id for the life of the process. */
const signatureCache = new Map<string, SignatureRecord>();

export async function fetchSignature(
  id: string,
  model: string,
  algo: "ecdsa" = "ecdsa",
): Promise<SignatureRecord> {
  const cached = signatureCache.get(id);
  if (cached) return cached;

  const url = new URL(`${config.nearaiBaseUrl}/signature/${encodeURIComponent(id)}`);
  url.searchParams.set("model", model);
  url.searchParams.set("signing_algo", algo);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Accept-Encoding": "identity",
      "x-no-aliasing": "true",
    },
  });
  if (!response.ok) {
    throw new Error(`signature ${response.status} for completion ${id}`);
  }

  const record = (await response.json()) as SignatureRecord;
  signatureCache.set(id, record);
  return record;
}

/**
 * Same checks, same order, same codes as `post_receipt`.
 * `expectedSigner` is the key the contract has registered; when omitted the
 * record's own claim is returned for the caller to compare.
 */
export async function verifyLocally(
  record: SignatureRecord,
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  model: string,
  expectedSigner?: string,
): Promise<VerifiedReceipt> {
  if (typeof record.text !== "string" || typeof record.signature !== "string") {
    throw new ReceiptError("E06", "BAD_SIGNATURE_JSON");
  }
  if (record.signature_kind !== "provider_tee") {
    throw new ReceiptError(
      "E07",
      `NOT_PROVIDER_TEE: signature_kind=${record.signature_kind}`,
    );
  }
  if (record.signing_algo !== "ecdsa") {
    throw new ReceiptError("E08", `UNSUPPORTED_ALGO: ${record.signing_algo}`);
  }

  // The model id lives inside the signed text, so aliasing shows up here first
  // (§3.2.1). Same order as the contract: model, then bytes.
  const textModel = record.text.split(":", 1)[0];
  if (textModel !== model) {
    throw new ReceiptError("E09", `WRONG_MODEL: signed by ${textModel}`);
  }
  if (record.model !== undefined && record.model !== model) {
    throw new ReceiptError("E09", `WRONG_MODEL: response claims ${record.model}`);
  }

  const text = signedText(model, requestBytes, responseBytes);
  if (record.text !== text) {
    throw new ReceiptError(
      "E10",
      `TEXT_MISMATCH\nexpected ${text}\nreceived ${record.text}`,
    );
  }

  const recovered = recoverReceiptPublicKey(record.text, record.signature);
  if (expectedSigner && recovered !== expectedSigner.toLowerCase()) {
    throw new ReceiptError("E11", `UNKNOWN_SIGNER: ${recovered.slice(0, 16)}…`);
  }

  const verdict = parseVerdict(responseBytes);
  const expectedN = extractTaskInput(requestBytes);
  if (expectedN !== null && verdict.n !== expectedN) {
    throw new ReceiptError(
      "E13",
      `TASK_MISMATCH: policy expects n=${expectedN}, model answered n=${verdict.n}`,
    );
  }

  return {
    ok: verdict.a === expectedAnswer(verdict.n),
    verdict,
    recovered,
    signer: expectedSigner ?? record.signing_public_key,
    text: record.text,
  };
}

/**
 * The task input is echoed in the user message so a run can be replayed; the
 * contract derives it from (policy id, agent index) and ignores this copy.
 */
function extractTaskInput(requestBytes: Uint8Array): number | null {
  const body = new TextDecoder().decode(requestBytes);
  const match = /n = (\d+)/.exec(body);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/**
 * Runs once per signer per day, not per receipt: it answers "is this model
 * really running the code it claims", not "did this call happen".
 */
export async function verifyAttestation(model: string): Promise<{
  pubkey: string;
  composeHash: string;
  policyHash: string;
}> {
  const sdk = await import("@nearai/inference-sdk").catch(() => null);
  if (!sdk) {
    throw new Error("@nearai/inference-sdk is not installed");
  }
  const attestation = await (
    sdk as unknown as {
      verifyResponse?: (model: string) => Promise<Record<string, any>>;
    }
  ).verifyResponse?.(model);

  if (!attestation) {
    throw new Error(`no attestation returned for ${model}`);
  }
  return {
    pubkey: String(attestation["pubkey"] ?? attestation["signing_public_key"] ?? ""),
    composeHash: String(attestation["composeHash"] ?? attestation["compose_hash"] ?? ""),
    policyHash: String(attestation["policyHash"] ?? attestation["policy_hash"] ?? ""),
  };
}
