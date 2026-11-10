# Filming the demo

Target: **one 85-second 1280×720 MP4**, no voice, captions burned in. That is not a stylistic
choice — a free X account cannot post more than 140 seconds or more than 720p, and the demo post is
the only link the submission accepts.

The hackathon rule is explicit (Q-012): a public repo, a reproducible README **and** an X post with
the video. Screenshots are not enough when judges cannot open the demo. Judge guidance from
Devpost/AngelHack says the same thing in different words: get to the working screen in the first few
seconds, show one complete moment, do not show the code editor, and cut the waiting.

## What is on this machine

| Need | Present |
|---|---|
| Screen capture | `ffmpeg` with `x11grab`, display `:1`, 1920×1080 primary |
| Browser at an exact size | `google-chrome-stable` with `--window-size=1280,720 --window-position=0,0` |
| Captions | `drawtext` with `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` |
| Audio | a capture device exists, but no `pactl` and no mixer set up — **no narration** |
| asciinema / OBS / Peek | not installed |

Why not a terminal cast: `asciinema` produces a `.cast`, which cannot be attached to an X post
without converting it to a video, and it would throw away the only thing worth watching — the gauge
crossing the trigger and twenty cells going red. Terminal is used for **one** beat: the on-chain
state after the payout.

## The shots

Raw capture is long: twenty agents at concurrency 2, with retries for unsigned completions, takes
minutes per arm. Film everything, then cut. Segment order and lengths below are the edit, not the
capture.

| # | Time | Shot | Caption burned in |
|---|---|---|---|
| 1 | 0:00–0:06 | Title card | `Twenty AI agents. One shared context. One way to fail.` |
| 2 | 0:06–0:16 | UI, policy panel | `An LP funds the pool. A buyer pays 0.1 NEAR for cover.` |
| 3 | 0:16–0:32 | Click **Run control** | `Same task, normal prompt: nothing fails.` |
| 4 | 0:32–0:40 | Cut: cells complete, gauge at 0% | `20 of 20 correct, index 0 bps, trigger 2500.` |
| 5 | 0:40–1:02 | Click **Run poisoned** | `One sentence of shared context added.` |
| 6 | 1:02–1:08 | Cells go red, gauge crosses | `18 of 20 wrong at once — the same wrong answer.` |
| 7 | 1:08–1:16 | Terminal, `curl /api/policy/$POLICY` | `The contract recomputed that index from signed receipts.` |
| 8 | 1:16–1:24 | Click **Claim payout** | `Triggered → paid, automatically, to the buyer.` |
| 9 | 1:24–1:30 | Card with the paid amount + tx hash | `9000 bps against 2500. NEAR paid it.` |

Nine segments is more than it sounds: 1, 2, 4, 7 and 9 are stills or slow shots, so the only
unpredictable footage is 3, 5, 6 and 8.

## 1. Prepare the state first (free)

Nothing is typed on camera. Before recording, the policy must be open, the page must be pointed at
it, and both servers must be up. A policy window is one hour, so this happens right before the take:

```bash
./scripts/preflight.sh                 # says exactly what is missing
npm run seed --workspace @correlation/api -- --new   # fresh policy, prints its id
npm run dev --workspace @correlation/api &           # :8787
npm run dev --workspace @correlation/web &           # :5173
```

Open `http://localhost:5173` — the page asks the contract for the **newest** policy, so a fresh seed
needs no configuration. `?policy=N` pins an older one.

## 2. Capture (needs the one paid run)

`./scripts/film.sh <name>` opens Chrome at exactly 1280×720 on a clean profile and records that
region. `Ctrl-C` stops and prints the duration.

```bash
./scripts/film.sh control     # press Run control, let it finish, Ctrl-C
./scripts/film.sh poisoned    # press Run poisoned, let it trigger, Ctrl-C
./scripts/film.sh claim       # press Claim payout, Ctrl-C
./scripts/film.sh chain       # terminal: curl /api/policy/$POLICY
DURATION=5 ./scripts/film.sh test   # proves the recorder works, five seconds, no model calls
```

Keep the raw files. A second take costs another forty completions, so cut the first one properly.

## 3. Encode for X

720p, H.264 High, yuv420p, AAC track present even though it is silent, `+faststart`, under 140 s.

```bash
# concat the segments you keep
printf "file '%s'\n" film/control.mkv film/poisoned.mkv film/claim.mkv film/chain.mkv > film/list.txt

ffmpeg -f concat -safe 0 -i film/list.txt -vf "scale=1280:720:flags=lanczos,fps=30" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 -preset slow \
  -c:a aac -b:a 128k -movflags +faststart film/correlation-demo.mp4
```

Burn one caption from the table onto a segment:

```bash
CAPTION="18 of 20 wrong at once - the same wrong answer."
ffmpeg -i film/poisoned.mkv -vf \
  "scale=1280:720,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='$CAPTION':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.72:boxborderw=16:\
x=(w-text_w)/2:y=h-110" -c:v libx264 -crf 20 -pix_fmt yuv420p film/poisoned-captioned.mkv
```

Title card with no footage at all:

```bash
ffmpeg -f lavfi -i "color=c=0x0b1020:s=1280x720:d=6" -vf \
  "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='Twenty AI agents. One shared context. One way to fail.':fontcolor=white:fontsize=40:\
x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=18" \
  -c:v libx264 -pix_fmt yuv420p film/card-1.mkv
```

## 4. Check before uploading

```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height \
  -of default=nw=1 film/correlation-demo.mp4
```

- duration ≤ 140 s, size ≤ 512 MB, 1280×720, `h264`, `yuv420p`
- watch it once end to end, at 1× and at 1.5×: every caption legible at 720p, nothing cut mid-word
- no `.env`, no keys, no private messages anywhere on screen — the UI shows account ids, which is
  fine and intended

## 5. The post

The human posts it: the video attached, text from `SUBMISSION.md`, `@NEARProtocol` and
`#NEARHackathon` in it, repo link in the reply. `demoUrl` is that post, and it must exist before the
submission is sent.

## If the model is unreachable on the day

`api/.runs/<id>.json` holds every finished run, and `http://localhost:5173/?run=<id>` renders it
without touching the model. That is the fallback for a live judging session, not a substitute for
the video: the video must show a live run, because the whole claim is that the chain paid.
