#!/usr/bin/env bash
# Join the captured segments into the one file an X post accepts.
#
#   ./scripts/edit.sh                       film/list.txt -> film/correlation-demo.mp4
#   ./scripts/edit.sh film/list.txt out.mp4
#
# film/list-cut.txt is the same segment list with inpoint/outpoint holding each
# shot only as long as it needs: the caption beat plus the click, scroll or
# result it proves, and no frozen tail. Use it for the tight cut (60s, not 103s).
#
# Captions and the step chip were drawn in the page while recording, so this is a
# straight join and a single encode — nothing is burned in here and nothing can
# drift out of sync with the picture.
#
# The encode targets what X documents for a free account: H.264 High, yuv420p
# (4:2:0 only), 30 fps, 1280x720, AAC 128 kbps even though the track is silent,
# faststart, and under 140 seconds / 512 MB. Quality comes from CRF 18 with a
# 6 Mbps ceiling: X's 5-6 Mbps figure for 720p is the most it wants, not the
# least, and a screencast of mostly still frames legitimately lands far below it
# because there is nothing for the encoder to spend bits on.
set -euo pipefail

cd "$(dirname "$0")/.."

LIST="${1:-film/list.txt}"
OUT="${2:-film/correlation-demo.mp4}"
MAX_SECONDS="${MAX_SECONDS:-140}"
MAX_BYTES=$((512 * 1024 * 1024))

[[ -f "$LIST" ]] || { echo "no segment list at $LIST — run the capture first" >&2; exit 1; }
[[ -s "$LIST" ]] || { echo "$LIST is empty — the capture wrote no segments" >&2; exit 1; }

echo "segments"
grep "^file " "$LIST" | sed "s/^file '/  /; s/'$//"

ffmpeg -hide_banner -loglevel warning -y \
  -f concat -safe 0 -i "$LIST" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -fps_mode cfr -r 30 \
  -vf "scale=1280:720:flags=lanczos,format=yuv420p" \
  -c:v libx264 -profile:v high -level 4.0 -preset slow -crf 18 \
  -maxrate 6M -bufsize 12M -g 60 \
  -color_primaries bt709 -colorspace bt709 -color_trc bt709 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart -shortest \
  "$OUT"

python3 - "$OUT" "$MAX_SECONDS" "$MAX_BYTES" <<'PY'
import json, subprocess, sys

path, max_seconds, max_bytes = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
probe = json.loads(subprocess.check_output([
    "ffprobe", "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", path,
]))
video = next(s for s in probe["streams"] if s["codec_type"] == "video")
audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
size = int(probe["format"]["size"])
duration = float(probe["format"]["duration"])
bitrate = int(probe["format"]["bit_rate"])

print()
print(f"  file      {path}")
print(f"  duration  {duration:.1f}s  (limit {max_seconds:.0f}s)")
print(f"  size      {size / 1024 / 1024:.1f} MB  (limit {max_bytes / 1024 / 1024:.0f} MB)")
print(f"  video     {video['codec_name']} {video['profile']} {video['width']}x{video['height']} {video['pix_fmt']} @ {bitrate / 1e6:.1f} Mbps")
print(f"  audio     {'aac ' + audio.get('sample_rate', '') if audio else 'MISSING'}")

problems = []
if video["codec_name"] != "h264":
    problems.append("video is not h264")
if video["pix_fmt"] != "yuv420p":
    problems.append("pixel format is not yuv420p: X re-encodes 4:4:4 badly")
if (video["width"], video["height"]) != (1280, 720):
    problems.append(f"frame is {video['width']}x{video['height']}, not 1280x720")
if duration > max_seconds:
    problems.append(f"{duration:.1f}s is over the {max_seconds:.0f}s limit")
if size > max_bytes:
    problems.append(f"{size / 1024 / 1024:.0f} MB is over 512 MB")
if audio is None:
    problems.append("no audio track")
if bitrate > 6_500_000:
    problems.append(f"{bitrate / 1e6:.1f} Mbps is over the 5-6 Mbps X documents for 720p")
if bitrate < 150_000:
    problems.append(f"{bitrate / 1e6:.2f} Mbps is implausibly low — the capture is probably blank")

print()
if problems:
    for problem in problems:
        print(f"  FAIL  {problem}")
    raise SystemExit(1)
print("  ok to upload")
PY
