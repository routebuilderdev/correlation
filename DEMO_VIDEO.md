# Filming the demo

Target: **one MP4 under 140 seconds at 1280×720**, no voice, captions inside the picture. That is not
a style choice — a free X account cannot post longer than 140 seconds or larger than 720p, and the
demo post is the only link the submission accepts.

The rule is explicit (hackathon Q-012): a public repo, a reproducible README **and** an X post with
the video. Screenshots are not enough when judges cannot open the demo. Judging guidance says the
same in different words: reach the working screen in seconds, show one complete moment, never show
the code editor, cut the waiting.

Two things about the audience shape the edit:

- **Screening agents cannot watch video.** They get sampled frames plus text, so every frame has to
  explain itself and every number has to be on screen as text — not only as a bar or a colour.
- **A phone viewer sees 1280×720 at arm's length.** The UI's own type is 10–14 px, so the capture
  renders the page at 1.25× device scale and the captions are set at 19 px CSS.

## What is on this machine

| Need | Present |
|---|---|
| Offscreen browser | `google-chrome-stable` 156 — headless, no desktop involved |
| Capture | Chrome's own frame stream over the DevTools protocol, PNG, 1280×720 |
| Clicks | `Input.dispatchMouseEvent` — scripted, so a take is repeatable |
| Pointer | drawn into the page by the capture script (SVG + click ring) |
| Encode | `ffmpeg` 6.1 with libx264 |
| Audio | none: no narration, a silent AAC track for X's benefit |

There is deliberately **no screen capture** any more. Recording a desktop region meant whatever was
open could land in a frame — and this machine has a browser with a wallet extension open. Offscreen
Chrome removes the class of mistake instead of asking the operator to remember it.

## The four rules the footage depends on

1. **One policy per arm.** The contract keeps a receipt per `(policy, agent)` with a nullifier and
   rejects a repeat with `E05`. Filming both arms on one policy gives twenty red cells, a 0% index,
   no trigger and no Claim button — and the API treats `E05` as success, so nothing explains it.
2. **The window opens 60 s after the policy is bought.** A policy is `Active` immediately and the
   page used to enable Run straight away, but `post_receipt` panics `E03` before `window_start_ns`.
   The page now shows the countdown and keeps Run disabled until it opens; the capture script waits
   for the same condition.
3. **A policy's limit comes from free capital, and an old policy still holds its own.** After A
   commits 7.8284 NEAR, free capital is ~0.8, so a second seed would buy 0.8 NEAR of cover. The
   seeder now retires Active policies whose window has closed, and `--limit 7.8284 --topup-to 8.63`
   funds the pool to an exact free amount, so both policies read 7.8284 NEAR — the number the
   README, `SUBMISSION.md` and the closing card quote.
4. **`claim` pays the policy's own commitment, not the pool's free balance.** `backing = total −
   (committed − limit)`, so a topped-up pool pays the full limit even while another policy is still
   open. No top-up, and the payout would have been capped below the quoted number.

## The shots

Ten segments, about 90 seconds. Segment numbers match the files `film/NN-name.mkv`.

| # | File | Shot | Caption in the picture |
|---|---|---|---|
| 1 | `01-intro` | Card | Twenty AI agents fail together. This contract pays for it. |
| 2 | `02-policy` | Policy panel, idle | An LP funded the pool. A buyer paid 0.10 NEAR for cover of up to 7.8284 NEAR, for one hour. |
| 3 | `03-control-click` | Click **Run control**, cells start to fill | Twenty agents get the ordinary prompt. Each answer comes back signed inside the model's enclave and is posted to the contract. |
| 4 | `04-control-result` | 20/20 green, index 0 bps | 20 of 20 correct. Failed 0 of 20 started, index 0 bps, below the 2500 bps trigger, so the policy stays Active and pays nothing. |
| 5 | `05-policy-b` | Second policy panel | A second policy for the second arm: the contract accepts one receipt per agent per policy, so each arm needs its own. |
| 6 | `06-poisoned-click` | Click **Run poisoned** | Same task, same model, one added sentence of shared context: round the number instead of computing it. |
| 7 | `07-gauge` | Index crossed | 18 of 20 wrong, all with the same wrong answer. 9000 bps against a 2500 bps trigger. |
| 8 | `08-receipts` | Scrolled to the receipts table | The contract hashed each request and response, recovered the enclave signature and redid the arithmetic. The tx column is where each receipt landed. |
| 9 | `09-claim` | Click **Claim payout** | The buyer claims. The pool pays 7.8284 NEAR automatically: no approver, no key that can stop it. |
| 10 | `10-outro` | Card with the paid amount | 7.8284 NEAR paid to the buyer · claim tx … |

Each segment also carries a step chip above the caption (`STEP 7 / 10 · INDEX 9000 BPS ·
TRIGGERED`), so any single sampled frame says where it is and what the numbers mean.

The two multi-minute waits — twenty completions per arm — are recorded, then re-timed. The screencast
only emits a frame when the page changes, so ninety seconds of twenty agents costs a few dozen
frames; `startSegment(name, { timelapse: true })` gives each of them the same slice and aims the
whole shot at six seconds, which is why two minutes of work reads as a few seconds of cells filling
instead of a jump cut. The caption says it is sped up.

## 1. Dry run first (free)

```bash
./scripts/go.sh                 # preflight, api :8787, ui :5173
npm run seed --workspace @correlation/api -- --new   # a policy to look at
./scripts/film.sh check         # records five segments, spends nothing
./scripts/edit.sh               # film/correlation-demo.mp4
```

`check` records the intro card, the idle page, the drawn pointer clicking something harmless, a
scroll to the receipts table and the closing card. It answers the questions that cannot be answered
by reading code: is the frame exactly 1280×720, is the pointer convincing, is 19 px caption text
legible, does the scroll land with the table above the caption bar.

Also look at `film/probe.png`: one still of the viewport, written at startup. `SHOOT_SCALE=1
./scripts/film.sh check` records the same beats at 100% for comparison — 1.25 is the default because
the table's 12 px type is too small at 1×.

Delete `film/` afterwards if you want the paid take to be the only thing on disk.

## 2. The take

```bash
./scripts/film.sh take --yes-spend
```

It seeds policy A, waits for its window, records shots 1–4, tops up the pool, seeds policy B with
A's exact limit, records shots 5–10, and reads the paid amount and claim hash for the closing card.
Forty completions in total, a few cents.

The 60-second window waits are printed live. Do not skip them: a take started early records twenty
`E03` rejections.

If the take dies halfway, `film/manifest.json` lists what was captured; `take` starts over because
both arms need a policy each, and a policy is one shot.

## 3. Encode

```bash
./scripts/edit.sh
```

Joins `film/list.txt`, encodes H.264 High / yuv420p / 30 fps / CRF 18 capped at 6 Mbps, adds the
silent AAC track, `+faststart`, then checks the file against the upload rules and fails loudly if
something is off. `MAX_SECONDS=140` is the default.

## 4. Check before uploading

- the encode check prints `ok to upload`
- watch it once at 1× and once at 1.5×: every caption legible, nothing cut mid-word
- `./scripts/film.sh frames film/correlation-demo.mp4 film/frames` and look at all of them: only the
  page, no desktop, no notification, no terminal
- on-page text is public by design: account ids, the model id, the contract id, tx hashes

## 5. The post

The human posts it: video attached, text from `SUBMISSION.md`, `@NEARProtocol` and `#NEARHackathon`
in it, repo link in the reply. `demoUrl` is that post and it has to exist before the submission is
sent.

## If the model is unreachable on the day

`api/.runs/<id>.json` holds every finished run, and `http://localhost:5173/?run=<id>` renders one
without touching the model. That is the fallback for a live judging session, not a substitute for
the video: the video has to show a live run, because the whole claim is that the chain paid.
