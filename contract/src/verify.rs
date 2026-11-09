//! The verification path. This module is the whole trust argument (D5, D7):
//! the contract rebuilds the signed text from raw bytes and recovers the signer.
//!
//! Two different hash functions live here and must not be confused:
//! - the *inner* request/response hashes are sha256;
//! - the *outer* EIP-191 digest is keccak256 (§6.11 trap 1).

use crate::errors::ContractError;
use crate::types::SignatureRecord;
use near_sdk::env;

pub const EIP191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";

#[derive(Debug)]
pub struct VerifiedReceipt {
    pub record: SignatureRecord,
    pub digest: [u8; 32],
    pub recovered: [u8; 64],
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Lowercase hex out, `0x`-tolerant in. Rejects odd length and non-hex.
pub fn from_hex(input: &str) -> Result<Vec<u8>, ContractError> {
    let s = input.strip_prefix("0x").unwrap_or(input);
    let bytes = s.as_bytes();
    if bytes.len() % 2 != 0 {
        return Err(ContractError::BadSignatureJson);
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = nibble(bytes[i]).ok_or(ContractError::BadSignatureJson)?;
        let lo = nibble(bytes[i + 1]).ok_or(ContractError::BadSignatureJson)?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

/// Lowercase hex, no `0x` — matches the server's text format (§Appendix B).
pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&env::sha256(bytes))
}

pub fn signed_text(model_id: &str, request_bytes: &[u8], response_bytes: &[u8]) -> String {
    format!(
        "{}:{}:{}",
        model_id,
        sha256_hex(request_bytes),
        sha256_hex(response_bytes)
    )
}

/// `keccak256("\x19Ethereum Signed Message:\n" || decimalLen || text)`.
/// The length is the UTF-8 byte length written in decimal ASCII, not padded.
pub fn eip191_digest(text: &str) -> [u8; 32] {
    let body = text.as_bytes();
    let len = body.len().to_string();
    let mut message = Vec::with_capacity(EIP191_PREFIX.len() + len.len() + body.len());
    message.extend_from_slice(EIP191_PREFIX);
    message.extend_from_slice(len.as_bytes());
    message.extend_from_slice(body);
    let digest = env::keccak256(&message);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// `v` arrives as 27/28 and NEAR wants a recovery id. Try both malleability flags
/// so one unknown constant cannot reject a valid signature (§6.11 trap 3).
pub fn recover(digest: &[u8; 32], signature: &[u8; 65]) -> Option<[u8; 64]> {
    let r_s: [u8; 64] = signature[..64].try_into().ok()?;
    let raw_v = signature[64];
    let v = if raw_v >= 27 { raw_v - 27 } else { raw_v };
    if v > 1 {
        return None;
    }
    // Returns the 64-byte key directly; both flags are tried because the
    // malleability convention is settled empirically (§6.11 trap 3).
    env::ecrecover(digest, &r_s, v, false).or_else(|| env::ecrecover(digest, &r_s, v, true))
}

/// The full check, in the order of §6.5 steps 7–16. Cheapest failures first.
pub fn verify_receipt(
    model_id: &str,
    expected_signer: &[u8; 64],
    request_bytes: &[u8],
    response_bytes: &[u8],
    signature_json: &str,
) -> Result<VerifiedReceipt, ContractError> {
    let record: SignatureRecord =
        serde_json::from_str(signature_json).map_err(|_| ContractError::BadSignatureJson)?;

    // Absent means a direct model signature; the gateway says "gateway" out loud.
    if let Some(kind) = record.signature_kind.as_deref() {
        if kind != "provider_tee" {
            return Err(ContractError::GatewaySignature);
        }
    }
    if record.signing_algo != "ecdsa" {
        return Err(ContractError::UnsupportedAlgo);
    }
    // The model ID is inside the signed text; aliasing would change it (§3.2.1).
    let text_model = record.text.splitn(3, ':').next().unwrap_or_default();
    if text_model != model_id {
        return Err(ContractError::WrongModel);
    }
    if record.model.as_deref().is_some_and(|m| m != model_id) {
        return Err(ContractError::WrongModel);
    }

    let expected_text = signed_text(model_id, request_bytes, response_bytes);
    if record.text != expected_text {
        return Err(ContractError::TextMismatch(expected_text));
    }

    let signature_bytes = from_hex(&record.signature)?;
    let signature: [u8; 65] = signature_bytes
        .as_slice()
        .try_into()
        .map_err(|_| ContractError::BadSignatureJson)?;

    let digest = eip191_digest(&expected_text);
    let recovered = recover(&digest, &signature).ok_or(ContractError::UnknownSigner)?;
    if &recovered != expected_signer {
        return Err(ContractError::UnknownSigner);
    }

    Ok(VerifiedReceipt {
        record,
        digest,
        recovered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const REQUEST: &[u8] = include_bytes!("../tests/fixtures/request.bin");
    const RESPONSE: &[u8] = include_bytes!("../tests/fixtures/response.bin");
    const SIGNATURE_JSON: &str = include_str!("../tests/fixtures/signature.json");
    const SIGNER_JSON: &str = include_str!("../tests/fixtures/signer.json");

    fn setup() {
        testing_env!(VMContextBuilder::new().build());
    }

    fn fixture_signer() -> [u8; 64] {
        let value: serde_json::Value = serde_json::from_str(SIGNER_JSON).unwrap();
        let hex = value["public_key"].as_str().unwrap();
        from_hex(hex).unwrap().as_slice().try_into().unwrap()
    }

    fn record() -> SignatureRecord {
        serde_json::from_str(SIGNATURE_JSON).unwrap()
    }

    /// Known-answer vector for the EIP-191 digest, computed independently with ethers.
    #[test]
    fn eip191_digest_matches_ethers() {
        setup();
        assert_eq!(
            to_hex(&eip191_digest("hello")),
            "50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750"
        );
    }

    #[test]
    fn signed_text_matches_fixture() {
        setup();
        let rec = record();
        assert_eq!(
            signed_text("z-ai/glm-5.3-flash", REQUEST, RESPONSE),
            rec.text
        );
    }

    /// T3 — the gate. A real secp256k1 signature over the canonical text recovers
    /// to the expected 64-byte key.
    #[test]
    fn t3_real_signature_verifies() {
        setup();
        let signer = fixture_signer();
        let verified =
            verify_receipt("z-ai/glm-5.3-flash", &signer, REQUEST, RESPONSE, SIGNATURE_JSON)
                .expect("fixture signature must verify");
        assert_eq!(verified.recovered, signer);
    }

    /// T4 — a single tampered byte breaks the text and must be rejected.
    #[test]
    fn t4_tampered_response_rejected() {
        setup();
        let signer = fixture_signer();
        let mut tampered = RESPONSE.to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let err = verify_receipt(
            "z-ai/glm-5.3-flash",
            &signer,
            REQUEST,
            &tampered,
            SIGNATURE_JSON,
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::TextMismatch(_)), "got {err}");
    }

    /// T5 — a gateway signature does not prove model execution.
    #[test]
    fn t5_gateway_signature_rejected() {
        setup();
        let signer = fixture_signer();
        let mut rec = record();
        rec.signature_kind = Some("gateway".to_string());
        let err = verify_receipt(
            "z-ai/glm-5.3-flash",
            &signer,
            REQUEST,
            RESPONSE,
            &serde_json::to_string(&rec).unwrap(),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::GatewaySignature);
    }

    /// T8 — a receipt signed for another model must not be accepted.
    #[test]
    fn t8_wrong_model_rejected() {
        setup();
        let signer = fixture_signer();
        let err = verify_receipt(
            "Qwen/Qwen3.8-27B",
            &signer,
            REQUEST,
            RESPONSE,
            SIGNATURE_JSON,
        )
        .unwrap_err();
        assert_eq!(err, ContractError::WrongModel);
    }

    #[test]
    fn unknown_signer_rejected() {
        setup();
        let mut other = fixture_signer();
        other[0] ^= 0xff;
        let err =
            verify_receipt("z-ai/glm-5.3-flash", &other, REQUEST, RESPONSE, SIGNATURE_JSON)
                .unwrap_err();
        assert_eq!(err, ContractError::UnknownSigner);
    }

    #[test]
    fn unsupported_algo_rejected() {
        setup();
        let signer = fixture_signer();
        let mut rec = record();
        rec.signing_algo = "ed25519".to_string();
        let err = verify_receipt(
            "z-ai/glm-5.3-flash",
            &signer,
            REQUEST,
            RESPONSE,
            &serde_json::to_string(&rec).unwrap(),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::UnsupportedAlgo);
    }

    #[test]
    fn malformed_signature_json_rejected() {
        setup();
        let signer = fixture_signer();
        let err = verify_receipt(
            "z-ai/glm-5.3-flash",
            &signer,
            REQUEST,
            RESPONSE,
            "{not json",
        )
        .unwrap_err();
        assert_eq!(err, ContractError::BadSignatureJson);
    }
}
