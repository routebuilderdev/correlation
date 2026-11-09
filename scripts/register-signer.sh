#!/usr/bin/env bash
# Register the model signer. The contract refuses receipts from any other key,
# so this is the trust anchor the whole demo rests on.
set -euo pipefail

: "${CONTRACT_ID:=correlation.testnet}"
: "${MODEL_ID:=z-ai/glm-5.3-flash}"
: "${PUBLIC_KEY:?set PUBLIC_KEY to the signer's uncompressed key, no 0x04}"

near call "$CONTRACT_ID" register_signer "{
  \"public_key\": \"$PUBLIC_KEY\",
  \"model_name\": \"$MODEL_ID\",
  \"compose_hash\": \"${COMPOSE_HASH:-$(printf '0%.0s' {1..64})}\",
  \"os_image_hash\": \"${OS_IMAGE_HASH:-$(printf '0%.0s' {1..64})}\",
  \"policy_hash\": \"${POLICY_HASH:-$(printf '0%.0s' {1..64})}\",
  \"verified_at_ns\": 0,
  \"expires_at_ns\": 18446744073709551615
}" --accountId "$CONTRACT_ID" --networkId testnet
