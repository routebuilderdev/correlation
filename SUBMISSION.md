# Submission

Status: **not sent**. Six values below are yours alone — the form refuses placeholders, and the API
accepts one submission per repository, so nothing is sent until you have confirmed the exact payload.

Deadline: **2026-11-14T23:59:00Z**. Endpoint: `POST https://nearhackathon.com/api/applications`.
Form equivalent: https://nearhackathon.com/#apply

## What only you can supply

| Field | Rule | Value |
|---|---|---|
| `leadName` | 2–80 chars | _your name_ |
| `email` | valid, max 160, ≤ 2 submissions per email | _your email_ |
| `size` | exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | _team size_ |
| `nearAddress` | **mainnet** named account (`you.near`) or 64-char implicit — never invented | _payout account_ |
| `projectUrl` | public repository, submitted once only | https://github.com/routebuilderdev/correlation |
| `demoUrl` | public X post, written and published by you | https://x.com/routebuilderdev/status/2120637879496151410 |

`projectName`: `Correlation`. `tracks`: `["swarms", "security", "privacy"]` — primary is the swarm
track; the security track fits because the mechanism is a proof, not a promise; privacy because the
receipts are verified inside a TEE. Drop any that overstate the fit.

`requestId`: generate once, reuse on every retry (a retry after a network error must not look like a
second submission):

```bash
node -e 'console.log(crypto.randomUUID())'
```

## The description (paste as `idea`, 1,184 characters, limit 2,000)

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

## The X post (you publish it, I cannot)

> Twenty agents, one shared model, one shared prompt — they all fail at once. Nobody insures a fleet
> failing together, because the loss looks like twenty unrelated mistakes.
>
> I built Correlation at NEAR HACKATHON: an LP funds a pool, a buyer pays a premium, and if enough
> agents fail the same task the payout fires automatically.
>
> The part that matters: the contract does not trust my orchestrator. Each agent's call comes back
> signed inside the model's TEE, and the contract re-verifies the bytes, recovers the signer and
> recomputes the arithmetic on chain.
>
> Testnet run: 20 agents, 18 wrong answers, 9000 bps index, 7.83 NEAR paid out. The clean control
> arm the same day missed once in twenty — 500 bps, under the trigger, no payout.
>
> @NEARProtocol #NEARHackathon — repo + video in the reply.
> Feedback welcome: would you underwrite an agent fleet?

## Pre-flight, before the payload is sent

- [ ] Research docs (`COMPETITIVE_ANALYSIS.md`, `CORRELATION_RESEARCH.md`, `JUDGE_DEEP_DIVE.md`,
      `NEAR hackathon research.md`) stay out of the published tree — they are excluded in
      `.git/info/exclude`, untracked, and must remain so.
- [ ] The abandoned `correlation/` scaffold stays untracked (`/correlation/` in `.gitignore`).
- [ ] No secrets in history: only `.env.example` is tracked.
- [ ] `README.md` renders the run that actually happened, with the contract address.
- [ ] `LICENSE` present (AGPL-3.0).
- [x] Repository public before 2026-11-14T23:59:00Z.
- [x] Demo post live with video attached: https://x.com/routebuilderdev/status/2120637879496151410
- [ ] Payload under 12,000 bytes, no `website` field.
- [ ] Print the full JSON and get a yes before `curl`.

## Not done yet

The demo video is recorded: `film/correlation-demo.mp4`, 60.5s, 720p, silent, captioned in-page.
It shows policy P-019 (control: 20 receipts, 1 failed, 500 bps, no payout) and P-020 (poisoned: 20
receipts, 18 failed, 9000 bps, 7.8284 NEAR paid to the buyer; claim
`861Ege74351hAyg95hDX6UJZw8zPPpoaN2wu6kjXf7t`).

Done: the repository is pushed, public and licensed AGPL-3.0, and the demo post is live.

Still yours alone: the six form values, and sending the payload.
