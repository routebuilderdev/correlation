use std::panic::{catch_unwind, AssertUnwindSafe};

use correlation::types::*;
use correlation::Contract;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MODEL: &str = "z-ai/glm-5.3-flash";

const NOW: u64 = 1_700_000_100_000_000_000;
const WINDOW_END: u64 = 1_700_003_600_000_000_000;
const AFTER_EXPIRY: u64 = WINDOW_END + 10 * 60 * 1_000_000_000;

fn ctx_at(who: &str, timestamp: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.predecessor_account_id(who.parse().unwrap());
    builder.block_timestamp(timestamp);
    builder
}

fn ctx(who: &str) -> VMContextBuilder {
    ctx_at(who, NOW)
}

fn panic_message(result: std::thread::Result<()>) -> String {
    match result {
        Ok(()) => panic!("expected the call to fail"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    }
}

fn buyer() -> AccountId {
    "buyer.testnet".parse().unwrap()
}

fn policy(status: PolicyStatus) -> Policy {
    Policy {
        policy_id: 1,
        swarm_id: "swarm-1".to_string(),
        buyer: buyer(),
        terms_hash: [3u8; 32],
        limit: 10 * ONE_NEAR,
        premium: ONE_NEAR,
        trigger_bps: 2500,
        window_start_ns: 1_700_000_000_000_000_000,
        window_end_ns: WINDOW_END,
        min_agents: 20,
        min_receipts: 16,
        model_id: MODEL.to_string(),
        signer_pubkey: [7u8; 64],
        status,
        failed: 0,
        started: 0,
        paid_amount: 0,
        token_id: "p-001".to_string(),
    }
}

/// A contract with 100 NEAR of pool capital and one policy stored directly, so the
/// index can be exercised without generating twenty signatures.
fn contract_with(policy: Policy, pool_total: u128) -> Contract {
    testing_env!(ctx("owner.testnet").build());
    let mut contract = Contract::new("owner.testnet".parse().unwrap());
    contract.pools.insert(
        &1u64,
        &Pool {
            pool_id: 1,
            total: pool_total,
            committed: policy.limit,
        },
    );
    contract.active_policies = 1;
    contract.policies.insert(&1, &policy);
    contract
}

/// T9 — 7 of 20 is 3500 bps and crosses a 2500 bps threshold.
#[test]
fn t9_seven_of_twenty_triggers() {
    let mut case = policy(PolicyStatus::Active);
    case.failed = 7;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("anyone.testnet").build());
    contract.evaluate(1);

    let view = contract.get_policy(1).unwrap();
    assert_eq!(view.status, PolicyStatus::Triggered);
    let index = contract.get_index(1).unwrap();
    assert_eq!(index.index_bps, 3500);
    assert!(index.triggered);
}

/// T9 — 4 of 20 is 2000 bps and must not trigger.
#[test]
fn t9_four_of_twenty_does_not_trigger() {
    let mut case = policy(PolicyStatus::Active);
    case.failed = 4;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("anyone.testnet").build());
    contract.evaluate(1);

    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Active);
    assert_eq!(contract.get_index(1).unwrap().index_bps, 2000);
}

/// T10 — coverage is not satisfied while receipts are missing, even if the ratio is high.
#[test]
fn t10_min_receipts_blocks_early_trigger() {
    let mut case = policy(PolicyStatus::Active);
    case.failed = 7;
    case.started = 15;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("anyone.testnet").build());
    contract.evaluate(1);

    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Active);
}

#[test]
fn evaluate_is_idempotent() {
    let mut case = policy(PolicyStatus::Active);
    case.failed = 7;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("anyone.testnet").build());
    contract.evaluate(1);
    contract.evaluate(1);
    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Triggered);
}

/// T11 — a paid policy cannot be claimed twice.
#[test]
fn t11_claim_twice_fails() {
    let mut case = policy(PolicyStatus::Triggered);
    case.failed = 7;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("buyer.testnet").build());
    contract.claim(1);
    let view = contract.get_policy(1).unwrap();
    assert_eq!(view.status, PolicyStatus::Paid);
    assert_eq!(view.paid_amount.0, 10 * ONE_NEAR);

    let message = match catch_unwind(AssertUnwindSafe(|| contract.claim(1))) {
        Ok(()) => panic!("second claim must fail"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    };
    assert!(message.contains("E02"), "got {message}");
}

#[test]
fn only_the_buyer_can_claim() {
    let mut case = policy(PolicyStatus::Triggered);
    case.failed = 7;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("stranger.testnet").build());
    let refused = catch_unwind(AssertUnwindSafe(|| contract.claim(1)));
    assert!(refused.is_err());
}

/// T12 — the payout cannot exceed what the pool can actually pay.
#[test]
fn t12_payout_capped_by_pool() {
    let mut case = policy(PolicyStatus::Triggered);
    case.failed = 7;
    case.started = 20;
    // Only 4 NEAR of capital exists, though the policy's limit is 10.
    let mut contract = contract_with(case, 4 * ONE_NEAR);

    testing_env!(ctx("buyer.testnet").build());
    contract.claim(1);

    assert_eq!(contract.get_policy(1).unwrap().paid_amount.0, 4 * ONE_NEAR);
    assert_eq!(contract.get_pool(1).unwrap().total.0, 0);
}

/// A policy that never triggered stops tying up pool capital once its window is
/// over, which is what lets LPs withdraw again.
#[test]
fn expire_releases_commitment_and_unlocks_withdrawals() {
    let mut contract = contract_with(policy(PolicyStatus::Active), 100 * ONE_NEAR);
    assert_eq!(contract.get_pool(1).unwrap().committed.0, 10 * ONE_NEAR);

    testing_env!(ctx_at("anyone.testnet", AFTER_EXPIRY).build());
    contract.expire(1);

    let view = contract.get_policy(1).unwrap();
    assert_eq!(view.status, PolicyStatus::Expired);
    let pool = contract.get_pool(1).unwrap();
    assert_eq!(pool.committed.0, 0, "commitment released");
    assert_eq!(pool.total.0, 100 * ONE_NEAR, "capital stays in the pool");
    assert_eq!(pool.active_policies, 0);

    testing_env!(ctx_at("lp.testnet", AFTER_EXPIRY).build());
    contract.withdraw(1, 100 * ONE_NEAR);
    assert_eq!(contract.get_pool(1).unwrap().total.0, 0);
}

#[test]
fn expire_rejects_a_policy_whose_window_is_open() {
    let mut contract = contract_with(policy(PolicyStatus::Active), 100 * ONE_NEAR);
    testing_env!(ctx("anyone.testnet").build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| contract.expire(1))));
    assert!(message.contains("E24"), "got {message}");
    assert_eq!(contract.get_policy(1).unwrap().status, PolicyStatus::Active);
}

#[test]
fn expire_is_not_repeatable() {
    let mut contract = contract_with(policy(PolicyStatus::Active), 100 * ONE_NEAR);
    testing_env!(ctx_at("anyone.testnet", AFTER_EXPIRY).build());
    contract.expire(1);
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| contract.expire(1))));
    assert!(message.contains("E02"), "got {message}");
    assert_eq!(contract.get_pool(1).unwrap().committed.0, 0, "released once");
}

/// A triggered policy is money owed, so it stays locked and claimable.
#[test]
fn triggered_policy_cannot_expire() {
    let mut contract = contract_with(policy(PolicyStatus::Triggered), 100 * ONE_NEAR);
    testing_env!(ctx_at("anyone.testnet", AFTER_EXPIRY).build());
    let message = panic_message(catch_unwind(AssertUnwindSafe(|| contract.expire(1))));
    assert!(message.contains("E02"), "got {message}");

    testing_env!(ctx_at("buyer.testnet", AFTER_EXPIRY).build());
    contract.claim(1);
    assert_eq!(contract.get_policy(1).unwrap().paid_amount.0, 10 * ONE_NEAR);
}

#[test]
fn claim_freezes_the_policy_token() {
    let mut case = policy(PolicyStatus::Triggered);
    case.failed = 7;
    case.started = 20;
    let mut contract = contract_with(case, 100 * ONE_NEAR);

    testing_env!(ctx("buyer.testnet").build());
    contract.token_owner.insert(&"p-001".to_string(), &buyer());
    contract.tokens.insert(&"p-001".to_string(), &1u64);
    contract.token_frozen.insert(&"p-001".to_string(), &false);
    contract.claim(1);

    assert!(contract.nft_token("p-001".to_string()).unwrap().frozen);
}
