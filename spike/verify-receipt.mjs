/**
 * Spike: can a NEAR contract verify a NEAR AI Cloud response receipt?
 *
 * The contract can only compute sha256 and check one signature. So the spike
 * asks exactly one question:
 *
 *   Given (request bytes, response bytes, model id, signer public key),
 *   does the provider_tee signature verify, with no other input?
 *
 * If yes, the contract needs ~one signature check plus arithmetic.
 * If no, we cannot build the trigger this way and must fall back.
 *
 * Observed 2026-11-09 from the public attestation report (no key required):
 *   - NEAR-hosted TEE models (e.g. z-ai/glm-5.3-flash) expose a model signer
 *     with signing_algo "ecdsa" and a 20-byte address plus a 64-byte
 *     signing_public_key. The contract therefore needs secp256k1 recovery
 *     (EIP-191 prefix applied by hand), NOT ed25519_verify.
 *   - Chutes-hosted models (kimi-k2.6/k3, deepseek-v3.2, qwen3.5-397b) and
 *     Tinfoil-hosted z-ai/glm-5.3 expose NO model signer: gateway-only,
 *     so they cannot prove model TEE execution and are out of scope.
 *   - Gateway and OHTTP keys are ed25519, so any code touching both needs
 *     both curves.
 *
 * Usage:
 *   NEARAI_API_KEY=... node verify-receipt.mjs [--model <id>] [--no-sdk]
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = blocked (missing credential / no TEE model)
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const KEY = process.env.NEARAI_API_KEY;
const ARGS = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};
const MODEL = argOf('--model', process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash');
const RUN_SDK = !ARGS.includes('--no-sdk');
const OUT_DIR = new URL('./out/', import.meta.url);

const results = [];
let silenced = 0;
const record = (step, ok, detail) => {
  if (silenced > 0) return;
  results.push({ step, ok, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO';
  console.log(`[${mark}] ${step}${detail ? ` — ${detail}` : ''}`);
};

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unhex = (v) => Buffer.from(v.replace(/^0x/i, ''), 'hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

function fail(step, detail) {
  record(step, false, detail);
  console.log('\nRESULT: FAIL — the contract-verifiable path does not hold as built.');
  process.exit(1);
}

if (ARGS.includes('--selftest')) {
  await selftest();
  process.exit(results.every((r) => r.ok !== false) ? 0 : 1);
}

if (!KEY) {
  console.log('[INFO] NEARAI_API_KEY is not set. The catalog is public, completions are not.');
  console.log('       Set NEARAI_API_KEY and re-run. Nothing else is blocked.');
  process.exit(2);
}

const auth = { authorization: `Bearer ${KEY}` };

/** 1. Pick a model whose attestation says it is TEE-backed. */
async function pickModel() {
  const res = await fetch(`${BASE}/models`, { headers: { 'accept-encoding': 'identity' } });
  const body = await res.json();
  const all = body?.data ?? [];
  record('catalog reachable', res.ok, `${all.length} models`);

  const wanted = all.find((m) => m.id === MODEL);
  const teeish = all.filter((m) => {
    const s = JSON.stringify(m).toLowerCase();
    return s.includes('tee') || s.includes('attest');
  });
  record('TEE-capable models advertised', teeish.length > 0, `${teeish.length} candidates`);
  if (!wanted) {
    console.log('       not in catalog:', MODEL);
    console.log('       TEE candidates:', teeish.map((m) => m.id).join(', '));
    fail('model selected', `unknown model ${MODEL}`);
  }
  return wanted;
}

/** 2. Fetch attestation and find the signer that will sign our response. */
async function fetchAttestation(model) {
  const res = await fetch(
    `${BASE}/attestation/report?model=${encodeURIComponent(model)}`,
    { headers: { ...auth, 'accept-encoding': 'identity' } },
  );
  if (!res.ok) {
    fail('attestation report', `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('attestation.json', OUT_DIR), JSON.stringify(body, null, 2));

  const candidates =
    body.model_attestations ??
    (body.attestation ? [body.attestation] : []) ??
    [];
  record(
    'attestation candidates returned',
    candidates.length > 0,
    `${candidates.length} node(s)`,
  );
  const algos = [...new Set(candidates.map((c) => c.signing_algo))];
  record('signing algorithms advertised', true, algos.join(', ') || 'none');

  // A model with no per-response signer can only ever yield a `gateway`
  // signature, which does not prove the model TEE produced the bytes.
  // Chutes- and Tinfoil-hosted models are in this class.
  const signers = candidates.filter((c) => c.signing_address && c.signing_algo);
  record(
    'model has a per-response signer',
    signers.length > 0,
    signers.length
      ? `${signers.length} (${signers.map((c) => c.signing_address).join(', ')})`
      : 'none — gateway-only, ineligible for this design',
  );
  return candidates;
}

/** 3. Send one non-streaming Chat Completion, keeping the exact bytes. */
async function sendCompletion(model) {
  const requestText = JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content:
          'Return exactly this JSON and nothing else: {"agent":"a1","task_ok":true}',
      },
    ],
    temperature: 0,
    max_tokens: 64,
  });
  const requestBytes = Buffer.from(requestText, 'utf8');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      'accept-encoding': 'identity',
    },
    body: requestText,
  });
  const responseBytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    fail('completion', `HTTP ${res.status}: ${responseBytes.toString().slice(0, 200)}`);
  }
  const parsed = JSON.parse(responseBytes.toString('utf8'));
  record('completion returned', Boolean(parsed?.id), `id=${parsed?.id}`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('request.bin', OUT_DIR), requestBytes);
  await writeFile(new URL('response.bin', OUT_DIR), responseBytes);
  return { id: parsed.id, requestBytes, responseBytes, parsed };
}

/** 4. Fetch the signature record for that completion. */
async function fetchSignature(id, model, algoCandidates) {
  let lastErr = '';
  for (const algo of [...algoCandidates, undefined]) {
    const qs = new URLSearchParams({ model });
    if (algo) qs.set('signing_algo', algo);
    const res = await fetch(`${BASE}/signature/${encodeURIComponent(id)}?${qs}`, {
      headers: { ...auth, 'accept-encoding': 'identity' },
    });
    if (res.ok) {
      const sig = await res.json();
      await writeFile(new URL('signature.json', OUT_DIR), JSON.stringify(sig, null, 2));
      record('signature fetched', true, `algo=${sig.signing_algo} kind=${sig.signature_kind}`);
      return sig;
    }
    lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  fail('signature fetched', lastErr);
}

/** 5. THE CHECK: rebuild the signed text from our own bytes and verify it. */
async function verifyReceipt({ sig, requestBytes, responseBytes, model, candidates }) {
  const kind = sig.signature_kind;
  record('signature kind is provider_tee', kind === 'provider_tee', String(kind));
  if (kind !== 'provider_tee') {
    // Gateway signatures do not prove the model TEE produced these bytes.
    // Not a crash: we report it, because it changes which model we may use.
    record('model TEE execution proven', false, 'gateway signature — design ineligible');
    return false;
  }

  const expectedText = `${model}:${sha256hex(requestBytes)}:${sha256hex(responseBytes)}`;
  const textMatches = sig.text === expectedText;
  record('signed text reproducible from our bytes', textMatches);
  if (!textMatches) {
    record('  expected', null, expectedText);
    record('  received', null, String(sig.text));
    return false;
  }

  const alg = sig.signing_algo;
  const sigBytes = unhex(sig.signature);
  const address = unhex(sig.signing_address);
  const msg = Buffer.from(sig.text, 'utf8');
  let ok = false;

  if (alg === 'ed25519') {
    if (sigBytes.length !== 64 || address.length !== 32) {
      record('signature shapes', false, `sig=${sigBytes.length}B key=${address.length}B`);
      return false;
    }
    // Raw 32-byte key -> SPKI DER, which is what a NEAR contract gets to use too.
    const spki = Buffer.from('302a300506032b6570032100', 'hex');
    const pub = createPublicKey({
      key: Buffer.concat([spki, address]),
      format: 'der',
      type: 'spki',
    });
    ok = cryptoVerify(null, msg, pub, sigBytes);
    record('ed25519 verify over signed text', ok, 'no EIP-191 prefix on this path');
  } else if (alg === 'ecdsa') {
    if (sigBytes.length !== 65 || address.length !== 20) {
      record('signature shapes', false, `sig=${sigBytes.length}B addr=${address.length}B`);
      return false;
    }
    const { ethers } = await import('ethers');
    const recovered = unhex(ethers.verifyMessage(msg, '0x' + sigBytes.toString('hex')));
    ok = same(recovered, address);
    record('ecdsa recover + EIP-191 prefix', ok, 'contract must prepend the prefix itself');
  } else {
    fail('signing_algo supported', `unsupported algo ${alg}`);
  }

  if (!ok) return false;

  // 6. The signer must be the one named in the attestation we already trust.
  const match = candidates.find(
    (c) =>
      c.signing_algo === alg &&
      ((c.signing_address && same(unhex(c.signing_address), address)) ||
        (c.signing_public_key && same(unhex(c.signing_public_key), unhex(sig.signing_public_key ?? ''))) ),
  );
  record('signer appears in attestation candidates', Boolean(match));

  return ok && Boolean(match);
}

/**
 * Self-test: feed the verifier receipts we signed ourselves with both curves.
 * If these fail, the harness is wrong; if they pass, a later failure is the
 * service's, not ours. Also exercises the EIP-191 path the contract must match.
 */
async function selftest() {
  const { generateKeyPairSync, sign: cryptoSign } = await import('node:crypto');
  const requestBytes = Buffer.from('{"model":"selftest","messages":[]}', 'utf8');
  const responseBytes = Buffer.from('{"id":"chatcmpl-selftest"}', 'utf8');
  const model = 'selftest/model';
  const text = `${model}:${sha256hex(requestBytes)}:${sha256hex(responseBytes)}`;

  record('canonical text shape', text.split(':').length === 3, text);

  // --- ed25519: the path a NEAR contract can check natively ---
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const sigBytes = cryptoSign(null, Buffer.from(text, 'utf8'), privateKey);
    const ok = await verifyReceipt({
      sig: {
        text,
        signature: sigBytes.toString('hex'),
        signing_address: rawPub.toString('hex'),
        signing_algo: 'ed25519',
        signature_kind: 'provider_tee',
      },
      requestBytes,
      responseBytes,
      model,
      candidates: [{ signing_address: rawPub.toString('hex'), signing_algo: 'ed25519' }],
    });
    record('SELFTEST ed25519 accepted', ok === true);

    // Negative: flip one byte and confirm rejection.
    const bad = Buffer.from(sigBytes);
    bad[0] ^= 0xff;
    silenced++;
    const rejected = await verifyReceipt({
      sig: {
        text,
        signature: bad.toString('hex'),
        signing_address: rawPub.toString('hex'),
        signing_algo: 'ed25519',
        signature_kind: 'provider_tee',
      },
      requestBytes,
      responseBytes,
      model,
      candidates: [{ signing_address: rawPub.toString('hex'), signing_algo: 'ed25519' }],
    });
    silenced--;
    record('SELFTEST ed25519 tamper rejected', rejected === false, 'forged byte must not verify');
  }

  // --- ecdsa: EIP-191 prefix must be applied, not assumed ---
  {
    const { ethers } = await import('ethers');
    const wallet = ethers.Wallet.createRandom();
    const sig = await wallet.signMessage(text);
    const ok = await verifyReceipt({
      sig: {
        text,
        signature: sig.replace(/^0x/, ''),
        signing_address: wallet.address.toLowerCase().replace(/^0x/, ''),
        signing_algo: 'ecdsa',
        signature_kind: 'provider_tee',
      },
      requestBytes,
      responseBytes,
      model,
      candidates: [
        {
          signing_address: wallet.address.toLowerCase().replace(/^0x/, ''),
          signing_algo: 'ecdsa',
        },
      ],
    });
    record('SELFTEST ecdsa/EIP-191 accepted', ok === true);
  }
}

/** 7. Independent check with the official verifier, for cross-reference only. */
async function sdkCrossCheck(model) {
  try {
    const { InferenceClient } = await import('@nearai/inference-sdk/node');
    const client = new InferenceClient({ baseUrl: BASE, apiKey: KEY, e2ee: false });
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with the word ok.' }],
    });
    const verified = await client.verifyResponse(completion.id);
    record('official SDK verifyResponse', true, `kind=${verified.signatureKind}`);
  } catch (err) {
    record('official SDK verifyResponse', false, String(err?.message ?? err).slice(0, 300));
  }
}

const model = await pickModel();
const candidates = await fetchAttestation(model.id);
const algos = [...new Set(candidates.map((c) => c.signing_algo).filter(Boolean))];

const { id, requestBytes, responseBytes } = await sendCompletion(model.id);
const sig = await fetchSignature(id, model.id, algos);

const passed = await verifyReceipt({
  sig,
  requestBytes,
  responseBytes,
  model: model.id,
  candidates,
});

if (RUN_SDK) await sdkCrossCheck(model.id);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  new URL('spike-report.json', OUT_DIR),
  JSON.stringify(
    { model: model.id, base: BASE, passed, steps: results, checkedAt: new Date().toISOString() },
    null,
    2,
  ),
);

console.log(passed ? '\nRESULT: PASS — contract-verifiable.' : '\nRESULT: FAIL — see steps above.');
process.exit(passed ? 0 : 1);
