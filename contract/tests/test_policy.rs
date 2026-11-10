use std::panic::{catch_unwind, AssertUnwindSafe};

use correlation::types::*;
use correlation::verify::sha256_hex;
use correlation::Contract;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MODEL: &str = "z-ai/glm-5.3-flash";

fn signer() -> String {
    let value: serde_json::Value = serde_json::from_str(include_str!("fixtures/signer.json")).unwrap();
    value["public_key"].as_str().unwrap().to_string()
}

fn ctx(who: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.predecessor_account_id(who.parse().unwrap());
    builder.block_timestamp(1_700_000_000_000_000_000);
    builder
}

fn with_deposit(who: &str, yocto: u128) -> VMContextBuilder {
    let mut builder = ctx(who);
    builder.attached_deposit(NearToken::from_yoctonear(yocto));
    builder
}

fn setup() -> Contract {
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
    contract
}

fn fingerprint() -> SwarmFingerprint {
    SwarmFingerprint {
        model_id: MODEL.to_string(),
        prompt_hash: "09".repeat(32),
        agent_ids: (1..=20).map(|i| format!("agent-{i:02}")).collect(),
    }
}

fn terms(limit: u128, premium: u128) -> PolicyTerms {
    let terms_json = format!(
        "{{\"limit\":\"{limit}\",\"premium\":\"{premium}\",\"trigger_bps\":2500,\
         \"window_start_ns\":1700000000000000000,\"window_end_ns\":1700003600000000000,\
         \"min_agents\":20,\"min_receipts\":16,\"model_id\":\"{MODEL}\",\
         \"signer_pubkey\":\"{}\"}}",
        signer()
    );
    let terms_hash = sha256_hex(terms_json.as_bytes());
    PolicyTerms {
        terms_json,
        terms_hash,
    }
}

fn funded_and_registered() -> Contract {
    let mut contract = setup();
    testing_env!(with_deposit("lp.testnet", 100 * ONE_NEAR).build());
    contract.deposit(1);
    testing_env!(ctx("buyer.testnet").build());
    contract.register_swarm("swarm-1".to_string(), fingerprint());
    contract
}

#[test]
fn buy_mints_nft_and_commits_coverage() {
    let mut contract = funded_and_registered();

    testing_env!(with_deposit("buyer.testnet", ONE_NEAR).build());
    let token_id = contract.buy_policy("swarm-1".to_string(), terms(10 * ONE_NEAR, ONE_NEAR));
    assert_eq!(token_id, "p-001");

    let policy = contract.get_policy(1).expect("policy must exist");
    assert_eq!(policy.status, PolicyStatus::Active);
    assert_eq!(policy.limit.0, 10 * ONE_NEAR);
    assert_eq!(policy.premium.0, ONE_NEAR);
    assert_eq!(policy.model_id, MODEL);
    assert_eq!(policy.signer_pubkey, signer());
    assert_eq!(policy.started, 0);

    let token = contract.nft_token(token_id.clone()).expect("token minted");
    assert_eq!(token.owner_id.as_str(), "buyer.testnet");
    assert_eq!(token.policy_id, 1);
    assert!(!token.frozen);

    let pool = contract.get_pool(1).expect("pool exists");
    assert_eq!(pool.total.0, 101 * ONE_NEAR, "premium is LP income");
    assert_eq!(pool.committed.0, 10 * ONE_NEAR);
    assert_eq!(pool.available.0, 91 * ONE_NEAR);
    assert_eq!(pool.active_policies, 1);
}

/// T2 — the premium is not negotiable.
#[test]
fn t2_rejects_wrong_premium() {
    let mut contract = funded_and_registered();
    testing_env!(with_deposit("buyer.testnet", ONE_NEAR / 2).build());
    let refused = catch_unwind(AssertUnwindSafe(|| {
        contract.buy_policy("swarm-1".to_string(), terms(10 * ONE_NEAR, ONE_NEAR))
    }));
    assert!(refused.is_err(), "underpaying must panic");
    assert!(contract.get_policy(1).is_none());
}

#[test]
fn rejects_terms_that_do_not_match_their_hash() {
    let mut contract = funded_and_registered();
    let mut policy_terms = terms(10 * ONE_NEAR, ONE_NEAR);
    policy_terms.terms_json = policy_terms
        .terms_json
        .replace("\"trigger_bps\":2500", "\"trigger_bps\":100");
    testing_env!(with_deposit("buyer.testnet", ONE_NEAR).build());
    let refused = catch_unwind(AssertUnwindSafe(|| {
        contract.buy_policy("swarm-1".to_string(), policy_terms)
    }));
    assert!(refused.is_err(), "edited terms must not buy coverage");
}

#[test]
fn rejects_unregistered_signer() {
    let mut contract = setup();
    testing_env!(with_deposit("lp.testnet", 100 * ONE_NEAR).build());
    contract.deposit(1);
    testing_env!(ctx("buyer.testnet").build());
    contract.register_swarm("swarm-1".to_string(), fingerprint());

    let mut policy_terms = terms(10 * ONE_NEAR, ONE_NEAR);
    policy_terms.terms_json = policy_terms
        .terms_json
        .replace(&signer(), &"11".repeat(64));
    policy_terms.terms_hash = sha256_hex(policy_terms.terms_json.as_bytes());

    testing_env!(with_deposit("buyer.testnet", ONE_NEAR).build());
    let refused = catch_unwind(AssertUnwindSafe(|| {
        contract.buy_policy("swarm-1".to_string(), policy_terms)
    }));
    assert!(refused.is_err(), "signer must be registered first");
}

/// T13 — capital cannot leave while it backs a live policy.
#[test]
fn t13_withdraw_locked_while_policy_active() {
    let mut contract = funded_and_registered();
    testing_env!(with_deposit("buyer.testnet", ONE_NEAR).build());
    contract.buy_policy("swarm-1".to_string(), terms(10 * ONE_NEAR, ONE_NEAR));

    testing_env!(ctx("lp.testnet").build());
    let refused = catch_unwind(AssertUnwindSafe(|| contract.withdraw(1, ONE_NEAR)));
    assert!(refused.is_err(), "withdrawal must be locked");
    assert_eq!(contract.get_pool(1).unwrap().total.0, 101 * ONE_NEAR);
}

#[test]
fn deposit_then_withdraw_when_idle() {
    let mut contract = setup();
    testing_env!(with_deposit("lp.testnet", 50 * ONE_NEAR).build());
    contract.deposit(1);
    testing_env!(ctx("lp.testnet").build());
    contract.withdraw(1, 20 * ONE_NEAR);
    let pool = contract.get_pool(1).unwrap();
    assert_eq!(pool.total.0, 30 * ONE_NEAR);
    assert_eq!(pool.available.0, 30 * ONE_NEAR);
}
