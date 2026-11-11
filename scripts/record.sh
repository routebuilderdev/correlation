#!/usr/bin/env bash
# The two arms and the payout, driven through the API with no screen involved.
# Useful for checking the chain state on its own, or as the fallback when the
# capture side is unavailable.
#
#   ./scripts/record.sh            seed A, control on A, seed B, poisoned on B, claim B
#   PAUSE=1 ./scripts/record.sh    stop between the steps
#
# Two policies are not a stylistic choice. The contract keeps one receipt per
# (policy, agent) with a nullifier and rejects a repeat with E05, so the poisoned
# arm cannot post into the control arm's policy. The API treats E05 as success,
# which means filming both arms on one policy shows twenty red cells, a 0% index
# and no payout — a demo that looks broken instead of one that proves something.
#
# B is bought with an explicit --limit and a --topup-to so its payout number is
# the same as A's: a limit is computed from free capital, and A has already
# committed most of the pool.
#
# Costs forty completions in total. The API and the UI must already be running
# (./scripts/go.sh in another terminal).
set -euo pipefail

: "${API:=http://127.0.0.1:8787}"
: "${LIMIT:=7.8284}"      # the cover the README, the submission and the video quote
: "${TARGET:=8.6284}"      # free capital to hold before each policy is bought
: "${HEADROOM:=0.8}"      # extra free capital so the pool is not shown at exactly zero
PAUSE="${PAUSE:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

beat() {
  echo
  echo "──────────────────────────────────────────────"
  echo "  $1"
  echo "──────────────────────────────────────────────"
  if [[ "$PAUSE" == "1" ]]; then read -r -p "  press enter for the next step " _; fi
}

field() {
  curl -fsS "$API/api/policy/$1" | python3 -c "import json,sys; print(json.load(sys.stdin)['policy']['$2'])"
}

# yocto -> exact decimal NEAR, without a float in the middle.
near_of() {
  python3 -c 'import sys; w,f=divmod(int(sys.argv[1]), 10**24); print(f"{w}.{f:024d}")' "$1"
}

seed() {
  ( cd "$ROOT" && npm run seed --workspace @correlation/api --silent -- "$@" 2>/dev/null | grep -v deprecated || true )
}

newest_policy() {
  # health caches the newest id for 15s, so poll until the id moves.
  local before="${1:-0}" id
  for _ in $(seq 1 40); do
    id=$(curl -fsS "$API/api/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("policyId") or 0)')
    if [[ "$id" -gt "$before" ]]; then echo "$id"; return 0; fi
    sleep 1
  done
  echo "the contract never showed a new policy" >&2
  return 1
}

beat "1/6  policy A"
# On a contract with no policies yet the newest id is 0, so read it before the
# seed instead of assuming one already exists.
CURRENT=$(curl -fsS "$API/api/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("policyId") or 0)')
seed --new --limit "$LIMIT" --topup-to "$TARGET"
A=$(newest_policy "$CURRENT")
echo "  policy A = $A"
./scripts/wait-window.sh "$A"

beat "2/6  control arm on A: twenty agents, the ordinary prompt"
( cd "$ROOT" && ./scripts/demo.sh control "$A" )

beat "3/6  policy B, funded so its limit equals A's"
LIMIT_A=$(near_of "$(field "$A" limit)")
echo "  A limit $LIMIT_A NEAR"
# Free capital has to reach the limit again for B to buy the same cover, plus a
# little so the page does not read "available 0.0000" while the pool is healthy.
TARGET_B=$(python3 -c 'import sys; print(f"{float(sys.argv[1]) + float(sys.argv[2]):.12f}")' "$LIMIT_A" "$HEADROOM")
seed --new --limit "$LIMIT_A" --topup-to "$TARGET_B"
B=$(newest_policy "$A")
echo "  policy B = $B"
./scripts/wait-window.sh "$B"

beat "4/6  poisoned arm on B: the same task, one wrong shared premise"
( cd "$ROOT" && ./scripts/demo.sh poisoned "$B" )

beat "5/6  did all twenty receipts land?"
read -r STARTED FAILED <<<"$(python3 - "$API" "$B" <<'PY'
import json, sys, urllib.request
with urllib.request.urlopen(f"{sys.argv[1]}/api/policy/{sys.argv[2]}", timeout=10) as r:
    p = json.load(r)["policy"]
print(p["started"], p["failed"])
PY
)"
echo "  $STARTED started, $FAILED failed"
# The trigger needs min_agents (20) started and min_receipts (16) posted, so one
# rejected post is the difference between a payout and a video with no ending.
if [[ "$STARTED" -lt 20 ]]; then
  echo "  only $STARTED of 20 receipts are on chain — the trigger needs 20, so nothing would pay" >&2
  exit 1
fi

beat "6/6  claim the payout"
curl -fsS -X POST "$API/api/claim" -H 'content-type: application/json' -d "{\"policyId\":$B}" | sed 's/^/  /'
echo

python3 - "$API" "$B" <<'PY'
import json, sys, urllib.request
with urllib.request.urlopen(f"{sys.argv[1]}/api/policy/{sys.argv[2]}", timeout=10) as r:
    d = json.load(r)
p, pool = d["policy"], d["pool"]
print(f"  policy {p['policy_id']}  {p['status']}  paid {int(p['paid_amount'])/1e24:.4f} NEAR")
print(f"  index   {p['failed']} failed of {p['started']} started")
print(f"  pool    {int(pool['available'])/1e24:.4f} NEAR still available")
PY
echo
echo "finished runs live in api/.runs/ — copy the ids into the README table"
