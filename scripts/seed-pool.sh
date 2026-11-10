#!/usr/bin/env bash
# Seed the on-chain demo state: pinned signer, pool capital, swarm, policy.
#
# The work lives in api/scripts/seed.ts because there is no near-cli here and
# because the amounts have to be derived from the LP balance rather than written
# down: a testnet faucet gives 10 NEAR, so "deposit 100 NEAR" cannot run.
set -euo pipefail

cd "$(dirname "$0")/.."
exec npm run seed --workspace @correlation/api "$@"
