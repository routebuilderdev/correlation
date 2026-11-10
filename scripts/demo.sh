#!/usr/bin/env bash
# Drive one swarm run through the API and print what the chain computed.
#
#   ./scripts/demo.sh                newest policy on the contract, poisoned
#   ./scripts/demo.sh control        same policy, control arm
#   ./scripts/demo.sh poisoned 4     pin a policy id
#
# The API must be running (`npm run dev --workspace @correlation/api`).
set -euo pipefail

: "${API:=http://127.0.0.1:8787}"
MODE="${1:-poisoned}"

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

POLICY="${2:-}"
if [[ -z "$POLICY" ]]; then
  POLICY=$(curl -fsS "$API/api/health" | json 'd.get("policyId") or 1')
fi

RUN=$(curl -fsS -X POST "$API/api/runs" \
  -H 'content-type: application/json' \
  -d "{\"mode\":\"$MODE\",\"policyId\":$POLICY}")
RUN_ID=$(printf '%s' "$RUN" | json 'd["runId"]')
echo "run $RUN_ID ($MODE, policy $POLICY)"

while true; do
  BODY=$(curl -fsS "$API/api/runs/$RUN_ID")
  STATUS=$(printf '%s' "$BODY" | json 'd["status"]')
  printf '\r%s   ' "$STATUS"
  case "$STATUS" in
    triggered|error) break ;;
    complete) break ;;
  esac
  sleep 1
done
echo

printf '%s' "$BODY" | python3 -c '
import json,sys
run=json.load(sys.stdin)
rows=run["results"]
ok=sum(1 for r in rows if r["ok"])
started=len(rows)
bps=0 if started==0 else round(10000*sum(1 for r in rows if not r["ok"])/started)
print(f"correct {ok}/{started}  index {bps} bps  status {run[\"status\"]}  evaluate {run[\"evaluateTx\"]}")
for r in rows:
    if not r["ok"]:
        print(f"  {r[\"agentId\"]}  n={r[\"n\"]} a={r[\"answer\"]} expected={r[\"expected\"]} {r[\"txHash\"]}")
'
