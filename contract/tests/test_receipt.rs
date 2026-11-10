use std::panic::{catch_unwind, AssertUnwindSafe};

use correlation::types::*;
use correlation::verify::sha256_hex;
use correlation::Contract;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MODEL: &str = "z-ai/glm-5.3-flash";
const WINDOW_START: u64 = 1_700_000_000_000_000_000;
const WINDOW_END: u64 = 1_700_003_600_000_000_000;
const NOW: u64 = 1_700_000_100_000_000_000;

const REQUEST: &[u8] = include_bytes!("fixtures/request.bin");
const RESPONSE: &[u8] = include_bytes!("fixtures/response.bin");
const SIGNATURE: &str = include_str!("fixtures/signature.json");

fn ctx(who: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.predecessor_account_id(who.parse().unwrap());
    builder.block_timestamp(NOW);
    builder
}

fn with_deposit(who: &str, yocto: u128) -> VMContextBuilder {
    let mut builder = ctx(who);
    builder.attached_deposit(NearToken::from_yoctonear(yocto));
    builder
}

fn signer() -> String {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/signer.json")).unwrap();
    value["public_key"].as_str().unwrap().to_string()
}

fn terms() -> PolicyTerms {
    let terms_json = format!(
        "{{\"limit\":\"{}\",\"premium\":\"{}\",\"trigger_bps\":2500,\
         \"window_start_ns\":{WINDOW_START},\"window_end_ns\":{WINDOW_END},\
         \"min_agents\":20,\"min_receipts\":16,\"model_id\":\"{MODEL}\",\
         \"signer_pubkey\":\"{}\"}}",
        10 * ONE_NEAR,
        ONE_NEAR,
        signer()
    );
    terms_hash_for(terms_json)
}

fn terms_hash_for(terms_json: String) -> PolicyTerms {
    let terms_hash = sha256_hex(terms_json.as_bytes());
    PolicyTerms {
        terms_json,
        terms_hash,
    }
}

fn funded_policy() -> Contract {
    testing_env!(ctx("owner.testnet").build());
    let mut contract = Contract::new("owner.testnet".parse().unwrap());
    contract.register_signer(RegisterSignerArgs {
        public_key: signer(),
        model_name: MODEL.to_string(),
        compose_hash: "aa".repeat(32),
        os_image_hash: "bb".repeat(32),
        policy_hash: "cc".repeat(32),
        verified_at_ns: 0,
        expires_at_ns: u64::MAX,
    });

    testing_env!(with_deposit("lp.testnet", 100 * ONE_NEAR).build());
    contract.deposit(1);

    testing_env!(ctx("buyer.testnet").build());
    contract.register_swarm(
        "swarm-1".to_string(),
        SwarmFingerprint {
            model_id: MODEL.to_string(),
            prompt_hash: "09".repeat(32),
            agent_ids: (1..=20).map(|i| format!("agent-{i:02}")).collect(),
        },
    );
    contract
}

fn policy_with_receipt_window() -> Contract {
    let mut contract = funded_policy();
    testing_env!(with_deposit("buyer.testnet", ONE_NEAR).build());
    contract.buy_policy("swarm-1".to_string(), terms());
    contract
}

fn panic_message(result: std::thread::Result<()>) -> String {
    match result {
        Ok(()) => panic!("expected the call to fail"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "<non-string panic>".to_string()),
    }
}

/// The fixture is signed for policy 1, agent index 2 ("agent-03"), n = 10_000_022.
#[test]
fn accepts_a_signed_correct_answer() {
    let mut contract = policy_with_receipt_window();
    testing_env!(ctx("eval.testnet").build());
    contract.post_receipt(
        1,
        "agent-03".to_string(),
        REQUEST.to_vec(),
        RESPONSE.to_vec(),
        SIGNATURE.to_string(),
    );

    let receipt = contract
        .get_receipt(1, "agent-03".to_string())
        .expect("receipt stored");
    assert!(receipt.ok, "n * 37 mod 1000003 is correct in the fixture");
    assert_eq!(receipt.signer, signer());

    let index = contract.get_index(1).unwrap();
    assert_eq!(index.started, 1);
    assert_eq!(index.failed, 0);
    assert_eq!(index.index_bps, 0);
}

/// T6 — the same receipt cannot be counted twice.
#[test]
fn t6_duplicate_receipt_rejected() {
    let mut contract = policy_with_receipt_window();
    testing_env!(ctx("eval.testnet").build());
    contract.post_receipt(
        1,
        "agent-03".to_string(),
        REQUEST.to_vec(),
        RESPONSE.to_vec(),
        SIGNATURE.to_string(),
    );
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-03".to_string(),
            REQUEST.to_vec(),
            RESPONSE.to_vec(),
            SIGNATURE.to_string(),
        )
    })));
    assert!(message.contains("E05"), "got {message}");
    assert_eq!(contract.get_index(1).unwrap().started, 1);
}

/// T7 — an agent that is not in the swarm cannot post.
#[test]
fn t7_unknown_agent_rejected() {
    let mut contract = policy_with_receipt_window();
    testing_env!(ctx("eval.testnet").build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-99".to_string(),
            REQUEST.to_vec(),
            RESPONSE.to_vec(),
            SIGNATURE.to_string(),
        )
    })));
    assert!(message.contains("E04"), "got {message}");
}

/// T4 — tampering with the response breaks the signed text.
#[test]
fn t4_tampered_response_rejected() {
    let mut contract = policy_with_receipt_window();
    let mut tampered = RESPONSE.to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    testing_env!(ctx("eval.testnet").build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-03".to_string(),
            REQUEST.to_vec(),
            tampered,
            SIGNATURE.to_string(),
        )
    })));
    assert!(message.contains("E10"), "got {message}");
    assert_eq!(contract.get_index(1).unwrap().started, 0);
}

/// T5 — a gateway signature does not prove model execution.
#[test]
fn t5_gateway_signature_rejected() {
    let mut contract = policy_with_receipt_window();
    let mut record: serde_json::Value = serde_json::from_str(SIGNATURE).unwrap();
    record["signature_kind"] = serde_json::Value::String("gateway".to_string());
    testing_env!(ctx("eval.testnet").build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-03".to_string(),
            REQUEST.to_vec(),
            RESPONSE.to_vec(),
            record.to_string(),
        )
    })));
    assert!(message.contains("E07"), "got {message}");
}

#[test]
fn expired_policies_accept_no_more_receipts() {
    let mut contract = policy_with_receipt_window();
    let mut context = ctx("anyone.testnet");
    context.block_timestamp(WINDOW_END + 10 * 60 * 1_000_000_000);
    testing_env!(context.build());
    contract.expire(1);

    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-03".to_string(),
            REQUEST.to_vec(),
            RESPONSE.to_vec(),
            SIGNATURE.to_string(),
        )
    })));
    assert!(message.contains("E02"), "got {message}");
}

#[test]
fn rejects_receipts_outside_the_window() {
    let mut contract = policy_with_receipt_window();
    let mut context = ctx("eval.testnet");
    context.block_timestamp(WINDOW_END + 6 * 60 * 1_000_000_000);
    testing_env!(context.build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| {
        contract.post_receipt(
            1,
            "agent-03".to_string(),
            REQUEST.to_vec(),
            RESPONSE.to_vec(),
            SIGNATURE.to_string(),
        )
    })));
    assert!(message.contains("E03"), "got {message}");
}
