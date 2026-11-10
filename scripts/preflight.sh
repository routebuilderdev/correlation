#!/usr/bin/env bash
# Say exactly what is missing before a demo, with the command that fixes it.
#
#   ./scripts/preflight.sh            offline + RPC + key validity (no tokens spent)
#   ./scripts/preflight.sh --no-net   offline only
#   ./scripts/preflight.sh --deep     also make one real 1-token completion
#
# Exit 0 means every required item is present.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
NET=1
DEEP=0
for arg in "$@"; do
  case "$arg" in
    --no-net) NET=0 ;;
    --deep) DEEP=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown flag $arg" >&2; exit 2 ;;
  esac
done

if [[ -f .env ]]; then
  set -a; . ./.env; set +a
  echo "env      .env loaded"
else
  # Check against the template's defaults so the report is about missing secrets,
  # not about values that already have sane defaults.
  set -a; . ./.env.example; set +a
  echo "env      no .env — using .env.example defaults; run: cp .env.example .env"
fi

FAIL=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n        → %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  warn  %s\n' "$1"; }

echo
echo "toolchain"
command -v node >/dev/null && ok "node $(node -v)" || bad "node missing" "install Node 20+"
if [[ -d node_modules ]]; then ok "node_modules present"; else bad "dependencies not installed" "npm install"; fi
command -v cargo >/dev/null && ok "cargo $(cargo --version | awk '{print $2}')" || bad "cargo missing" "install rustup"
if cargo build --release --target wasm32-unknown-unknown --manifest-path contract/Cargo.toml >/dev/null 2>&1; then
  ok "contract builds ($(du -h contract/target/wasm32-unknown-unknown/release/correlation.wasm | cut -f1))"
else
  bad "contract does not build" "cd contract && cargo build --release --target wasm32-unknown-unknown"
fi
if command -v near >/dev/null; then ok "near-cli present"; else warn "near-cli missing — only needed for ./scripts/deploy.sh"; fi

echo
echo "configuration"
if [[ -n "${NEARAI_API_KEY:-}" ]]; then ok "NEARAI_API_KEY set"; else bad "NEARAI_API_KEY empty" "add it to .env (never paste it in chat)"; fi
case "${NEARAI_BASE_URL:-}" in
  *".completions.near.ai"*) ok "direct model endpoint ${NEARAI_BASE_URL}" ;;
  *) bad "NEARAI_BASE_URL is not a direct endpoint" "use https://<slug>.completions.near.ai/v1 — the gateway's signatures are rejected E07" ;;
esac
for key in EVAL_PRIVATE_KEY BUYER_PRIVATE_KEY; do
  if [[ -n "${!key:-}" ]]; then ok "$key set"; else bad "$key empty" "create the account with ./scripts/register-signer.sh"; fi
done
if [[ -n "${CONTRACT_ID:-}" ]]; then ok "CONTRACT_ID ${CONTRACT_ID}"; else bad "CONTRACT_ID empty" "export CONTRACT_ID in .env"; fi

if [[ "$NET" -eq 0 ]]; then
  echo "$FAIL failing item(s) (network checks skipped)"
  exit $(( FAIL > 0 ))
fi

echo
echo "network"
RPC="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"
if curl -fsS --max-time 10 -X POST "$RPC" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":"p","method":"status","params":[]}' >/dev/null; then
  ok "rpc reachable ($RPC)"
else
  bad "rpc unreachable" "check NEAR_RPC_URL and this machine's network"
fi

# Account existence and balance, straight over RPC so no near-cli is needed.
check_account() {
  local account="$1" required="$2" label="$3"
  local body
  body=$(python3 - "$RPC" "$account" <<'PY'
import json, sys, urllib.request
rpc, account = sys.argv[1], sys.argv[2]
req = urllib.request.Request(rpc, data=json.dumps({
    "jsonrpc": "2.0", "id": "q", "method": "query",
    "params": {"request_type": "view_account", "finality": "final", "account_id": account},
}).encode(), headers={"content-type": "application/json"})
try:
    res = json.load(urllib.request.urlopen(req, timeout=10))
except Exception as exc:
    print("ERR", exc); raise SystemExit
err = res.get("error")
if err:
    print("MISSING", err.get("cause", {}).get("name", "")); raise SystemExit
amount = int(res["result"]["amount"])
print("OK", amount)
PY
)
  read -r verdict amount <<<"$body"
  case "$verdict" in
    OK)
      local near
      near=$(python3 -c "print(f'{$amount/1e24:.3f}')")
      if python3 -c "import sys; sys.exit(0 if $amount >= $required else 1)"; then
        ok "$account exists, $near NEAR"
      else
        bad "$account is underfunded ($near NEAR)" "send testnet NEAR to $account"
      fi ;;
    MISSING) bad "$account does not exist" "$label" ;;
    *) bad "$account lookup failed" "rpc said: $body" ;;
  esac
}

check_account "${CONTRACT_ID:-correlation.testnet}" 0 "run ./scripts/deploy.sh to create and deploy it"
check_account "${EVAL_ACCOUNT:-correlation-eval.testnet}" 1000000000000000000000000 "run ./scripts/register-signer.sh"
# The buyer only pays a 0.1 NEAR premium plus gas per policy; the capital that
# backs a payout belongs to the LP account, so 1 NEAR is the real floor here.
check_account "${BUYER_ACCOUNT:-correlation-buyer.testnet}" 1000000000000000000000000 "send testnet NEAR to the buyer account"

# Is the contract actually deployed, and does it answer?
if [[ -n "${CONTRACT_ID:-}" ]]; then
  # A JSON-RPC error still comes back as HTTP 200, so look for a result.
  body=$(curl -sS --max-time 10 -X POST "$RPC" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"c\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT_ID\",\"method_name\":\"get_policy\",\"args_base64\":\"eyJwb2xpY3lfaWQiOjF9\"}}")
  if [[ "$body" == *'"result"'* ]]; then
    ok "contract answers get_policy"
  else
    warn "contract not answering get_policy yet — deploy and seed it"
  fi
fi

if [[ -n "${NEARAI_API_KEY:-}" ]]; then
  echo
  if [[ "$DEEP" -eq 1 ]]; then
    echo "model gateway (one real completion, spends one token)"
    body="{\"model\":\"${NEARAI_MODEL:-z-ai/glm-5.3-flash}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}"
  else
    # An empty body fails validation *after* authentication, so this proves the
    # key without spending a token. 400 means the key is good.
    echo "model gateway (free: auth only, no tokens)"
    body='{}'
  fi
  code=$(curl -sS --max-time 30 -o /tmp/preflight-model.json -w '%{http_code}' \
    -X POST "${NEARAI_BASE_URL%/}/chat/completions" \
    -H "authorization: Bearer $NEARAI_API_KEY" \
    -H 'content-type: application/json' -H 'accept-encoding: identity' \
    -d "$body")
  case "$code" in
    200) ok "key accepted, inference works" ;;
    400|422)
      if [[ "$DEEP" -eq 1 ]]; then
        bad "completion rejected ($code)" "$(head -c 200 /tmp/preflight-model.json)"
      else
        ok "key accepted (rejected the empty probe body, as expected)"
      fi ;;
    401|403) bad "key rejected ($code) — invalid or expired" "create a fresh key at cloud.near.ai and paste it again" ;;
    402|429) bad "key valid but credits unavailable ($code)" "wait for the credits to land; retry later" ;;
    *) warn "unexpected $code from the model endpoint: $(head -c 200 /tmp/preflight-model.json)" ;;
  esac
  rm -f /tmp/preflight-model.json
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "ready — run ./scripts/go.sh"
else
  echo "$FAIL item(s) need attention"
fi
exit $(( FAIL > 0 ))
