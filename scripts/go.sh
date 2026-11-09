#!/usr/bin/env bash
# One command for the whole demo: check readiness, then serve API + UI.
#
#   ./scripts/go.sh              preflight, then start
#   ./scripts/go.sh --capture    also replace the synthetic fixture with a live one
#   ./scripts/go.sh --no-net     skip network checks
set -euo pipefail

cd "$(dirname "$0")/.."
CAPTURE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --capture) CAPTURE=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

./scripts/preflight.sh "${ARGS[@]}"

if [[ "$CAPTURE" -eq 1 ]]; then
  echo
  echo "capturing a live fixture (one completion, policy 1 / agent index 2)"
  npm run capture --workspace @correlation/api
  echo "re-running the signature tests against the captured bytes"
  ( cd contract && cargo test )
fi

echo
echo "starting api (:${PORT:-8787}) and web"
npm run dev --workspace @correlation/api &
API_PID=$!
npm run dev --workspace @correlation/web &
WEB_PID=$!
cleanup() { kill "$API_PID" "$WEB_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo
echo "  ui   http://localhost:5173"
echo "  api  http://localhost:${PORT:-8787}/api/health"
echo "  stop ctrl-c"
wait
