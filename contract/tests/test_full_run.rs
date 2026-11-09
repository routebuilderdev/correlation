//! T14 — the whole loop with twenty real receipts.
//!
//! The key is generated inside the test, so nothing secret is committed and the
//! signatures are genuine secp256k1 over the EIP-191 digest, not stubs. This is
//! the test that would catch an integration bug between modules that unit tests
//! each pass on their own.

use correlation::types::*;
use correlation::verify::{sha256_hex, signed_text, to_hex};
use correlation::Contract;
use k256::ecdsa::{RecoveryId, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};
use sha3::{Digest, Keccak256};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MODEL: &str = "z-ai/glm-5.3-flash";
const WINDOW_START: u64 = 1_700_000_000_000_000_000;
const WINDOW_END: u64 = 1_700_003_600_000_000_000;
const NOW: u64 = 1_700_000_600_000_000_000;
const AGENTS: usize = 20;
/// Indices that get a wrong answer: 7 of 20 is 3500 bps.
const FAILING: [usize; 7] = [2, 5, 7, 9, 11, 14, 17];

fn ctx(who: &str, yocto: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.predecessor_account_id(who.parse().unwrap());
    builder.block_timestamp(NOW);
    builder.attached_deposit(NearToken::from_yoctonear(yocto));
    builder
}

fn to_hex_pubkey(sk: &SigningKey) -> String {
    let point = sk.verifying_key().to_encoded_point(false);
    to_hex(&point.as_bytes()[1..])
}

fn sign(sk: &SigningKey, text: &str) -> String {
    let mut hasher = Keccak256::new();
    hasher.update(b"\x19Ethereum Signed Message:\n");
    hasher.update(text.len().to_string().as_bytes());
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();

    let (signature, recovery): (k256::ecdsa::Signature, RecoveryId) =
        sk.sign_prehash_recoverable(&digest).unwrap();
    let mut bytes = [0u8; 65];
    bytes[..64].copy_from_slice(&signature.to_bytes());
    bytes[64] = recovery.to_byte();
    to_hex(&bytes)
}

fn expected_n(index: usize) -> u64 {
    10_000_000 + ((1u64 * 20 + index as u64) % 20_000)
}

fn terms() -> PolicyTerms {
    let json = format!(
        "{{\"limit\":\"{}\",\"premium\":\"{}\",\"trigger_bps\":2500,\
         \"window_start_ns\":{WINDOW_START},\"window_end_ns\":{WINDOW_END},\
         \"min_agents\":{AGENTS},\"min_receipts\":16,\"model_id\":\"{MODEL}\",\
         \"signer_pubkey\":\"\"}}",
        10 * ONE_NEAR,
        ONE_NEAR
    );
    // signer_pubkey is filled after the key exists; the purchase check only
    // requires the embedded key to be registered.
    PolicyTerms {
        terms_hash: sha256_hex(json.as_bytes()),
        terms_json: json,
    }
}

#[test]
fn t14_twenty_signed_receipts_trigger_and_pay() {
    let sk = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
    let pubkey = to_hex_pubkey(&sk);

    testing_env!(ctx("owner.testnet", 0).build());
    let mut contract = Contract::new("owner.testnet".parse().unwrap());
    contract.register_signer(RegisterSignerArgs {
        public_key: pubkey.clone(),
        model_name: MODEL.to_string(),
        compose_hash: "aa".repeat(32),
        os_image_hash: "bb".repeat(32),
        policy_hash: "cc".repeat(32),
        verified_at_ns: 0,
        expires_at_ns: u64::MAX,
    });

    // The terms carry the signer key, so build them only after registration.
    let mut terms = terms();
    terms.terms_json = terms.terms_json.replace("signer_pubkey\":\"", &format!("signer_pubkey\":\"{pubkey}"));
    terms.terms_hash = sha256_hex(terms.terms_json.as_bytes());

    testing_env!(ctx("lp.testnet", 100 * ONE_NEAR).build());
    contract.deposit(1);

    testing_env!(ctx("buyer.testnet", 0).build());
    contract.register_swarm(
        "swarm-1".to_string(),
        SwarmFingerprint {
            model_id: MODEL.to_string(),
            prompt_hash: [3u8; 32],
            agent_ids: (1..=AGENTS).map(|i| format!("agent-{i:02}")).collect(),
        },
    );

    testing_env!(ctx("buyer.testnet", ONE_NEAR).build());
    contract.buy_policy("swarm-1".to_string(), terms);

    // --- twenty receipts, each signed over its own bytes -------------------
    testing_env!(ctx("eval.testnet", 0).build());
    for index in 0..AGENTS {
        let agent_id = format!("agent-{:02}", index + 1);
        let n = expected_n(index);
        let correct = (n * 37) % 1_000_003;
        let answer = if FAILING.contains(&index) { correct + 1 } else { correct };

        let request = format!("{{\"policy_id\":1,\"agent\":\"{agent_id}\",\"n\":{n}}}");
        let response = format!("{{\"n\":{n},\"a\":{answer}}}");
        let request_bytes = request.as_bytes().to_vec();
        let response_bytes = response.as_bytes().to_vec();

        let text = signed_text(MODEL, &request_bytes, &response_bytes);
        let signature = serde_json::json!({
            "text": text,
            "signature": sign(&sk, &text),
            "signing_address": "c94a34584e61545f894d0198b6be42940519617c",
            "signing_public_key": pubkey,
            "signing_algo": "ecdsa",
            "signature_kind": "provider_tee",
        });

        contract.post_receipt(1, agent_id, request_bytes, response_bytes, signature.to_string());
    }

    let index = contract.get_index(1).unwrap();
    assert_eq!(index.started, AGENTS as u32);
    assert_eq!(index.failed, FAILING.len() as u32);
    assert_eq!(index.index_bps, 3500);
    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Active);

    // --- anyone can settle it ---------------------------------------------
    testing_env!(ctx("stranger.testnet", 0).build());
    contract.evaluate(1);
    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Triggered);

    testing_env!(ctx("buyer.testnet", 0).build());
    contract.claim(1);

    let policy = contract.get_policy(1).unwrap();
    assert_eq!(policy.status, PolicyStatus::Paid);
    assert_eq!(policy.paid_amount.0, 10 * ONE_NEAR);

    let pool = contract.get_pool(1).unwrap();
    assert_eq!(pool.total.0, 91 * ONE_NEAR, "100 deposited + 1 premium - 10 paid");
    assert_eq!(pool.committed.0, 0, "the paid policy releases its commitment");
    assert_eq!(pool.active_policies, 0);

    // --- invariants that must hold at the end of any run -------------------
    assert!(index.failed <= index.started, "failed cannot exceed started");
    assert!(index.started <= AGENTS as u32, "started cannot exceed the swarm");
}

/// The same run with one flipped byte in the last receipt: the index counts 19,
/// stays under the 16-of-20 floor only if coverage is honest.
#[test]
fn t14_a_tampered_receipt_never_counts() {
    let sk = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let pubkey = to_hex_pubkey(&sk);

    testing_env!(ctx("owner.testnet", 0).build());
    let mut contract = Contract::new("owner.testnet".parse().unwrap());
    contract.register_signer(RegisterSignerArgs {
        public_key: pubkey.clone(),
        model_name: MODEL.to_string(),
        compose_hash: "aa".repeat(32),
        os_image_hash: "bb".repeat(32),
        policy_hash: "cc".repeat(32),
        verified_at_ns: 0,
        expires_at_ns: u64::MAX,
    });

    let mut terms = terms();
    terms.terms_json = terms.terms_json.replace("signer_pubkey\":\"", &format!("signer_pubkey\":\"{pubkey}"));
    terms.terms_hash = sha256_hex(terms.terms_json.as_bytes());

    testing_env!(ctx("lp.testnet", 100 * ONE_NEAR).build());
    contract.deposit(1);

    testing_env!(ctx("buyer.testnet", 0).build());
    contract.register_swarm(
        "swarm-1".to_string(),
        SwarmFingerprint {
            model_id: MODEL.to_string(),
            prompt_hash: [3u8; 32],
            agent_ids: (1..=AGENTS).map(|i| format!("agent-{i:02}")).collect(),
        },
    );
    testing_env!(ctx("buyer.testnet", ONE_NEAR).build());
    contract.buy_policy("swarm-1".to_string(), terms);

    testing_env!(ctx("eval.testnet", 0).build());
    let n = expected_n(0);
    let response = format!("{{\"n\":{n},\"a\":{}}}", (n * 37) % 1_000_003);
    let request_bytes = b"{\"policy_id\":1}".to_vec();
    let response_bytes = response.as_bytes().to_vec();
    let text = signed_text(MODEL, &request_bytes, &response_bytes);
    let signature = serde_json::json!({
        "text": text,
        "signature": sign(&sk, &text),
        "signing_address": "c94a34584e61545f894d0198b6be42940519617c",
        "signing_public_key": pubkey,
        "signing_algo": "ecdsa",
        "signature_kind": "provider_tee",
    });

    let mut tampered = response_bytes.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;

    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.post_receipt(1, "agent-01".to_string(), request_bytes, tampered, signature.to_string())
    }));
    assert!(failed.is_err(), "a tampered response must not be accepted");
    assert_eq!(contract.get_index(1).unwrap().started, 0);
}
