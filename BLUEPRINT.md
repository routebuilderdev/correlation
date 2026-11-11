# Correlation — Build Blueprint

**Status:** Ready to build (one blocking credential)
**Written:** 2026-11-09
**Deadline:** 2026-11-14T23:59:00Z — five days
**Repo:** this repository
**Scope:** self-contained build plan — what to build and how

This is the build document. It is prescriptive on purpose: names, files, interfaces, order, acceptance criteria. It is the single source of truth; §1.1 records the assumptions it supersedes.

---

## 0. How to read this

| If you want… | Read |
|---|---|
| The pitch | §2 |
| What is proven and what is assumed | §3, §4 |
| How the system fits together | §5 |
| Contract detail | §6 |
| Off-chain services | §7 |
| Screens | §8 |
| Every file to create | §9 |
| Day-by-day plan | §11 |
| What to say on stage | §13 |
| What will go wrong | §15 |

---

## 1. Decisions locked

These are settled. Do not reopen them during the build; changes go in the decision log at the end.

| # | Decision | Rationale | Consequence |
|---|---|---|---|
| **D1** | Deterministic on-chain trigger; TEE attests evidence only | Arithmetic in an enclave adds cost and trust without adding verification. A contract re-counts from signed inputs. | Contract does one signature check per receipt plus counting. |
| **D2** | Phala dropped | The decision is deterministic and public; an enclave adds nothing. | One pitch line; no Docker Compose deploy. |
| **D3** | Git repo created, checkpoint committed | Undo exists from hour zero. | Two commits already in place. |
| **D4** | Model pinned to a **NEAR-hosted** TEE model | Only these expose a per-response model signer (§3.2). | `z-ai/glm-5.3-flash` for the demo, with a second pinned fallback. |
| **D5** | Signatures verified as **secp256k1 + EIP-191** | The model signer is `ecdsa`, not ed25519 (§3.2). | Contract uses `ecrecover` + `keccak256`, not `ed25519_verify`. |
| **D6** | Non-streaming, Chat Completions only | Streaming and Responses/Messages yield gateway signatures (§3.1). | One HTTP path. No SSE handling. |
| **D7** | Raw request **and** response bytes submitted on-chain | The contract must hash them itself, or it cannot bind the verdict to the signature (§5.4). | ~1 KB of calldata per receipt; no trust in the orchestrator's mapping. |
| **D8** | Pool denominated in native NEAR for the MVP | Removes a NEP-141 token dependency on testnet. | `token: Option<AccountId>` reserved for production; NEP-141 named as future work. |
| **D9** | Demo failure predicate is objectively checkable by the contract | Removes "who decides failed?" — the contract recomputes the answer itself (§5.5). | Swarm task is arithmetic, not vibes. Production rubric described but not built. |
| **D10** | Chain writes signed by a backend testnet key; UI is read-mostly | Wallet selector is a day of work and a class of demo failures. | Disclose honestly; wallet connect is a stretch goal, not a dependency. |
| **D11** | Trust root is the pinned `signing_public_key`; `compose_hash` is recorded evidence, never enforced | The measurement was observed to differ between candidates for the same model; the key did not. | Never reject a receipt on measurement mismatch. `provider=near` + `x-no-aliasing: true` on every call (§3.2.1). |

### 1.1 Superseded assumptions

| Earlier assumption | Was | Now |
|---|---|---|
| Signature scheme | Either Ed25519 or ECDSA | **ecdsa only** for the model signer; D5 |
| Verifying against the attested signer | Implicit trust in a submitted verdict | **Contract re-derives the verdict from bytes**; D7 |
| Receipt schema | Orchestrator submits `failure: true` | Orchestrator submits bytes; contract computes `failure`; D7, D9 |
| Confidential-compute option | Viable alternative | Dropped; D2 |
| `post_receipt(policy_id, receipt, attestation)` | Struct of claims | `post_receipt(policy_id, agent_id, request_bytes, response_bytes, signature_json)` |
| "A failure can be…" | Any judged outcome | Demo: recomputed answer. Production: rubric hash in `terms_hash` |

---

## 2. The idea, in plain language

**One sentence.** Correlation is parametric cover for the risk that a *swarm of AI agents fails together*, because they share one dependency — the same model, prompt, retrieval corpus, tool or orchestrator — and that shared dependency is what makes the failure correlated, uninsurable by normal means, and invisible to per-agent monitoring.

**The problem.** Everyone building agent fleets is told to diversify. Diversifying agents does not diversify their failure, because twenty agents calling the same model with the same poisoned prompt fail as one. Classic insurance assumes independent risks and a loss history; agents have neither. Existing AI cover is per-agent, per-incident and indemnity-based, which means a claims adjuster deciding whether your agent "really" failed.

**The insight.** There is a missing object: a *correlated-failure index* you can measure, attest and settle. Once the failure is an objectively checkable predicate over signed outputs, the payout does not need a human or a committee — the contract recomputes it.

**What is actually novel.** Not "AI insurance". The novelty is *TEE-attested correlated-failure evidence settling into a permissionless, deterministic trigger*. The enclave is used for exactly one thing it is uniquely good at: proving that a specific model produced specific bytes.

**The four sentences (use these verbatim).**

> The swarm's task is objectively checkable.
> The model TEE signs each output; we verify that signature and its attested signer once, off-chain, against a pre-registered policy.
> The contract counts the signed pass/fail booleans itself — it never accepts a percentage.
> A 25% crossover releases a fixed payout, subject to a nullifier and a pool cap.

**What it is not.**

- Not indemnity insurance. It pays on an index, not on your loss. Say "basis risk" out loud.
- Not a regulated product. Testnet, no real funds, prototype labels on every screen.
- Not a general "run my code in a TEE" service. No custom enclave code exists in this build.
- Not AI catastrophe cover. Scope is *operational* correlation: one dependency, one window.

---

## 3. Verified facts

Everything here was checked against live systems or current docs on 2026-11-09. Anything not in this table is an assumption and must be labelled as such in the README.

### 3.1 Signature semantics

| Fact | Detail | Verified by |
|---|---|---|
| `provider_tee` payload | `"{model_id}:{request_hash}:{response_hash}"` | `docs.near.ai` API reference |
| `gateway` payload | `"{request_hash}:{response_hash}"` — **does not prove model execution** | same |
| Streaming | Produces gateway signatures (gateway rewrites bytes) | SDK docs |
| Responses / Messages APIs | Gateway signatures | SDK docs |
| Signature record retrieval | `GET /v1/signature/{completion_id}?model={id}&signing_algo={algo}` | API reference |
| Attestation report | `GET /v1/attestation/report?model={id}` — **public, no key needed** | live probe |
| Record expiry | 60 minutes by default | SDK docs |
| E2EE | Off by default; leave off | SDK docs |

### 3.2 Model eligibility (live survey, 11 candidates)

| Class | Models | Per-response signer | Eligible |
|---|---|---|---|
| NEAR-hosted TEE | `z-ai/glm-5.3-flash`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `…-abliterated`, `openai/privacy-filter`, `Qwen/Qwen3.8-27B-abliterated` | **yes**, `signing_algo: "ecdsa"`, 20-byte `0x` address + 64-byte `signing_public_key` | ✅ |
| Chutes | `moonshotai/kimi-k2.6`, `moonshotai/kimi-k3`, `deepseek/deepseek-v3.2`, `qwen/qwen3.5-397b-a17b` | no — gateway only | ❌ |
| Tinfoil | `z-ai/glm-5.3` | no — gateway only | ❌ |

**Seven of eleven candidates cannot prove model execution.** Choosing a model is a hard technical constraint now, not a taste decision.

Attestation fields available on an eligible model:

```
model_attestations[0].model_name            "z-ai/glm-5.3-flash"
model_attestations[0].signing_address       "0x3b75…fa0c"        (20 bytes)
model_attestations[0].signing_algo          "ecdsa"
model_attestations[0].signing_public_key    64 bytes, hex
model_attestations[0].request_nonce         32 bytes
model_attestations[0].intel_quote           TDX quote
model_attestations[0].nvidia_payload        GPU evidence
model_attestations[0].info.tcb_info.compose_hash   ← the measurement to pin
model_attestations[0].info.tcb_info.os_image_hash
model_attestations[0].info.mr_aggregated
```

Gateway and OHTTP keys are `ed25519`. Only the **model** signer is `ecdsa`. Any code touching both must handle both curves.

**Selection, probed 2026-11-09** (public catalog + attestation, no key):

| | `z-ai/glm-5.3-flash` | `Qwen/Qwen3.8-27B` |
|---|---|---|
| `is_ready` | yes | yes |
| signer | ecdsa `0x3b75…fa0c` | ecdsa `0x835a…aa26` |
| `supported_features` | `tools`, **`structured_outputs`**, `reasoning`, **`json_mode`** | `tools`, **`structured_outputs`**, `reasoning` |
| price in/out per 1M | $0.08 / $0.50 | $0.04 / $1.35 |
| context | 1,048,576 | 262,144 |

Consequences:

- The primary model supports constrained decoding, so the verdict can be a **JSON-Schema-constrained** object rather than a hope. This removes most of error E12.
- `deepseek-ai/DeepSeek-V4.1-Flash-1017` has a signer but **no `structured_outputs`**, so it is no longer the fallback. `Qwen/Qwen3.8-27B` is: cheaper input, same constraint support, separate signer.
- `z-ai/glm-5.3` is `owned_by: "attested 3p"` and `z-ai/glm-5.3-flash` is `nearai`. Only the `nearai`-owned one exposes a model signer — this is the `provider` distinction the docs warn about.

### 3.2.1 Canonical model identity

Two probed behaviours change the client:

| Behaviour | Evidence | Consequence |
|---|---|---|
| Aliasing can rewrite the model ID | docs: *"send the completion with the same canonical model ID and `x-no-aliasing: true`"* | Send `x-no-aliasing: true` on every completion. The model ID is inside the signed text; a rewritten alias is a guaranteed `TEXT_MISMATCH`. |
| `provider=near` selects the NEAR-hosted deployment | `?model=z-ai/glm-5.3-flash&provider=near` returned a different `compose_hash` than the same call without it | Pass `provider=near` when requesting attestation, and verify **every** returned candidate. |
| `compose_hash` is not stable across candidates | observed `e8416a02…` vs `a0e3c6f4…` for the same model name minutes apart | **Authority is the `signing_public_key`, not the measurement.** Record `compose_hash` as evidence; never gate a receipt on it. |

That last row matters. It means the contract's trust root must be a pinned 64-byte key, which is already what D5 and §6.5 do.

### 3.3 Environment

| Item | Value |
|---|---|
| Node | v24.22.2 (SDK requires ≥ 24.22.1) |
| Rust / Cargo | 1.93.1 |
| Python | 3.12.3 |
| Docker | 29.9.2 |
| pnpm | `pnpm` (on `PATH`) |
| `cargo-near` | **not installed** — `cargo install cargo-near` (5–10 min) |
| `near` CLI | **not installed** — needed for account creation |
| Contract SDK | `near-sdk = "5.30"` |
| npm packages in spike | `@nearai/inference-sdk@0.3.0`, `ethers@6.17.0` |

### 3.4 Chain and economics

| Fact | Value |
|---|---|
| Reference gas for a receipt verification | ~2.52 Tgas (measured in `tmdry4530/tee-receipts`, testnet `tee-receipts-chamdom.testnet`) — **measure ours, do not assume** |
| Faucet | ~10 claims/day, 60-minute cooldown; `near create-account <id>.testnet --useFaucet` → 10 NEAR |
| 1Click Intents | mainnet only — not used |
| Storage | ~1 NEAR ≈ 100 KB |
| Run cost | 20 agents × ~250 in / 40 out tokens ≈ $0.0008 per run at `glm-5.3-flash` rates. A hundred rehearsals cost cents. |
| Rate limits | **Not published.** Terms reference "applicable rate limits" without numbers. Assume they exist: concurrency 4, exponential backoff, abort the run rather than degrade it. |

### 3.5 Still unproven

| Unknown | Why it matters | How it gets settled |
|---|---|---|
| A live completion returns `signature_kind: "provider_tee"` / `ecdsa` with reproducible text | Whole design rests on it | Run `spike/verify-receipt.mjs` with a key (§12 D-5) |
| `response_format` does not force a gateway signature | Constrained decoding must still be provider-signed | Probe on D-5: same call with and without `response_format` |
| `x-no-aliasing: true` is honoured on Chat Completions | Otherwise the signed model ID may differ | Probe on D-5; log the signature `text` and diff the prefix |
| `env::ecrecover` `v` convention (0/1 vs 27/28) and `malleability_flag` | Wrong guess = every receipt fails | Fixture test with a real signature (§6.12 T3) |
| Model stays available through judging | Demo dies on stage | Pin two models, re-attest morning of judging |

---

## 4. Trust model

### 4.1 What each layer proves

| Layer | Proves | Does **not** prove |
|---|---|---|
| Model TEE (NEAR AI) | *This model, at this measurement, produced these exact bytes* | That the input was true; that the output is correct |
| Contract | *The bytes carry a valid signature from a registered signer; the answers were verified arithmetically; the count is correct* | That the swarm's inputs were honest |
| Orchestrator | Nothing on its own — it is untrusted | — |
| Pool / LPs | Bear the residual basis risk | — |

**The line to say on stage:** *the enclave proves who judged and what they saw; the contract proves the judgment. Neither proves the input was honest — that is basis risk, and it is disclosed, not solved.*

### 4.2 The five questions a judge will ask

| Question | Answer |
|---|---|
| "Can't you just fake the failures?" | The contract recomputes each answer from the signed bytes; a failure is not a claim, it is arithmetic. |
| "Can't the buyer break its own agents?" | Yes, in the production threat model. Mitigated by deductible, coinsurance, exclusions and attribution — commercially, not cryptographically. Say so. |
| "Can't one event drain the pool?" | Per-policy cap 20% of pool, per-swarm cap, limit sizing, locked withdrawals until expiry. |
| "Who decides 'failed'?" | In the demo, nobody: the task has a checkable answer. In production, a versioned rubric whose hash is committed in `terms_hash` — and that is a weaker guarantee, stated as such. |
| "Is this insurance? Are you regulated?" | Testnet prototype, no real funds, index-based not indemnity, labelled on the first slide. |

### 4.3 Attack surface and mitigations

| Attack | Vector | Mitigation | Residual |
|---|---|---|---|
| Forged receipt | Orchestrator invents bytes | Signature binds `model:sha256(req):sha256(resp)`; unknown signer rejected | None if signer registry is correct |
| Signer substitution | Attacker registers own key | `register_signer` is owner-only and happens after off-chain attestation verification | Governance key compromise |
| Replay | Same receipt submitted twice | Nullifier `(policy_id, agent_id, window_start_ns)` | None |
| Cross-policy replay | Receipt from policy A used for B | `policy_id` in the nullifier and in the prompt; contract checks | None |
| Wrong window | Old receipt counted | `window_start_ns`/`window_end_ns` bounds checked, plus `now` inside window | Clock skew |
| Partial withholding | Buyer hides failures | Hiding only reduces payout; coverage threshold `min_receipts` enforced | — |
| Pool drain | Correlated tail | Caps, limit ≤ 20% pool, withdrawals locked | Tail beyond caps |
| Frame ambiguity | Model emits unparseable JSON | Strict parse; unparseable = no record, not a failure | — |

---

## 5. Architecture

### 5.1 Shape

```
┌──────────────────────────────────────────────────────────────┐
│  Orchestrator (untrusted, off-chain, Node)                   │
│  20 agents · deterministic task · one shared context         │
└───────────────┬──────────────────────────────────────────────┘
                │  POST /v1/chat/completions  (non-streaming)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  NEAR AI Cloud — NEAR-hosted TEE model                       │
│  Intel TDX + NVIDIA confidential GPU                         │
│  returns: response bytes + attestation + ecdsa signature     │
└───────────────┬──────────────────────────────────────────────┘
                │  raw request bytes, raw response bytes, signature
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Verification service (off-chain, once per signer)           │
│  verifies TDX quote + NRAS via @nearai/inference-sdk         │
│  registers signing_public_key + compose_hash on-chain        │
└───────────────┬──────────────────────────────────────────────┘
                │  register_signer(...)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Correlation contract (NEAR, Rust)                           │
│  post_receipt(): sha256 both byte blobs → rebuild text →     │
│    ecrecover(EIP-191 keccak) → compare registered key →      │
│    parse JSON → recompute expected answer → store ok/fail    │
│  evaluate(): count → index → trigger → payout                │
└───────────────┬──────────────────────────────────────────────┘
                ├── policy NFT (NEP-171/177)
                ├── pool in native NEAR
                └── NEP-297 events
```

### 5.2 Receipt lifecycle, numbered

1. Orchestrator builds agent `i`'s prompt. Prompt **must** contain `policy_id`, `agent_id`, `window_start_ns` and the task input, in a canonical form.
2. Orchestrator sends it to the pinned model with `temperature: 0`, `max_tokens` fixed, `Accept-Encoding: identity`, `x-no-aliasing: true`, `provider=near`, a `response_format` JSON schema, and the body as an exact string.
3. It reads the response as **bytes** (`arrayBuffer`), never re-serialises.
4. It fetches `GET /v1/signature/{id}?model={model}&signing_algo=ecdsa`.
5. It asserts `signature_kind === "provider_tee"` and `signing_algo === "ecdsa"`. If not, the run aborts — never silently degrades to a gateway receipt.
6. It submits `post_receipt(policy_id, agent_id, request_bytes, response_bytes, signature_json)`.
7. The contract hashes both blobs, rebuilds the signed text, verifies the signature, checks the nullifier and window, parses the response, recomputes the expected answer, stores `ok`.
8. After all agents (plus the grace period), anyone calls `evaluate(policy_id)`.
9. `evaluate` requires `receipts >= min_receipts`, computes `index = failed / started`, and sets `Triggered` if `index >= trigger_bps`.
10. The buyer calls `claim(policy_id)`; the pool pays `min(limit, available)`; the NFT is frozen and marked `Paid`.

### 5.3 Why bytes on-chain (the hole this design closes)

A signature over `sha256(request):sha256(response)` proves *some* bytes existed. If the orchestrator submits only `{agent_id, failure: true}`, the contract can verify that *a* signature is valid but cannot tell whether the signed bytes said "fail". The verifier then becomes the oracle — exactly the thing this design claims not to need.

Fix: submit the bytes. The contract hashes them, so the verdict it stores is derived from bytes the TEE signed. The orchestrator cannot lie about the content, only about which bytes to submit — and those must hash to the signed text, so they must be the actual bytes.

Cost: ~1 KB calldata and ~100 bytes of storage per receipt. Twenty receipts ≈ 2 KB storage ≈ 0.02 NEAR. Acceptable.

### 5.4 Why the model's answer is parsed by the contract

Two candidate predicates:

| Predicate | Who decides | Verdict |
|---|---|---|
| "Did this output indicate failure?" | The model, or the orchestrator | Trusted judge returns |
| "Is this answer correct for this input?" | The contract, arithmetically | Deterministic |

Choose the second. The swarm's task is a deterministic function with a short answer, so `expected = f(n)` is recomputed in Rust and compared to the parsed answer. "Failure" becomes a fact about arithmetic, not an opinion.

**Demo task (exact):**

```
input  n  (integer, 8 digits, unique per agent, fixed per run)
output {"n": <n>, "a": <n * 37 mod 1000003>}
```

- Unique `n` per agent, so answers cannot be copied between agents.
- One multiplication and one modulo — trivially checkable in Rust, and an LLM gets it right unless its context is poisoned.
- The poisoned run changes one shared string in the system prompt (e.g. appends an instruction biasing arithmetic), which makes a *subset* fail. That is the correlation story made visible.

**Production predicate (described, not built):** a rubric document hashed into `terms_hash`; the model returns `{"ok": bool, "class": u16}`; the contract checks `class` is in the covered set and stores it. Weaker, and say so.

### 5.5 Why this is correlated failure, not staged

The control run and the poisoned run use identical code, identical agents, identical tasks. The only difference is one shared context string. If failures were independent, poisoning one string would not push 7 of 20 over the threshold.

Say this before a judge asks: *"the only thing that changed between those two runs is the shared dependency. That is the entire product."*

---

## 6. Contract specification

### 6.1 Toolchain

```toml
# contract/Cargo.toml
[package]
name = "correlation"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
# `unstable` is not optional: env::ecrecover is cfg-gated behind it in 5.30.
# 5.30.1 also requires rustc >= 1.95, so the 1.86 pin in §9 is superseded.
near-sdk = { version = "5.30", features = ["legacy", "unstable"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
panic = "abort"
strip = true
```

Build:

```bash
cargo install cargo-near            # one time, 5–10 min
cd contract && cargo near build     # reproducible build needs a clean tree + git remote
```

If the reproducible build complains about a missing remote, use:

```bash
cargo near build non-reproducible-wasm
```

and note in the README that the deployed WASM is non-reproducible. Do not silently swap flags without recording it.

### 6.2 Module map

| File | Responsibility | Must not |
|---|---|---|
| `lib.rs` | State, init, method wiring, access control | Contain business math |
| `types.rs` | Structs, enums, `PolicyStatus`, `FailureClass` | Do I/O |
| `errors.rs` | `ContractError` enum with stable codes | Panic with strings |
| `verify.rs` | sha256, keccak, EIP-191, `ecrecover`, parse signature JSON | Know about policies |
| `receipt.rs` | `post_receipt`, nullifiers, window checks, verdict derivation | Move funds |
| `policy.rs` | `register_swarm`, `buy_policy`, terms hashing, NFT mint | Verify signatures |
| `pool.rs` | `deposit`, `withdraw`, caps, `available()` | Decide triggers |
| `trigger.rs` | `evaluate`, index math, state transitions | Parse JSON |
| `nft.rs` | NEP-171 + NEP-177, freeze after trigger | Business logic |
| `events.rs` | NEP-297 emitters | — |
| `views.rs` | Read-only methods | Mutate |

### 6.3 Storage

```rust
#[near(contract_state)]
pub struct Contract {
    pub owner: AccountId,
    pub paused: bool,
    pub next_policy_id: u64,
    pub next_pool_id: u64,

    pub policies: LookupMap<PolicyId, Policy>,
    pub pools: LookupMap<PoolId, Pool>,
    pub swarms: LookupMap<SwarmId, Swarm>,          // fingerprints
    pub signers: LookupMap<[u8; 64], SignerRegistration>, // pubkey -> measurement
    pub receipts: LookupMap<(PolicyId, AgentId), Receipt>, // one per agent per policy
    pub nullifiers: LookupSet<Vec<u8>>,              // policy|agent|window
    pub tokens: LookupMap<TokenId, PolicyId>,        // NEP-171
    pub token_owner: LookupMap<TokenId, AccountId>,
}

pub struct Policy {
    pub policy_id: PolicyId,
    pub swarm_id: SwarmId,
    pub buyer: AccountId,
    pub terms_hash: [u8; 32],       // hash of exact terms JSON
    pub limit: u128,                // yoctoNEAR
    pub premium: u128,
    pub trigger_bps: u16,           // 2500 = 25%
    pub window_start_ns: u64,
    pub window_end_ns: u64,
    pub min_agents: u32,            // N
    pub min_receipts: u32,          // Q * N
    pub model_id: String,           // pinned at purchase
    pub signer_pubkey: [u8; 64],    // pinned at purchase
    pub status: PolicyStatus,
    pub failed: u32,
    pub started: u32,
    pub paid_amount: u128,
    pub token_id: TokenId,
}

pub enum PolicyStatus { Active, Triggered, Paid, Expired, Cancelled }

pub struct Receipt {
    pub ok: bool,
    pub failure_class: u16,
    pub request_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub signer: [u8; 64],
    pub posted_at_ns: u64,
}

pub struct SignerRegistration {
    pub public_key: [u8; 64],
    pub model_name: String,
    pub compose_hash: [u8; 32],
    pub os_image_hash: [u8; 32],
    pub policy_hash: [u8; 32],      // hash of the verification policy applied
    pub verified_at_ns: u64,
    pub expires_at_ns: u64,
}
```

Notes:

- `u128` amounts serialise as **strings** in JSON. Every client must use BigInt and a JSON replacer.
- Timestamps are **nanoseconds**.
- `terms_hash` is computed over the exact terms JSON the buyer signed; `buy_policy` recomputes and compares.

### 6.4 Public interface

```rust
// --- lifecycle ---
#[init] pub fn new(owner: AccountId) -> Self;

// --- governance ---
pub fn register_signer(&mut self, reg: SignerRegistration);      // owner
pub fn set_paused(&mut self, paused: bool);                       // owner
pub fn allow_model(&mut self, model_id: String, compose_hash: [u8;32]); // owner

// --- buyer ---
pub fn register_swarm(&mut self, swarm_id: SwarmId, fingerprint: SwarmFingerprint);
#[payable] pub fn buy_policy(&mut self, swarm_id: SwarmId, terms: PolicyTerms) -> TokenId;
pub fn claim(&mut self, policy_id: PolicyId);                     // buyer

// --- LP ---
#[payable] pub fn deposit(&mut self, pool_id: PoolId);
pub fn withdraw(&mut self, pool_id: PoolId, amount: u128);

// --- evaluator / anyone ---
#[payable] pub fn post_receipt(
    &mut self,
    policy_id: PolicyId,
    agent_id: AgentId,
    request_bytes: Vec<u8>,
    response_bytes: Vec<u8>,
    signature_json: String,
);
pub fn evaluate(&mut self, policy_id: PolicyId);
pub fn expire(&mut self, policy_id: PolicyId);                     // anyone, after window + grace

// --- views ---
pub fn get_policy(&self, policy_id: PolicyId) -> PolicyView;
pub fn get_receipt(&self, policy_id: PolicyId, agent_id: AgentId) -> Option<ReceiptView>;
pub fn get_index(&self, policy_id: PolicyId) -> IndexView;   // {failed, started, bps, triggered}
pub fn get_signer(&self, pubkey: [u8; 64]) -> Option<SignerRegistration>;
pub fn get_pool(&self, pool_id: PoolId) -> PoolView;
pub fn nft_token(&self, token_id: TokenId) -> Option<TokenView>;
```

### 6.5 `post_receipt` algorithm

Order matters. Fail at the cheapest check first.

```
1. require !paused
2. policy = policies[policy_id]                    or ERR_POLICY_NOT_FOUND
3. require policy.status == Active                 or ERR_NOT_ACTIVE
4. require now_ns within [window_start, window_end + grace]  or ERR_OUTSIDE_WINDOW
5. require agent_id is in swarm.agent_ids          or ERR_UNKNOWN_AGENT
6. nullifier = policy_id || agent_id || window_start_ns
   require !nullifiers.contains(nullifier)         or ERR_DUPLICATE
7. sig = serde_json::from_str(signature_json)      or ERR_BAD_SIGNATURE_JSON
8. require sig.signature_kind == "provider_tee"    or ERR_GATEWAY_SIGNATURE
9. require sig.signing_algo == "ecdsa"             or ERR_UNSUPPORTED_ALGO
10. require sig.model == policy.model_id           or ERR_WRONG_MODEL
11. h1 = hex(sha256(request_bytes)); h2 = hex(sha256(response_bytes))
12. text = format!("{}:{}:{}", policy.model_id, h1, h2)
13. require text == sig.text                       or ERR_TEXT_MISMATCH
14. digest = keccak256("\x19Ethereum Signed Message:\n" || dec(len(text)) || text)
15. recovered = ecrecover(digest, sig.r_s, sig.v, false)   (retry with true)
16. require recovered == policy.signer_pubkey      or ERR_UNKNOWN_SIGNER
17. parsed = parse_verdict(response_bytes)         or ERR_UNPARSEABLE
18. require parsed.n == expected_n_for(agent_id)   or ERR_TASK_MISMATCH
19. ok = parsed.a == mul_mod(parsed.n, 37, 1_000_003)
20. receipts[(policy_id, agent_id)] = Receipt{...}
21. nullifiers.insert(nullifier)
22. policy.started += 1; if !ok { policy.failed += 1 }
23. emit ReceiptPosted { policy_id, agent_id, ok, request_hash, response_hash }
```

**Two gaps closed during the build.** §6.5 refers to `expected_n_for(agent_id)` and a grace
period without defining either; both are now fixed in `receipt.rs`:

- The expected input is *derived*, never submitted:
  `n = 10_000_000 + ((policy_id % 1000) * 20 + agent_index) % 20_000`, where `agent_index` is the
  agent's position in `swarm.agent_ids`. Orchestrator and contract compute the same number, so
  there is no agent→n mapping to trust. It is unique within a policy for `N <= 20_000`.
- The grace period is a constant, `RECEIPT_GRACE_NS = 5 min`, added to `window_end_ns`; it is not
  part of the signed terms.
- The replay guard is the nullifier `policy_id ‖ agent_id ‖ window_start_ns` in a
  `LookupSet<Vec<u8>>`, checked before any signature work, so a replay costs one storage read.

### 6.6 Index and trigger

```
index_bps = (failed * 10_000) / started
triggered = started >= policy.min_agents
         && started >= policy.min_receipts
         && index_bps >= policy.trigger_bps
```

`evaluate` is idempotent; calling it twice changes nothing. It must be callable by anyone, because a stalled trigger is the failure mode that matters.

`expire` is the counterpart: after `window_end_ns + RECEIPT_GRACE_NS`, anyone can retire a policy that
never triggered. It releases `limit` from `pool.committed`, decrements `active_policies`, and emits
`policy_expired`. It refuses a non-`Active` policy (`E02`) and refuses while the window is open
(`E24`), so a buyer cannot escape a live window by expiring it early.

`claim`:

```
require status == Triggered
payout = min(policy.limit, pool.available_excluding_this_policy)
transfer payout to buyer
status = Paid; freeze NFT
emit PolicyPaid { policy_id, payout }
```

### 6.7 Events (NEP-297)

```json
{"standard":"correlation","version":"1.0.0","event":"receipt_posted",
 "data":{"policy_id":1,"agent_id":"agent-07","ok":false,"request_hash":"…","response_hash":"…"}}

{"standard":"correlation","version":"1.0.0","event":"index_updated",
 "data":{"policy_id":1,"failed":7,"started":20,"index_bps":3500}}

{"standard":"correlation","version":"1.0.0","event":"policy_triggered",
 "data":{"policy_id":1,"index_bps":3500,"threshold_bps":2500}}

{"standard":"correlation","version":"1.0.0","event":"policy_paid",
 "data":{"policy_id":1,"amount":"10000000000000000000000000"}}
```

Amounts are strings.

### 6.8 Error codes

| Code | Name | Meaning |
|---|---|---|
| E01 | `POLICY_NOT_FOUND` | |
| E02 | `NOT_ACTIVE` | |
| E03 | `OUTSIDE_WINDOW` | |
| E04 | `UNKNOWN_AGENT` | |
| E05 | `DUPLICATE` | nullifier hit |
| E06 | `BAD_SIGNATURE_JSON` | |
| E07 | `GATEWAY_SIGNATURE` | not `provider_tee` |
| E08 | `UNSUPPORTED_ALGO` | not `ecdsa` |
| E09 | `WRONG_MODEL` | |
| E10 | `TEXT_MISMATCH` | hashes do not reproduce the signed text — **the most likely failure, log everything** |
| E11 | `UNKNOWN_SIGNER` | |
| E12 | `UNPARSEABLE` | |
| E13 | `TASK_MISMATCH` | |
| E14 | `RECEIPT_ALREADY_POSTED` | |
| E15 | `POOL_EXHAUSTED` | |
| E16 | `WITHDRAW_LOCKED` | |
| E17 | `UNAUTHORIZED` | |
| E18 | `PAUSED` | |
| E19 | `PREMIUM_MISMATCH` | attached deposit ≠ premium |
| E20 | `TERMS_HASH_MISMATCH` | `sha256(terms_json)` ≠ submitted hash |
| E21 | `BAD_TERMS_JSON` | unparseable or out-of-range terms |
| E22 | `SWARM_NOT_FOUND` | `buy_policy` for an unregistered swarm |
| E23 | `POOL_NOT_FOUND` | |
| E24 | `NOT_EXPIRED` | `expire` called while the window (plus grace) is still open |

E19–E23 were added during the build: §6.4's interface implies checks the original table
had no codes for. §6.12's T2 asserts E19.

**Pool association.** `Policy` has no `pool_id` (§6.3), so the MVP treats the pool as
implicit: `new` creates pool `1`, `deposit`/`withdraw` target it, and `buy_policy` commits
coverage against it. Premiums are credited to `total`, limits to `committed`, and
`committed + limit <= total` is enforced before a policy exists (§6.10 #1).

`TEXT_MISMATCH` should return the expected text so the client can diff it. That single debugging affordance saves hours.

### 6.9 Gas and storage budget

| Operation | Estimated | Measure |
|---|---|---|
| `post_receipt` | 3–5 Tgas | `env::used_gas()` in tests |
| `evaluate` | 1 Tgas (20 receipts) | same |
| `claim` | 2 Tgas + transfer | same |
| Storage per receipt | ~120 bytes | `env::storage_usage()` |
| Storage per policy | ~600 bytes | same |

Attach 30 Tgas to `post_receipt` calls. If a call runs out of gas the receipt is lost, not retried — the orchestrator must check the receipt and resubmit.

### 6.10 Invariants

Must hold after every method. Assert in tests.

1. `sum(policy.limit for active policies) <= pool.total` (no over-commitment).
2. `policy.failed <= policy.started <= swarm.agent_ids.len()`.
3. A receipt exists at most once per `(policy_id, agent_id)`.
4. `status == Paid ⇒ paid_amount > 0`.
5. `status == Triggered ⇒ index_bps >= trigger_bps`.
6. No withdrawal while any policy is `Active` or `Triggered`. `expire` is the release valve: past
   `window_end_ns + grace` an untriggered policy becomes `Expired`, its limit leaves `committed` and
   it stops counting toward the lock. A `Triggered` policy does **not** expire — that money is owed
   to the buyer, so its capital stays locked until `claim`.
7. `terms_hash` never changes after purchase.
8. `signer_pubkey` never changes after purchase.

### 6.11 `verify.rs` details (get these exactly right)

```rust
pub fn eip191_digest(text: &str) -> [u8; 32] {
    let len = text.len();                       // BYTES, not chars
    let mut msg = Vec::with_capacity(28 + 20 + len);
    msg.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    msg.extend_from_slice(len.to_string().as_bytes());   // DECIMAL, no padding
    msg.extend_from_slice(text.as_bytes());
    env::keccak256(&msg).try_into().unwrap()    // keccak256, NOT sha256
}

pub fn recover(digest: &[u8; 32], sig: &[u8; 65]) -> Option<[u8; 64]> {
    let r_s: [u8; 64] = sig[..64].try_into().ok()?;
    let mut v = sig[64];
    if v >= 27 { v -= 27; }                     // normalise 27/28 -> 0/1
    env::ecrecover(digest, &r_s, v, false)
        .or_else(|| env::ecrecover(digest, &r_s, v, true))
        .map(|pk| pk.as_bytes().try_into().unwrap())
}
```

Traps, in order of how often they bite:

1. **sha256 vs keccak256** — the *inner* hashes are sha256; the *outer* EIP-191 digest is keccak256. Two different functions in one flow.
2. **Decimal length** — `len.to_string()`, not the raw byte. For a 200-byte message it is `"200"`, three characters.
3. **`v` convention** — NEAR wants a recovery id; signatures arrive as 27/28. Normalise, and let the fixture test tell you which `malleability_flag` value accepts a real signature.
4. **Compare public keys, not addresses** — the attestation carries the 64-byte key; comparing keys skips keccak+truncation entirely.
5. **Hex case** — hashes in the signed text must be lowercase hex, matching the server.

### 6.12 Contract tests

| # | Test | Asserts |
|---|---|---|
| T1 | `new` sets owner, not paused | state |
| T2 | `buy_policy` rejects wrong premium | E-amount |
| T3 | **Real signature fixture verifies** | `post_receipt` succeeds with bytes captured by the spike; settle `v`/`malleability_flag` here |
| T4 | Tampered response byte rejected | `TEXT_MISMATCH` |
| T5 | Gateway signature rejected | `GATEWAY_SIGNATURE` |
| T6 | Duplicate receipt rejected | `DUPLICATE` |
| T7 | Unknown agent rejected | `UNKNOWN_AGENT` |
| T8 | Wrong model rejected | `WRONG_MODEL` |
| T9 | 7/20 → triggered; 4/20 → not | `index_bps` |
| T10 | `min_receipts` blocks early trigger | not triggered |
| T11 | `claim` twice fails | `NOT_ACTIVE` after Paid |
| T12 | `claim` caps at pool balance | payout ≤ available |
| T13 | Withdraw during active policy fails | `WITHDRAW_LOCKED` |
| T14 | Invariants §6.10 hold after a full run | all |

T3 is the gate. Everything else is ordinary. If T3 fails, stop and resolve before writing more.

**Status 2026-11-09, later the same day:** T1–T14 all pass, 39 tests total. T14 lives in
`contract/tests/test_full_run.rs` and signs its twenty receipts in-test with `k256`, so no private
key is committed and the signatures are real secp256k1 over the EIP-191 digest. The run ends with
`total 91 NEAR` (100 deposited + 1 premium − 10 paid), `committed 0`, and the invariant checks
`failed <= started <= swarm size`. A second case flips one byte in the last receipt and asserts it
never counts.

**Status 2026-11-09:** T3 passes in `cargo test` against a locally generated EIP-191 fixture
(`contract/tests/fixtures/`), signed with the same secp256k1 scheme the model TEE uses. That
settles `v` normalisation (27/28 → 0/1) and that `malleability_flag: false` recovers the key;
no retry with `true` was needed. `near-sdk`'s unit-test mock implements `ecrecover`, so this
runs without a sandbox. Re-point T3 at the live capture once `NEARAI_API_KEY` exists — the
assertions do not change, and `npm run capture --workspace @correlation/api` does the re-pointing:
it calls the model once for policy 1 / agent index 2, verifies the signature before writing, and
refuses if the verdict is wrong or the signature is not `provider_tee`.

---

## 7. Off-chain services

### 7.1 `shared/` — canonicalisation

One module, imported by `api/` and mirrored by `contract/`. Its job is to make both sides agree byte for byte.

```ts
// shared/src/canonical.ts
export function sha256Hex(bytes: Uint8Array): string;      // lowercase hex
export function signedText(modelId: string, req: Uint8Array, res: Uint8Array): string;
export function eip191Digest(text: string): Uint8Array;    // keccak256, 32 bytes
export const TASK_MOD: number = 1_000_003;
export function expectedAnswer(n: number): number;         // (n * 37) % TASK_MOD

export const VERDICT_SCHEMA = {
  type: "object",
  properties: { n: { type: "integer" }, a: { type: "integer" } },
  required: ["n", "a"],
  additionalProperties: false,
} as const;
```

Rules:

- Never `JSON.parse` then `JSON.stringify` before hashing. Hash the bytes as received.
- Always send `Accept-Encoding: identity`.
- Always send `x-no-aliasing: true` and `provider=near` (§3.2.1).
- Always send `response_format: {type:"json_schema", json_schema:{name:"verdict", strict:true, schema:VERDICT_SCHEMA}}`. Strict schema means the model cannot return prose, fences or extra keys.
- Model ID used in `signedText` must be the **canonical ID from the response**, not the alias you typed, if the two ever differ.
- Build the request body once as a string, send that string, hash that string.
- Store `requestBytes` and `responseBytes` alongside the signature so a run can be replayed in tests.

### 7.2 `api/nearai/` — client and verifier

```ts
// client.ts
export async function completeExact(model: string, bodyString: string): Promise<{
  id: string; requestBytes: Uint8Array; responseBytes: Uint8Array; parsed: any;
}>;
// headers sent: Authorization, Content-Type, Accept-Encoding: identity,
//               x-no-aliasing: true, provider=near

// verify.ts
export async function fetchSignature(id: string, model: string, algo: "ecdsa"): Promise<SignatureRecord>;
export async function verifyLocally(sig, requestBytes, responseBytes, model): Promise<VerifiedReceipt>;
export async function verifyAttestation(model: string): Promise<{ pubkey: string; composeHash: string; policyHash: string }>;
```

`verifyLocally` mirrors the contract exactly and must produce the same pass/fail on the same inputs. If they disagree, the contract is right and the client is a bug.

`verifyAttestation` uses `@nearai/inference-sdk`'s `verifyResponse()` / attestation helpers. It runs **once per signer per day**, not per receipt.

### 7.3 `api/swarm/` — the twenty agents

```ts
// task.ts
export const AGENT_COUNT = 20;
// Must match the contract: n = 10_000_000 + ((policyId % 1000) * 20 + index) % 20_000.
// The contract derives the same value, so a mismatch surfaces as E13, not as trust.
export function taskInput(policyId: number, index: number): number;
export function expected(taskInput: number): number;

// agents.ts
export async function runSwarm(opts: {
  policyId: number; windowStartNs: bigint; seed: number;
  poison: boolean; concurrency: number;
}): Promise<AgentResult[]>;

// poison.ts
export const CONTROL_CONTEXT = "You are a careful arithmetic agent. Return only JSON.";
export const POISONED_CONTEXT = CONTROL_CONTEXT + " Round intermediate results to the nearest 1,000,000 before answering.";
```

Interesting detail: an instruction that looks harmless but biases arithmetic is a better demo than gibberish, because it produces *partial* failure — which is exactly the correlated-but-not-total shape the product is about. Tune the wording until control is 20/20 and poisoned is ~7/20, then freeze it. Record both strings and both results in the README.

`concurrency` = 4. Do not fire twenty parallel requests; rate limits will make the demo flaky for no benefit.

### 7.4 `api/chain/` — submission

```ts
export async function postReceipt(a: {
  policyId: number; agentId: string;
  requestBytes: Uint8Array; responseBytes: Uint8Array; signatureJson: string;
}): Promise<string>;   // tx hash

export async function evaluate(policyId: number): Promise<string>;
```

- Attach 30 Tgas.
- Retry once on a transient RPC error; never retry a receipt the contract already accepted (the nullifier will reject it — on a retry, `DUPLICATE` is success).
- If `post_receipt` fails with `TEXT_MISMATCH`, log expected vs received text; do not retry blindly.

### 7.5 `api/server.ts` — HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runs` | Start a run `{mode:"control"\|"poisoned"}`; returns `runId` |
| `GET` | `/api/runs/:id` | Status + per-agent results (polled by UI) |
| `GET` | `/api/runs/:id/stream` | SSE progress (optional) |
| `GET` | `/api/policy/:id` | Contract view, cached 2s |
| `GET` | `/api/health` | Model reachable, chain reachable, signer registered |

State is in memory. No database. Twenty agents' results fit in a few KB.

---

## 8. Frontend

### 8.1 Stack

Vite + React + TypeScript, one page, no router. `@near-js/*` for reads. No component library — hand-written CSS, dark, dense, monospace numbers.

### 8.2 Layout

```
┌───────────────────────────────────────────────────────────────┐
│ Correlation                        [Run control] [Run poisoned]│
│ Parametric cover for correlated agent failure      ● testnet   │
├─────────────────────────┬─────────────────────────────────────┤
│ POLICY p-001            │  INDEX                              │
│ limit 10 NEAR           │   35.0%   ━━━━━━━━━━━●━━━━━━━━━━   │
│ premium 1 NEAR          │   threshold 25%        TRIGGERED    │
│ window 60 min           │   failed 7 / started 20             │
│ model z-ai/glm-5.3-flash│                                     │
│ signer 0x3b75…fa0c ✓    │  POOL  100 NEAR · available 90      │
├─────────────────────────┴─────────────────────────────────────┤
│ SWARM (20)                                                     │
│ [a01 ✓] [a02 ✓] [a03 ✗] [a04 ✓] [a05 ✗] …                    │
├───────────────────────────────────────────────────────────────┤
│ RECEIPTS                                                       │
│ a03  ✗  wrong answer   req 3f2a…  res 9b1c…  sig 0x…  tx ↗     │
│ a05  ✗  wrong answer   req 7c11…  res 4d02…  sig 0x…  tx ↗     │
└───────────────────────────────────────────────────────────────┘
```

### 8.3 Components

| Component | Shows | Reads |
|---|---|---|
| `PolicyPanel` | terms, status, model, signer, terms hash | `/api/policy/:id` |
| `IndexGauge` | `failed/started`, bps, threshold marker, state | same |
| `SwarmGrid` | 20 cells: id, n, answer, expected, ✓/✗ | `/api/runs/:id` |
| `ReceiptTable` | agent, verdict, hashes, signature kind, tx link | run + chain |
| `PoolPanel` | total, available, exposure, locked | `/api/policy/:id` |
| `RunControls` | run buttons, disabled while running | local |
| `ChainLog` | last N events from NEP-297 | contract |
| `Disclosure` | "Prototype · testnet · no real funds · index-based, not indemnity" | static |

### 8.4 States that must exist

`idle` → `running` (cells fill in) → `complete` → `evaluating` → `triggered` → `paid`.

Also: `error` with the error code from §6.8 shown verbatim. A judge seeing `E10 TEXT_MISMATCH` plus a diff is more convincing than a spinner.

### 8.5 Numbers

- All `u128` arrive as strings. Parse with `BigInt`, render with a `formatNear()` helper. Never `Number(...)` on an amount.
- Index: `(failed / started * 100).toFixed(1) + "%"`.
- Hashes: first 4 and last 4 hex chars, full value on hover/copy.

---

## 9. Repository scaffold

Everything to create. Existing files marked.

```
NEAR_hackathon_2026/
├── .gitignore                              ✅ exists
├── AGENTS.md                               ✅ parent dir
├── BLUEPRINT.md                            ← this file
├── README.md                               ← §14
├── LICENSE                                 ← AGPL-3.0
├── .env.example                            ← §10.2
├── package.json                            ← workspace root
├── pnpm-workspace.yaml
│
├── spike/                                  ✅ exists
│   ├── package.json
│   ├── package-lock.json
│   ├── verify-receipt.mjs
│   └── out/                                (gitignored)
│
├── contract/
│   ├── Cargo.toml
│   ├── rust-toolchain.toml                 pin channel = "1.99" (5.30 needs >= 1.95)
│   ├── build.sh
│   ├── src/
│   │   ├── lib.rs
│   │   ├── types.rs
│   │   ├── errors.rs
│   │   ├── verify.rs
│   │   ├── receipt.rs
│   │   ├── policy.rs
│   │   ├── pool.rs
│   │   ├── trigger.rs
│   │   ├── nft.rs
│   │   ├── events.rs
│   │   └── views.rs
│   └── tests/
│       ├── test_policy.rs
│       ├── test_receipt.rs
│       ├── test_trigger.rs
│       ├── test_pool.rs
│       └── fixtures/
│           ├── receipt.json                ← captured by the spike
│           ├── request.bin
│           ├── response.bin
│           └── signature.json
│
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── canonical.ts
│   │   ├── eip191.ts
│   │   ├── types.ts
│   │   └── index.ts
│   └── test/
│       └── vectors.test.ts
│
├── api/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts
│       ├── config.ts
│       ├── store.ts
│       ├── nearai/
││       ├── client.ts
│       │   └── verify.ts
│       ├── swarm/
│       │   ├── task.ts
│       │   ├── agents.ts
│       │   └── poison.ts
│       └── chain/
│           ├── near.ts
│           └── submit.ts
│
├── web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles.css
│       ├── lib/
│       │   ├── api.ts
│       │   ├── near.ts
│       │   └── format.ts
│       └── components/
│           ├── PolicyPanel.tsx
│           ├── IndexGauge.tsx
│           ├── SwarmGrid.tsx
│           ├── AgentCell.tsx
│           ├── ReceiptTable.tsx
│           ├── PoolPanel.tsx
│           ├── RunControls.tsx
│           ├── ChainLog.tsx
│           └── Disclosure.tsx
│
└── scripts/
    ├── deploy.sh
    ├── register-signer.sh
    ├── seed-pool.sh
    └── demo.sh
```

### 9.1 Workspace root

```json
{
  "name": "correlation",
  "private": true,
  "packageManager": "pnpm@9",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "spike": "pnpm --filter correlation-tee-spike spike"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - shared
  - api
  - web
```

`spike/` stays out of the workspace on purpose: it has its own lockfile and must remain runnable on its own.

**Deviation, recorded at build time.** This machine has no `pnpm` and cannot fetch one, so the
workspace uses **npm workspaces**: `npm install`, `npm test`, `npm run dev --workspace
@correlation/api`. No `pnpm-workspace.yaml` is created, because a file nothing can run is worse than
none. Two other build-time consolidations: `shared/src/eip191.ts` and `types.ts` folded into
`canonical.ts` (one module, one set of constants, no import cycles), and `api/src/chain/` is a single
module rather than `near.ts` + `submit.ts`.

The contract checks model identity *before* comparing text (`E09` before `E10`), and the TypeScript
mirror must keep that order: comparing text first turns a wrong-model receipt into `E10` and hides
the real cause. A test pins it.

### 9.2 Dependency list

| Package | Where | Why | Version |
|---|---|---|---|
| `near-sdk` | contract | Contract framework | `5.30` |
| `serde`, `serde_json` | contract | Signature JSON, verdict | `1` |
| `fastify` | api | HTTP | latest, lock it |
| `@nearai/inference-sdk` | api | Attestation verification | `0.3.0` |
| `@near-js/accounts`, `@near-js/transactions`, `@near-js/providers`, `@near-js/signers` | api, web | Chain reads/writes | latest, lock it |
| `ethers` | shared | `keccak256` for EIP-191 | `6.17.0` |
| `react`, `react-dom` | web | UI | 18 |
| `vite`, `@vitejs/plugin-react`, `typescript` | web | Build | latest |
| `tsx` | api, shared | Run TS directly | latest |

Install `cargo-near` and `near-cli` separately — they are not project dependencies.

Do not add: a database, an ORM, a component library, a state manager, `axios` (use `fetch`), `dotenv` (use `--env-file` or `process.env`).

---

## 10. Environment and accounts

### 10.0 API credits — free for this event

The official rules file (`nearhackathon.com/HACKATHON.md`) answers this in Q-000:

> **NEAR AI credits?** Buy with crypto or card in the NEAR AI Cloud dashboard, **or claim $10 by joining NEAR Builders** (https://nearbuilders.org/join). Generate the API key in the dashboard.

So register as a NEAR Builder, claim the credit, and generate the key there. No card needed.

What $10 buys at `glm-5.3-flash` rates ($0.08 / $0.50 per 1M tokens):

| | Cost | Covered by $10 |
|---|---|---|
| One spike call | ≈ $0.00005 | ~200,000 calls |
| One 20-agent demo run | ≈ $0.001 | ~10,000 runs |
| Whole build + rehearsals | well under $1 | < 10% of the credit |

The credit is not the constraint. Do not optimise for tokens; optimise for getting the fixture captured.

If the Builder claim is not available, the fallback is staking NEAR through the dashboard (rewards, not principal, become credits) — that needs mainnet NEAR and is not worth it for a five-day build. Buying the smallest top-up is cheaper than staking.

### 10.1 Testnet accounts

```bash
near create-account correlation.testnet --useFaucet
near create-account lp.correlation.testnet   --masterAccount correlation.testnet --initialBalance 20
near create-account buyer.correlation.testnet --masterAccount correlation.testnet --initialBalance 10
near create-account eval.correlation.testnet  --masterAccount correlation.testnet --initialBalance 5
```

Sub-accounts are a NEAR primitive worth showing: the pool, the buyer and the evaluator are distinguishable on-chain without extra infrastructure.

### 10.2 `.env.example`

```bash
# --- NEAR AI Cloud ---
NEARAI_API_KEY=
NEARAI_BASE_URL=https://cloud-api.near.ai/v1
NEARAI_MODEL=z-ai/glm-5.3-flash
NEARAI_MODEL_FALLBACK=Qwen/Qwen3.8-27B
NEARAI_PROVIDER=near
NEARAI_SIGNING_ALGO=ecdsa

# --- chain ---
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
CONTRACT_ID=correlation.testnet
EVAL_ACCOUNT=eval.correlation.testnet
EVAL_PRIVATE_KEY=
BUYER_ACCOUNT=buyer.correlation.testnet
BUYER_PRIVATE_KEY=
LP_ACCOUNT=lp.correlation.testnet
LP_PRIVATE_KEY=

# --- policy defaults ---
AGENT_COUNT=20
TRIGGER_BPS=2500
MIN_RECEIPTS=16
WINDOW_MINUTES=60
LIMIT_YOCTO=10000000000000000000000000
PREMIUM_YOCTO=1000000000000000000000000
```

`.env` is gitignored. Never commit a key. Never paste a key into a doc, a commit message or a chat log that becomes a file.

---

## 11. Build sequence

Each day has an acceptance criterion. Do not start the next day until the criterion passes.

### D-5 (today) — gate

| # | Task | Done when |
|---|---|---|
| 1 | Obtain `NEARAI_API_KEY` | `spike/verify-receipt.mjs` exits 0 |
| 2 | Capture a real receipt into `contract/tests/fixtures/` | request.bin, response.bin, signature.json exist |
| 3 | Settle `ecrecover` semantics | a Rust unit test recovers the fixture's key |
| 4 | Confirm `response_format` + `x-no-aliasing` still yield `provider_tee`/`ecdsa` | signature JSON says `provider_tee`, `text` prefix matches the canonical model ID |
| 5 | `cargo install cargo-near`; create testnet accounts | `near state correlation.testnet` works |

**Gate:** if #1 or #3 fails, stop and write `BLOCKED.md`. Do not build the contract on an unverified signature assumption.

### D-4 — contract skeleton

| # | Task | Done when |
|---|---|---|
| 5 | `types.rs`, `errors.rs`, `lib.rs` state + init | `cargo test` compiles |
| 6 | `verify.rs` with T3 fixture test | T3 passes |
| 7 | `policy.rs` + `nft.rs` minimal mint | `buy_policy` in sandbox test mints token |
| 8 | Deploy to testnet | explorer shows the contract |

### D-3 — receipts and trigger

| # | Task | Done when |
|---|---|---|
| 9 | `receipt.rs` full algorithm | T4–T8 pass |
| 10 | `trigger.rs` index + evaluate | T9–T10 pass |
| 11 | `pool.rs` deposit/withdraw/caps | T11–T13 pass |
| 12 | `claim` + NFT freeze | T14 pass |
| 13 | `post_receipt` from the real API end-to-end | one receipt on testnet, verified |

### D-2 — swarm and verifier

| # | Task | Done when |
|---|---|---|
| 14 | `shared/` + vector tests | vectors match the Rust fixture |
| 15 | `api/nearai/client.ts` exact-bytes call | response hashes match locally |
| 16 | `api/nearai/verify.ts` | local verify agrees with contract on the same input |
| 17 | `runSwarm` 20 agents, control mode | 20/20 correct |
| 18 | poison tuning | 6–9 of 20 fail, repeatably |

### D-1 — UI and demo

| # | Task | Done when |
|---|---|---|
| 19 | `web/` all components, ugly-first | full run visible without refresh |
| 20 | `scripts/demo.sh` one-command run | runs cold on a clean machine |
| 21 | Rehearse three times | 3/3 identical outcome |
| 22 | Record video, write README, post X | §15 checklist complete |

### D0 — submission

| # | Task | Done when |
|---|---|---|
| 23 | Re-attest the signer | registration fresh, not expired |
| 24 | Repo public, no secrets in history | `git log -p | grep -i key` clean |
| 25 | Submit before 23:59Z | confirmation captured |

**Hard rule:** no architecture changes after D-3. Fix bugs, do not redesign.

---

## 12. Test plan

| Layer | What | How | When |
|---|---|---|---|
| Unit (Rust) | T1–T14 | `cargo test` in sandbox | every commit |
| Fixture | Real receipt verifies | T3 with captured bytes | D-5, then as a regression |
| Cross-language | JS and Rust agree | `shared/test/vectors.test.ts` against the same fixture | D-2 |
| Schema conformance | 20/20 responses parse under the strict schema, no prose or fences | assertion inside `runSwarm` | D-2 |
| Integration | 20 receipts → trigger → claim | localnet or testnet, scripted | D-3 |
| E2E | Full demo run | `scripts/demo.sh` on testnet | D-1 |
| Rehearsal | Three consecutive clean runs | manual, timed | D-1 |

What is **not** tested, and must be said: multi-monitor quorum, dispute arbitration, tranching, cross-chain settlement, real underwriting, privacy of prompts.

---

## 13. Demo script (90 seconds)

**0:00 — Problem, one sentence.** "Twenty agents, one shared model, one poisoned prompt — they fail as one. There is no product for that, because you cannot measure it."

**0:10 — Run control.** Click. Twenty cells go green. `0/20 · index 0%`. "Same code, same agents, same tasks."

**0:25 — Change one thing.** Show the single shared context string diff. "This is the only difference."

**0:35 — Run poisoned.** Cells fill; seven go red. `7/20 · index 35%`. "Same model, same window. That is correlation."

**0:50 — The receipts.** Open one red cell. "Raw request bytes, raw response bytes, an ECDSA signature from inside the model's TEE. The contract hashes these itself, so I cannot lie about what the model said."

**1:05 — The trigger.** `index 35% ≥ 25%` → `TRIGGERED` → `Claim` → balance moves 10 NEAR. "No adjuster. No committee. Arithmetic."

**1:15 — The re-attack.** Submit the same receipt again → `E05 DUPLICATE`. "Replay is dead."

**1:20 — Close.** "The enclave proves who judged. The contract proves the judgment. Nobody proves the input was honest — that is basis risk, and it is on the first slide."

### Fallbacks

| Failure | Fallback |
|---|---|
| Model unreachable | Pre-recorded run JSON, replayed through the same UI; say "this is a recorded run" |
| Chain slow | Show the tx pending + explorer; pre-run one trigger as a backup policy |
| Attestation expired | Re-register signer live; it takes ~5s |
| One agent times out | Retry that agent; 19/20 still demonstrates the threshold |
| Everything breaks | Video is the submission. Record it on D-1, not D0. |

---

## 14. Submission checklist

| Item | Detail |
|---|---|
| Project name | `Correlation` |
| Tracks | `swarms` (primary), `security`, `privacy` |
| Repo | public, HTTPS, unique, LICENSE present, README complete |
| Demo | X post, says "built at NEAR HACKATHON", tags `@NEARProtocol #NEARHackathon`, video attached |
| Description | 20–2000 chars: problem, product, why NEAR |
| Payload | ≤ 12,000 bytes, **no `website` field** |
| Secrets | none in history; `.env.example` only |
| Deadline | 2026-11-14T23:59:00Z |

### README structure (AI judges read this first)

```markdown
# Correlation
Parametric cover for correlated AI-agent failure.

## What it does            — 3 sentences, no jargon
## Quick start             — 4 commands, exact
## The 60-second demo      — what to click, what to expect, exact numbers
## Architecture            — the diagram from §5.1
## What is proven          — TEE signature, on-chain re-derivation
## What is NOT proven      — basis risk, no loss history, testnet only
## Testnet accounts        — contract ID, explorer links
## Repo layout             — table
## Disclaimer              — prototype, not insurance, no real funds
```

### Video shot list

1. Title card: name + one sentence.
2. Control run, 0/20.
3. The one-line context diff.
4. Poisoned run, 7/20, index 35%.
5. One receipt opened: bytes + signature + tx.
6. Trigger + claim + balance change.
7. Duplicate rejection.
8. Closing slide: what is proven / what is not.

Ninety seconds. No intro music. No logo animation.

---

## 15. Risk register

| # | Risk | P | Impact | Mitigation | Tripwire |
|---|---|---|---|---|---|
| 1 | Hash canonicalisation mismatch | High | Fatal | Contract hashes submitted bytes; one shared module; fixture test | T3 fails → stop |
| 2 | Model ineligible or signer disappears | Medium | Fatal | Two pinned NEAR-hosted models; survey re-run before build | no signer → switch model |
| 3 | `ecrecover` semantics wrong | Medium | Fatal | Fixture test settles it on D-5 | T3 fails → BLOCKED.md |
| 4 | Model rate limits / retirement | High | High | concurrency 4, retry, fallback model, pre-recorded run | 429 twice → fallback |
| 4b | Structured output changes signature kind | Low | High | D-5 probe compares signed `text` with and without `response_format` | `text` prefix wrong → drop `response_format` |
| 5 | Faucet / deploy unavailable | Low | Fatal | Accounts created D-5, not D0 | can't deploy → localnet demo |
| 6 | UI overruns | Medium | Medium | Ugly-first on D-1 morning; no animation | not rendering by 14:00 → cut components |
| 7 | Demo shows 0 failures | Medium | High | Freeze poison string after tuning; verify 3 rehearsals | run fails twice → adjust string |
| 8 | Contract runs out of gas | Low | Medium | 30 Tgas attached; `used_gas` measured | any OOG → raise attach |
| 9 | Attestation expires | Low | Medium | 60-min TTL noted; re-attest before judging | — |
| 10 | "You're unregulated" | Medium | High | Disclosure component + first slide | — |

Only #1, #2 and #3 are irreversible within the sprint. Everything else is recoverable in an hour.

---

## 16. Open items

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | `NEARAI_API_KEY` — claim the $10 Builder credit (§10.0) | you | live spike, fixtures, everything downstream |
| 2 | Decide fallback model after a live run | build | risk #2 |
| 3 | Confirm `ecrecover` `v` / `malleability_flag` | build | T3 |
| 4 | Confirm testnet faucet limits | build | account creation |
| 5 | Screenshot/video capture setup | you | D-1 |

---

## 17. Glossary

| Term | Meaning here |
|---|---|
| **Receipt** | Raw request bytes + raw response bytes + a signature over `model:sha256(req):sha256(resp)` |
| **Signer** | The 64-byte secp256k1 public key of the model TEE, registered on-chain after attestation |
| **Attestation** | TDX quote + NVIDIA evidence proving which code and model ran |
| **Measurement** | `compose_hash` / `os_image_hash` identifying the deployed image |
| **Index** | `failed / started`, in basis points |
| **Trigger** | `index_bps >= trigger_bps` with coverage satisfied |
| **Nullifier** | `policy_id ‖ agent_id ‖ window_start_ns`, set once |
| **Basis risk** | Payout and actual loss do not align |
| **Provider edge** | A receipt's signer is not in the registered set |

---

## Appendix A — endpoints and payloads

```http
GET  /v1/models                                      # public
GET  /v1/attestation/report?model={id}&provider=near # public
POST /v1/chat/completions                            # Bearer key, non-streaming
GET  /v1/signature/{completion_id}?model={id}&signing_algo=ecdsa
```

Required headers on the completion:

```http
Authorization: Bearer <key>
Content-Type: application/json
Accept-Encoding: identity
x-no-aliasing: true
```

Signature record:

```json
{
  "text": "z-ai/glm-5.3-flash:<sha256req>:<sha256resp>",
  "signature": "<130 hex chars>",
  "signing_address": "0x…",
  "signing_algo": "ecdsa",
  "signature_kind": "provider_tee"
}
```

Completion request (exact, minimal):

```json
{"model":"z-ai/glm-5.3-flash","messages":[{"role":"system","content":"…"},{"role":"user","content":"…"}],"temperature":0,"max_tokens":64,"response_format":{"type":"json_schema","json_schema":{"name":"verdict","strict":true,"schema":{"type":"object","properties":{"n":{"type":"integer"},"a":{"type":"integer"}},"required":["n","a"],"additionalProperties":false}}}}
```

Completion response JSON must contain, after parsing:

```json
{"n": 48271933, "a": 5120042}
```

With `strict: true` the model cannot wrap this in prose or fences, and `additionalProperties: false` blocks extra keys. If a response still fails to parse, do not loosen the schema silently: retry once, then record the receipt as `UNPARSEABLE`, which counts as **no record**, not as a failure. If every response is unparseable, `response_format` is not being honoured — re-run the D-5 probe before changing anything else.

## Appendix B — canonicalisation rules

1. Request body is a string. Send that exact string.
2. Response body is read as bytes. Never re-serialise.

   **Verified against the live docs (2026-11-09), and it contradicts the synthetic fixture:**
   `response_hash = SHA-256(exact response-body bytes)`, and the docs say explicitly not to parse
   and re-serialise JSON. So the signed bytes are the **whole response body, envelope included**;
   `response.bin` in `fixtures/` is therefore shaped like a *content* string, not like a real body.
   Two consequences, both now implemented:

   - `api` hashes the raw body and never extracts content before hashing.
   - `post_receipt` must unwrap `choices[0].message.content` itself to read the verdict, because
     asking the orchestrator to submit extracted bytes would make the hash disagree with the
     signature. `parse_verdict` accepts a bare `{n,a}` and an OpenAI envelope.

   **The endpoint choice is now load-bearing.** Signed text differs by endpoint:

   | Endpoint | `text` | `signature_kind` | Verdict here |
   |---|---|---|---|
   | `{slug}.completions.near.ai` (direct model TEE) | `<model_name>:<req>:<resp>` | `provider_tee` | **required** |
   | `cloud-api.near.ai` (gateway) | `<req>:<resp>` — no model prefix | `gateway` | rejected `E07` |

   So `NEARAI_BASE_URL` must point at a direct model endpoint. The gateway's text format also
   cannot pass `E09`'s model check, which is the same conclusion from the other side.
   A signature lookup may return `404`; that is "unavailable", not a failure — surface it as such
   rather than counting the agent as wrong.
3. `Accept-Encoding: identity` on both.
4. Hashes are lowercase hex, no `0x`.
5. Signed text is `model + ":" + reqHex + ":" + respHex`.
6. EIP-191 digest is `keccak256("\x19Ethereum Signed Message:\n" + decimalLen + text)`.
7. `decimalLen` is the UTF-8 byte length as decimal ASCII.
8. Public key comparison, not address, when the 64-byte key is available.

## Appendix C — worked example

```
20 agents, equal weight, T = 25%, N = 20, Q = 16
control:  failures 0  → index 0%    → not triggered
poisoned: failures 7  → index 3500  → triggered
payout:   min(limit 10 NEAR, pool available 90 NEAR) = 10 NEAR
premium:  1 NEAR
LP net:   +1 premium − 10 payout = −9 NEAR on a 100 NEAR pool
```

Show that last line on a slide. A judge who sees the LP lose money trusts the mechanism more than one who sees a happy path.

## Appendix D — reference implementations

| Repo | Use it for |
|---|---|
| `nearai/inference-sdk` | Attestation + signature verification (don't hand-roll) |
| `near-examples/nearai-cloud-verification-example` | Full flow, minimal code |
| `nearai/nearai-cloud-verifier` | More complete verifier |
| `tmdry4530/tee-receipts` | On-chain receipt verification gas reference |
| `near-examples/NFT` | NEP-171/177 skeleton |
| `near-examples/fungible-token` | NEP-141, only if you add a token later |

## Appendix E — decision log

| Date | ID | Decision | Status |
|---|---|---|---|
| 2026-11-09 | D1 | Deterministic on-chain trigger + TEE evidence | accepted |
| 2026-11-09 | D2 | Phala dropped | accepted |
| 2026-11-09 | D3 | `git init` + checkpoint | done |
| 2026-11-09 | D4 | NEAR-hosted TEE model only | accepted |
| 2026-11-09 | D5 | secp256k1 + EIP-191, not ed25519 | accepted |
| 2026-11-09 | D6 | Non-streaming Chat Completions | accepted |
| 2026-11-09 | D7 | Submit raw bytes; contract re-derives | accepted |
| 2026-11-09 | D8 | Pool in native NEAR | accepted |
| 2026-11-09 | D9 | Objectively checkable demo predicate | accepted |
| 2026-11-09 | D10 | Backend-signed chain writes | accepted |
| 2026-11-09 | D11 | Pin the key, record the measurement | accepted |
