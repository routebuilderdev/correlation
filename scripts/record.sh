#!/usr/bin/env bash
# The whole demo in one command, in the order the video needs it.
#
#   ./scripts/record.sh            seed a fresh policy, control arm, poisoned arm, claim
#   PAUSE=1 ./scripts/record.sh    stop between steps so the screen can be filmed
#
# Costs one model request per agent per arm (forty in total). The API and the UI
# must already be running: ./scripts/go.sh in another terminal.
set -euo pipefail

: "${API:=http://127.0.0.1:8787}"
PAUSE="${PAUSE:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

beat() {
  echo
  echo "──────────────────────────────────────────────"
  echo "  $1"
  echo "──────────────────────────────────────────────"
  if [[ "$PAUSE" == "1" ]]; then read -r -p "  press enter for the next step " _; fi
}

beat "1/4  a fresh policy, funded from the pool"
( cd "$ROOT" && npm run seed --workspace @correlation/api --silent -- --new 2>/dev/null | grep -v deprecated )

POLICY=$(curl -fsS "$API/api/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["policyId"])')
echo "  the page is driving policy $POLICY"

beat "2/4  control arm: twenty agents, one task, nothing wrong"
( cd "$ROOT" && ./scripts/demo.sh control "$POLICY" )

beat "3/4  poisoned arm: the same task, a single wrong premise"
( cd "$ROOT" && ./scripts/demo.sh poisoned "$POLICY" )

beat "4/4  claim the payout"
CLAIM=$(curl -fsS -X POST "$API/api/claim" -H 'content-type: application/json' -d "{\"policyId\":$POLICY}")
echo "  $CLAIM"

curl -fsS "$API/api/policy/$POLICY" | python3 -c '
import json,sys
d=json.load(sys.stdin); p=d["policy"]; pool=d["pool"]
print(f"  policy {p[\"policy_id\"]}  {p[\"status\"]}  paid {int(p[\"paid_amount\"])/1e24:.4f} NEAR")
print(f"  index   {p[\"failed\"]} failed of {p[\"started\"]} started")
print(f"  pool    {int(pool[\"available\"])/1e24:.4f} NEAR still available")
'
echo
echo "recorded runs live in api/.runs/ — copy the ids above into the README table"
