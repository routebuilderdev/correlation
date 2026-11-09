import { config, requireApiKey } from "../config.ts";

export interface Completion {
  id: string;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  parsed: unknown;
}

/**
 * Send one completion and keep the bytes exactly as they crossed the wire.
 *
 * The whole trust argument depends on not re-encoding: `requestBytes` is the
 * string actually posted, `responseBytes` is whatever came back, and both are
 * what the provider hashed when it signed. Never `JSON.parse` then
 * `JSON.stringify` before hashing.
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

  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("completion response has no id");
  }

  return { id, requestBytes, responseBytes, parsed };
}
