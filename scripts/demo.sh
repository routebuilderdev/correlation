#!/usr/bin/env bash
# Drive one swarm run through the API and print the index the chain computes.
set -euo pipefail

: "${API:=http://127.0.0.1:8787}"
MODE="${1:-poisoned}"

RUN=$(curl -fsS -X POST "$API/api/runs" \
  -H 'content-type: application/json' \
  -d "{\"mode\":\"$MODE\",\"policyId\":1}")
RUN_ID=$(printf '%s' "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
echo "run $RUN_ID ($MODE)"

while true; do
  BODY=$(curl -fsS "$API/api/runs/$RUN_ID")
  STATUS=$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  printf '\r%s %s' "$STATUS" "${BODY:0:0}"
  case "$STATUS" in
    triggered|error) break ;;
  esac
  sleep 1
done

echo
printf '%s' "$BODY" | python3 -c '
import json,sys
run=json.load(sys.stdin)
ok=sum(1 for r in run["results"] if r["ok"])
print(f"correct {ok}/{len(run[\"results\"])}  status {run[\"status\"]}  evaluate {run[\"evaluateTx\"]}")
for r in run["results"]:
    if not r["ok"]:
        print(f"  {r[\"agentId\"]}  n={r[\"n\"]} a={r[\"answer\"]} expected={r[\"expected\"]} {r[\"txHash\"]}")
'
