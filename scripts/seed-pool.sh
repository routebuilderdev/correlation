#!/usr/bin/env bash
# Fund the pool and buy the demo policy: 100 NEAR capital, 10 NEAR limit,
# 1 NEAR premium, 2500 bps trigger, 16-of-20 receipts required.
set -euo pipefail

: "${CONTRACT_ID:=correlation.testnet}"
: "${LP_ACCOUNT:=lp.correlation.testnet}"
: "${BUYER_ACCOUNT:=buyer.correlation.testnet}"
: "${MODEL_ID:=z-ai/glm-5.3-flash}"
: "${PUBLIC_KEY:?set PUBLIC_KEY to the registered signer key}"

WINDOW_START=${WINDOW_START:-$(( ($(date +%s) + 30) * 1000000000 ))}
WINDOW_END=${WINDOW_END:-$(( ($(date +%s) + 3630) * 1000000000 ))}

near call "$CONTRACT_ID" deposit '{"pool_id":1}' \
  --accountId "$LP_ACCOUNT" --deposit 100 --networkId testnet

TERMS=$(cat <<JSON
{"limit":"10000000000000000000000000","premium":"1000000000000000000000000","trigger_bps":2500,"window_start_ns":$WINDOW_START,"window_end_ns":$WINDOW_END,"min_agents":20,"min_receipts":16,"model_id":"$MODEL_ID","signer_pubkey":"$PUBLIC_KEY"}
JSON
)
TERMS_HASH=$(printf '%s' "$TERMS" | sha256sum | cut -d' ' -f1)

near call "$CONTRACT_ID" register_swarm "{
  \"swarm_id\": \"swarm-1\",
  \"fingerprint\": {
    \"model_id\": \"$MODEL_ID\",
    \"prompt_hash\": \"$(printf '%064d' 0)\",
    \"agent_ids\": [$(for i in $(seq -w 1 20); do printf '"agent-%s",' "$i"; done | sed 's/,$//')]
  }
}" --accountId "$BUYER_ACCOUNT" --networkId testnet

near call "$CONTRACT_ID" buy_policy "{
  \"swarm_id\": \"swarm-1\",
  \"terms\": {\"terms_json\": $(printf '%s' "$TERMS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"terms_hash\": \"$TERMS_HASH\"}
}" --accountId "$BUYER_ACCOUNT" --deposit 1 --networkId testnet
