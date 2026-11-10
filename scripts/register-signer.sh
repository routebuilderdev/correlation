#!/usr/bin/env bash
# Register the model signer. The contract refuses receipts from any other key,
# so this is the trust anchor the whole demo rests on.
#
# It is part of `seed` now: the key is read from contract/tests/fixtures/signer.json,
# which is the key that actually signed the captured receipt.
set -euo pipefail

cd "$(dirname "$0")/.."
exec npm run seed --workspace @correlation/api "$@"
