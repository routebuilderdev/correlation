import { config, requireApiKey } from "../config.ts";

export interface Completion {
  id: string;
  /** The request body string, as bytes. This is what was hashed. */
  requestBytes: Uint8Array;
  /**
   * The exact response body bytes — the thing the provider signs. NEAR AI's
   * spec is explicit: `response_hash = SHA-256(exact response-body bytes)`,
   * "do not parse and re-serialize JSON". So this is the raw body, envelope
   * included; unwrapping the content happens when the verdict is *read*, never
   * when it is hashed.
   */
  responseBytes: Uint8Array;
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
    signal: AbortSignal.timeout(config.completionTimeoutMs),
  });

  const requestBytes = new TextEncoder().encode(bodyString);
  const responseBytes = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    const text = new TextDecoder().decode(responseBytes).slice(0, 400);
    throw new Error(`nearai ${response.status} ${response.statusText}: ${text}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(responseBytes));
  } catch {
    throw new Error("E21 BAD_JSON: completion response was not JSON");
  }

  return { id: extractId(parsed), requestBytes, responseBytes, parsed };
}

function extractId(parsed: unknown): string {
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("completion response has no id");
  }
  return id;
}


