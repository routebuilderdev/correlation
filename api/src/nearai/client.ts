import { config, requireApiKey } from "../config.ts";

export interface Completion {
  id: string;
  /** The request body string, as bytes. This is what was hashed. */
  requestBytes: Uint8Array;
  /**
   * The completion content as bytes — the thing the provider signs. For an
   * OpenAI-shaped response that is `choices[0].message.content`, not the HTTP
   * envelope: the fixture's `response.bin` is `{"n":…,"a":…}` and nothing else.
   */
  responseBytes: Uint8Array;
  /** The full HTTP body, kept for logging and debugging only. Never hashed. */
  rawBytes: Uint8Array;
  parsed: unknown;
}

/**
 * Send one completion and keep the bytes that matter exactly as they were.
 *
 * The request is sent as the string it was built from, so the hash is of what
 * actually left. The response is hashed as the *content* value: re-serialising
 * it would produce different bytes and break the signature, so the decoded
 * string is encoded straight back to UTF-8 rather than being re-stringified.
 */
export async function completeExact(model: string, bodyString: string): Promise<Completion> {
  const response = await fetch(`${config.nearaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
      // Identity encoding: a gzip round-trip changes the bytes and breaks signatures.
      "Accept-Encoding": "identity",
      "x-no-aliasing": "true",
      provider: "near",
    },
    body: bodyString,
  });

  const requestBytes = new TextEncoder().encode(bodyString);
  const rawBytes = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    const text = new TextDecoder().decode(rawBytes).slice(0, 400);
    throw new Error(`nearai ${response.status} ${response.statusText}: ${text}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    throw new Error("E21 BAD_JSON: completion response was not JSON");
  }

  return {
    id: extractId(parsed),
    requestBytes,
    responseBytes: extractContentBytes(parsed),
    rawBytes,
    parsed,
  };
}

function extractId(parsed: unknown): string {
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("completion response has no id");
  }
  return id;
}

/** Content bytes, whether the API wraps them in an envelope or returns them bare. */
function extractContentBytes(parsed: unknown): Uint8Array {
  const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;

  const encoder = new TextEncoder();
  if (typeof content === "string") return encoder.encode(content);

  // Some deployments return the verdict object directly; that whole body is the content.
  if (isVerdict(parsed)) return encoder.encode(JSON.stringify(parsed));

  throw new Error("completion response has no message content");
}

function isVerdict(value: unknown): boolean {
  const candidate = value as { n?: unknown; a?: unknown };
  return Number.isInteger(candidate?.n) && Number.isInteger(candidate?.a);
}
