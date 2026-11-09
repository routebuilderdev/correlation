/**
 * The one place both sides agree on bytes.
 *
 * The contract (`contract/src/verify.rs`) is the reference. Anything here that
 * disagrees with it is a client bug, not a protocol change: if a receipt passes
 * locally and fails on chain, the chain is right.
 *
 * Two hash functions live here and must not be confused (blueprint §6.11 #1):
 *   - inner request/response hashes are sha256, lowercase hex, no 0x;
 *   - the outer EIP-191 digest is keccak256 over the prefixed text.
 */
import { createHash } from "node:crypto";
import { SigningKey, keccak256, toUtf8Bytes } from "ethers";

/** `n * 37 mod 1_000_003`. */
export const TASK_MOD = 1_000_003;
export const TASK_FACTOR = 37;
/** Agents per swarm — also the modulus basis of the derived task input. */
export const AGENT_COUNT = 20;
/** Receipts are accepted for five minutes after the window closes. */
export const RECEIPT_GRACE_NS = 300n * 1_000_000_000n;
/** `\x19Ethereum Signed Message:\n` — the EIP-191 personal-message prefix. */
export const EIP191_PREFIX = "\x19Ethereum Signed Message:\n";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Lowercase hex, `0x`-tolerant in. Rejects odd length and non-hex. */
export function fromHex(input: string): Uint8Array {
  const s = input.startsWith("0x") ? input.slice(2) : input;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`not valid hex: ${input.slice(0, 16)}…`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** sha256 of the bytes exactly as they were received. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `model:sha256(request):sha256(response)` — the text the provider signs.
 *
 * `modelId` must be the canonical id from the response, not the alias that was
 * requested; `x-no-aliasing: true` makes them equal, and the check in
 * `verifyLocal` catches it if they ever are not.
 */
export function signedText(
  modelId: string,
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
): string {
  return `${modelId}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
}

/** `keccak256("\x19Ethereum Signed Message:\n" + decimalLen + text)`. */
export function eip191Digest(text: string): Uint8Array {
  const body = toUtf8Bytes(text);
  const prefix = toUtf8Bytes(`${EIP191_PREFIX}${body.length}`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return fromHex(keccak256(message));
}

/** Verdict predicate: `a === n * 37 mod 1_000_003`. */
export function expectedAnswer(n: number): number {
  return (n * TASK_FACTOR) % TASK_MOD;
}

/**
 * The task input is derived, never chosen: both the orchestrator and the
 * contract compute it from the policy id and the agent's position in the swarm,
 * so there is no mapping to trust. Mirrors `expected_task_input` in
 * `contract/src/receipt.rs`.
 */
export function taskInput(policyId: number, index: number): number {
  return 10_000_000 + (((policyId % 1_000) * AGENT_COUNT + index) % 20_000);
}

/**
 * Uncompressed secp256k1 public key (64 bytes, hex, no 0x04) for the key that
 * produced `signature` over the receipt's digest.
 */
export function recoverReceiptPublicKey(
  text: string,
  signatureHex: string,
): string {
  const digest = `0x${toHex(eip191Digest(text))}`;
  const uncompressed = SigningKey.recoverPublicKey(digest, `0x${signatureHex}`);
  // Drop `0x04`, the SEC1 uncompressed-point marker the contract also omits.
  return uncompressed.slice(4).toLowerCase();
}

/** Strict schema the model must satisfy; the contract parses the same two keys. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: { n: { type: "integer" }, a: { type: "integer" } },
  required: ["n", "a"],
  additionalProperties: false,
} as const;

export interface Verdict {
  n: number;
  a: number;
}

/**
 * Read the verdict out of the response body. Parsing is for reading only — the
 * bytes that were hashed are the raw ones, never a re-stringified object.
 *
 * Accepts both shapes deliberately: a bare `{"n":…,"a":…}` and an OpenAI
 * chat-completions envelope whose `choices[0].message.content` holds it. The
 * provider signs the raw HTTP body, which is the envelope, so the content
 * string is unwrapped here rather than by changing the bytes.
 */
export function parseVerdict(responseBytes: Uint8Array): Verdict {
  const value: unknown = JSON.parse(new TextDecoder().decode(responseBytes));
  if (isVerdict(value)) return value;

  const content = (value as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const inner: unknown = JSON.parse(content);
    if (isVerdict(inner)) return inner;
  }

  throw new Error("E21 BAD_VERDICT_JSON: expected {n, a}, bare or in message content");
}

function isVerdict(value: unknown): value is Verdict {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as Verdict).n) &&
    Number.isInteger((value as Verdict).a)
  );
}
