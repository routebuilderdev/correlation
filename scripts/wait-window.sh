#!/usr/bin/env bash
# Block until a policy's receipt window has opened.
#
#   ./scripts/wait-window.sh 6
#
# A policy is Active the moment it is bought, and the page enables Run straight
# away, but the contract rejects receipts posted before window_start_ns with E03.
# The lead is 60s (api/scripts/seed.ts), so anything filmed immediately after a
# seed records twenty rejections.
set -euo pipefail

: "${API:=http://127.0.0.1:8787}"
POLICY="${1:?usage: wait-window.sh <policy-id>}"

python3 - "$API" "$POLICY" <<'PY'
import json, sys, time, urllib.request

api, policy = sys.argv[1], sys.argv[2]
deadline = time.time() + 900
while True:
    try:
        with urllib.request.urlopen(f"{api}/api/policy/{policy}", timeout=10) as response:
            start = json.load(response)["policy"]["window_start_ns"] / 1e9
    except Exception as exc:  # a fresh policy is not readable for a second or two
        print(f"\rpolicy {policy} not readable yet ({exc}) ", end="", flush=True)
    else:
        left = start - time.time()
        if left <= 0:
            print(f"window open on policy {policy}")
            raise SystemExit(0)
        print(f"\rwindow opens in {left:4.0f}s ", end="", flush=True)

    if time.time() > deadline:
        print(f"\nwindow never opened for policy {policy}")
        raise SystemExit(1)
    time.sleep(1)
PY
