# Correlation

Parametric insurance for AI-agent swarms. A buyer pays a small premium to cover the case where
**many agents fail the same task at the same time** — the correlated failure that makes an
agent fleet useless all at once. If enough agents fail inside the policy window, the contract pays
automatically, using receipts the model provider itself signed.

The point is not that an agent failed. It is that *the swarm* failed together, and that this is
provable without trusting an oracle: the contract re-derives the expected task input, rebuilds the
signed text from the raw request and response bytes, and recovers the signer key on chain.

## Quick start

```bash
npm install                                   # shared, api, web
cp .env.example .env                          # add NEARAI_API_KEY (never committed)
npm test                                      # 29 TypeScript tests + 39 Rust tests
npm run dev --workspace @correlation/api      # API on :8787
npm run dev --workspace @correlation/web      # UI on :5173
```

Contract tests need the Rust 1.99 toolchain pinned in `contract/rust-toolchain.toml`:

```bash
cd contract && cargo test && cargo build --release --target wasm32-unknown-unknown
```

## The 60-second demo

1. Open `http://localhost:5173`. The policy panel shows 10 NEAR limit, 1 NEAR premium,
   2500 bps trigger, 16-of-20 receipts required, model `z-ai/glm-5.3-flash`.
2. Press **Run control**. Twenty cells fill in; the index stays at 0%, the policy stays `Active`.
3. Press **Run poisoned**. The system prompt gains one plausible-looking rounding instruction.
   Roughly a third of the agents now answer the same arithmetic question wrongly.
4. The index crosses 25%, `evaluate` fires on chain, the policy reads `Triggered`, and the
   **Claim payout** button pays the limit to the buyer, capped by what the pool actually holds.

Both runs are the *same* model, the *same* prompt shape and the *same* task family. The only
difference is one sentence of context.

## Architecture

```
  orchestrator (api/)                      NEAR AI Cloud                  NEAR testnet
 ┌──────────────────────┐   exact bytes   ┌──────────────┐   signature  ┌──────────────────┐
 │ 20 agents, 4 at once │ ──────────────► │  glm-5.3     │ ───────────► │ post_receipt      │
 │ one task each        │                 │  provider TEE│              │  re-hash bytes    │
 │ keeps req/res bytes  │ ◄────────────── └──────────────┘              │  recover signer   │
 └──────────┬───────────┘                                               │  re-derive n      │
            │  request_bytes, response_bytes, signature_json            │  index = f/s      │
            └─────────────────────────────────────────────────────────► │ trigger → claim  │
                                                                        └──────────────────┘
```

The chain stores raw bytes, not a verdict, because a stored verdict is an oracle trust assumption
with extra steps. Anyone can replay a receipt offline: same bytes, same model id, same signature,
same recovery (`shared/` is a mirror of `contract/src/verify.rs`).

## What is proven

- **Signature provenance.** `signing_algo: "ecdsa"`, `signature_kind: "provider_tee"`, recovered
  key equals the registered key, and the signed text is rebuilt from the submitted bytes — so a
  receipt cannot describe a different call than the one that happened.
- **Task integrity.** The expected input is `10_000_000 + ((policy_id % 1000) * 20 + agent_index)
  % 20_000`, derived independently by the orchestrator and the contract. Submitting the wrong `n`
  fails as `E13` rather than being trusted.
- **Arithmetic.** The contract recomputes `a = n * 37 mod 1_000_003` itself; the model's answer is
  parsed, not believed.
- **One receipt per agent per policy**, enforced by a nullifier (`policy_id ‖ agent_id ‖ window
  start`), so replay is a storage read, not a policy question.
- **Payout honesty.** The pool cannot pay more than it holds; `claim` caps at available capital and
  freezes the policy NFT.

## What is NOT proven

- **Basis risk.** The index counts wrong answers on one synthetic arithmetic task. Real agent
  failures are messier: partial completions, timeouts, tool errors. This is a prototype of the
  mechanism, not of the loss distribution.
- **No loss history.** There is no actuarial model behind the 1 NEAR premium for 10 NEAR of cover;
  the numbers are chosen to make the demo legible.
- **TEE attestation is checked once per signer per day**, not per receipt. It answers "is this the
  model it claims to be", not "did this specific call happen".
- **Testnet only.** No real funds, no audits, no upgrade path, single pool (`pool_id = 1`).
- **The poisoned arm is staged on purpose** — that is the experiment. A production insurer would
  need a task the buyer cannot choose.

## Testnet accounts

| Role | Account | Purpose |
|---|---|---|
| contract | `correlation.testnet` | policies, pool, index, payouts |
| lp | `lp.correlation.testnet` | deposits capital |
| buyer | `buyer.correlation.testnet` | buys cover, claims |
| eval | `eval.correlation.testnet` | posts receipts, calls `evaluate` |

The buyer's key is also needed by the API to call `claim`, since the contract restricts payouts to
the buyer: `BUYER_ACCOUNT` and `BUYER_PRIVATE_KEY` in `.env`.

Deployment is not done yet: this machine has neither `near-cli` nor a funded testnet account.
`scripts/deploy.sh`, `register-signer.sh` and `seed-pool.sh` are ready for the moment it does.

## Repository layout

| Path | What |
|---|---|
| `BLUEPRINT.md` | the build spec this repo follows, including every decision and its reason |
| `contract/` | Rust/serde contract: `verify`, `policy`, `pool`, `receipt`, `trigger`, `nft` |
| `contract/tests/fixtures/` | request/response bytes and a real secp256k1 signature used by both sides |
| `shared/` | canonicalisation: sha256, signed text, EIP-191 digest, derived task input |
| `api/` | exact-bytes client, local verifier, 20-agent swarm, chain submission, Fastify server |
| `web/` | one page: policy, index gauge, swarm grid, receipts |
| `spike/` | untouched standalone verifier used to capture the first real receipt |
| `scripts/` | deploy, register signer, seed pool, run demo |

## Tests

| Suite | Count | Covers |
|---|---|---|
| `contract` (Rust) | 39 | signature path, policy terms, pool limits, receipts, index, claim, expiry, full 20-receipt run |
| `shared` | 9 | cross-language vectors pinned to the Rust fixture |
| `api` | 20 | exact bytes, required headers, verifier parity incl. error codes, HTTP states, claim, a full offline 20-agent run |

`shared` and `api` deliberately assert the *same* error codes as the contract (`E07`, `E09`, `E10`,
`E11`), so a divergence shows up as a failing test instead of a silent client-only pass.

One trap worth naming: the provider signs the completion **content**, not the HTTP envelope. Hashing
`{"id":…,"choices":…}` yields a receipt that looks fine locally and fails on chain as `E10`. The
offline swarm test signs real messages with an ephemeral key, which is how that mistake was caught.

## Disclaimer

Prototype built for a hackathon. Not insurance, not a financial product, no real funds, testnet
only. Nothing here has been audited.
