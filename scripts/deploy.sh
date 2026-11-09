#!/usr/bin/env bash
# Build the wasm and deploy it. Requires near-cli (`near`) and a funded account.
set -euo pipefail

cd "$(dirname "$0")/../contract"
CONTRACT_ID="${CONTRACT_ID:-correlation.testnet}"

rustup target add --toolchain 1.99 wasm32-unknown-unknown >/dev/null
cargo build --release --target wasm32-unknown-unknown

near contract deploy "$CONTRACT_ID" \
  use-file target/wasm32-unknown-unknown/release/correlation.wasm \
  with-init-call new \
  json-args "{\"owner_id\":\"$CONTRACT_ID\"}" \
  prepaid-gas '100 Tgas' \
  attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-keychain send

echo "deployed $CONTRACT_ID"
