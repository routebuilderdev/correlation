use std::panic::{catch_unwind, AssertUnwindSafe};

use correlation::types::*;
use correlation::Contract;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MODEL: &str = "z-ai/glm-5.3-flash";

fn ctx(who: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.predecessor_account_id(who.parse().unwrap());
    builder.block_timestamp(1_700_000_100_000_000_000);
    builder
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
        window_end_ns: 1_700_003_600_000_000_000,
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
