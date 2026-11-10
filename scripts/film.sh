#!/usr/bin/env bash
# Record the demo at exactly 1280x720, the size a free X account can post.
#
#   ./scripts/film.sh control      open the browser, record, Ctrl-C to stop
#   ./scripts/film.sh chain        same, for a terminal beat (no browser)
#   DURATION=5 ./scripts/film.sh test    stop by itself after five seconds
#
# Output: film/<name>.mkv. Raw footage only; DEMO_VIDEO.md has the edit.
set -euo pipefail

NAME="${1:-take}"
: "${SIZE:=1280x720}"
: "${FPS:=30}"
: "${DISPLAY:=:1}"
: "${URL:=http://localhost:5173}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/film"
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed" >&2; exit 1; }

if [[ "$NAME" != "chain" ]]; then
  curl -fsS --max-time 3 "${URL%/}/api/health" >/dev/null 2>&1 || {
    echo "the UI is not answering at $URL — start ./scripts/go.sh first" >&2; exit 1; }
  # A clean profile: a window with only this page, no tabs, no history.
  google-chrome-stable \
    --app="$URL" \
    --window-size="${SIZE/x/,}" \
    --window-position=0,0 \
    --user-data-dir="/tmp/correlation-film" \
    --no-first-run --no-default-browser-check \
    >/dev/null 2>&1 &
  sleep 3
fi

echo "recording $SIZE at ${FPS}fps to film/$NAME.mkv — Ctrl-C to stop"
START=$(date +%s)
ffmpeg -hide_banner -loglevel warning \
  -f x11grab -framerate "$FPS" -video_size "$SIZE" -i "${DISPLAY}.0+0,0" \
  ${DURATION:+-t "$DURATION"} \
  -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p \
  "$OUT/$NAME.mkv"
SECONDS_TAKEN=$(( $(date +%s) - START ))

echo
echo "wrote film/$NAME.mkv in ${SECONDS_TAKEN}s"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT/$NAME.mkv"
