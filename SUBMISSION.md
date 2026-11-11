# Submission

Status: **not sent**. Four values are supplied at send time — lead name, email, team size and a
mainnet payout account. The form refuses placeholders and the API accepts one submission per
repository, so the payload is assembled once and checked before it goes.

Deadline: **2026-11-14T23:59:00Z**. Endpoint: `POST https://nearhackathon.com/api/applications`.
Form equivalent: https://nearhackathon.com/#apply

## Form fields

| Field | Rule | Value |
|---|---|---|
| `leadName` | 2–80 chars | _supplied at send time_ |
| `email` | valid, max 160, ≤ 2 submissions per email | _supplied at send time_ |
| `size` | exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | _supplied at send time_ |
| `nearAddress` | **mainnet** named account (`name.near`) or 64-char implicit — never invented | _supplied at send time_ |
| `projectUrl` | public repository, submitted once only | https://github.com/routebuilderdev/correlation |
| `demoUrl` | public X post carrying the video | https://x.com/routebuilderdev/status/2120637879496151410 |

`projectName`: `Correlation`. `tracks`: `["swarms", "security", "privacy"]` — the swarm track is the
primary one; security fits because the mechanism is a proof rather than a promise, privacy because
the receipts are verified inside a TEE.

`requestId`: generated once and reused on every retry, so a retry after a network error does not
look like a second submission:

```bash
node -e 'console.log(crypto.randomUUID())'
```

## Description sent as `idea` (1,184 characters, limit 2,000)

> Agent fleets fail together: one shared model, one shared context, one bad instruction, and twenty
> agents get the same task wrong at the same moment. Nobody insures that, because the loss is
> invisible — each agent looks like a separate customer with an independent failure. Correlation is
> parametric cover for correlated agent failure. An LP funds a pool; a buyer pays a small premium for
> a policy that pays out automatically if enough agents fail the same task inside a time window. The
> trigger is not an oracle's opinion. Every agent receipt carries an ECDSA signature produced inside
> the model's TEE; the buyer submits the raw request and response bytes, and the NEAR contract
> re-derives the expected task input, rebuilds the signed text, recovers the signer and recomputes
> the arithmetic itself. Twenty signed receipts produce an index, the index crosses the threshold,
> and the contract pays. Proven on testnet: twenty agents, eighteen failures, 9000 bps against a
> 2500 bps trigger, 7.83 NEAR paid automatically; the same fleet on a clean context the same day
> missed once in twenty. NEAR makes this cheap and trustless: verification
> costs fractions of a cent, receipts are final in seconds, and the payout cannot be stopped by
> anyone holding the keys.

## The post, published 2026-11-11

267 weighted characters, video attached, alt text on the video.

> One sentence in the shared prompt. 18 of 20 agents returned the same wrong number.
> Control: 1 of 20. Nothing.
> A NEAR contract verified the signed receipts on-chain and paid out 7.8284 NEAR by itself.
> NEAR HACKATHON @NEARProtocol #NEARHackathon
> https://github.com/routebuilderdev/correlation

First reply, carrying the control arm and the payout transaction:

> Same day, same model, control arm: 1 failure in 20 — 500 bps, under the
> 2500 trigger, no payout.
>
> 18 of 20 vs 1 of 20. The only difference is one sentence of context.
>
> Payout: testnet.nearblocks.io/txns/861Ege74351hAyg95hDX6UJZw8zPPpoaN2wu6kjXf7t
>
> What failure would you want covered first?

## Pre-flight, before the payload is sent

- [ ] Research notes stay out of the published tree — excluded in `.git/info/exclude`, untracked,
      and not to be added.
- [ ] The abandoned `correlation/` scaffold stays untracked (`/correlation/` in `.gitignore`).
- [ ] No secrets in history: only `.env.example` is tracked.
- [ ] `README.md` renders the run that actually happened, with the contract address.
- [ ] `LICENSE` present (AGPL-3.0).
- [x] Repository public before 2026-11-14T23:59:00Z.
- [x] Demo post live with video attached: https://x.com/routebuilderdev/status/2120637879496151410
- [ ] Payload under 12,000 bytes, no `website` field.
- [ ] Payload checked against the form rules before sending.

## What the run recorded

The demo video is `film/correlation-demo.mp4`, 60.5 s, 720p, silent, captioned in-page. It shows
policy P-019 (control: 20 receipts, 1 failed, 500 bps, no payout) and P-020 (poisoned: 20 receipts,
18 failed, 9000 bps, 7.8284 NEAR paid to the buyer; claim
`861Ege74351hAyg95hDX6UJZw8zPPpoaN2wu6kjXf7t`).

Both policies are readable from `correlation.testnet` with `get_policy`, so the numbers on screen
can be checked against the chain rather than taken from this file.

Remaining work: the four send-time values, and the `POST` itself.
