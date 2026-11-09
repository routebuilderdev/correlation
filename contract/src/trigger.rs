use near_sdk::{env, near, NearToken, Promise};

use crate::receipt::RECEIPT_GRACE_NS;
use crate::types::*;
use crate::{Contract, ContractExt};

pub fn index_bps(failed: u32, started: u32) -> u16 {
    if started == 0 {
        0
    } else {
        ((failed as u64 * 10_000) / started as u64) as u16
    }
}

#[near]
impl Contract {
    /// Idempotent and callable by anyone: a stalled trigger is the failure mode
    /// that matters (§6.6).
    pub fn evaluate(&mut self, policy_id: PolicyId) {
        let mut policy = self
            .policies
            .get(&policy_id)
            .unwrap_or_else(|| env::panic_str("E01 POLICY_NOT_FOUND"));

        if matches!(
            policy.status,
            PolicyStatus::Triggered | PolicyStatus::Paid | PolicyStatus::Expired
        ) {
            return;
        }
        assert_eq!(policy.status, PolicyStatus::Active, "E02 NOT_ACTIVE");

        let bps = index_bps(policy.failed, policy.started);
        let triggered = policy.started >= policy.min_agents
            && policy.started >= policy.min_receipts
            && bps >= policy.trigger_bps;

        env::log_str(&format!(
            r#"{{"standard":"correlation","version":"1.0.0","event":"index_updated","data":{{"policy_id":{policy_id},"failed":{},"started":{},"index_bps":{bps}}}}}"#,
            policy.failed, policy.started
        ));

        if triggered {
            policy.status = PolicyStatus::Triggered;
            self.policies.insert(&policy_id, &policy);
            env::log_str(&format!(
                r#"{{"standard":"correlation","version":"1.0.0","event":"policy_triggered","data":{{"policy_id":{policy_id},"index_bps":{bps},"threshold_bps":{}}}}}"#,
                policy.trigger_bps
            ));
        }
    }

    pub fn claim(&mut self, policy_id: PolicyId) {
        assert!(!self.paused, "E18 PAUSED");
        let mut policy = self
            .policies
            .get(&policy_id)
            .unwrap_or_else(|| env::panic_str("E01 POLICY_NOT_FOUND"));
        assert_eq!(policy.status, PolicyStatus::Triggered, "E02 NOT_ACTIVE");
        assert_eq!(
            env::predecessor_account_id(),
            policy.buyer,
            "E17 UNAUTHORIZED: only the buyer can claim"
        );

        let mut pool = self.pool_by_id(1);
        // This policy's own commitment is part of the capital backing it, so it is
        // added back before capping the payout (§6.6, T12).
        let backing = pool
            .total
            .saturating_sub(pool.committed.saturating_sub(policy.limit));
        let payout = policy.limit.min(backing);
        assert!(payout > 0, "E15 POOL_EXHAUSTED");

        pool.total -= payout;
        pool.committed = pool.committed.saturating_sub(policy.limit);
        self.pools.insert(&1u64, &pool);

        policy.status = PolicyStatus::Paid;
        policy.paid_amount = payout;
        let token_id = policy.token_id.clone();
        let buyer = policy.buyer.clone();
        self.policies.insert(&policy_id, &policy);
        self.active_policies = self.active_policies.saturating_sub(1);
        self.freeze_token(&token_id);

        let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(payout));
        env::log_str(&format!(
            r#"{{"standard":"correlation","version":"1.0.0","event":"policy_paid","data":{{"policy_id":{policy_id},"amount":"{payout}"}}}}"#
        ));
    }

    /// Anyone can retire a policy that never triggered. Releasing the commitment
    /// is what lets LPs withdraw again; a Triggered policy is deliberately left
    /// locked because the buyer is still owed that money.
    pub fn expire(&mut self, policy_id: PolicyId) {
        let mut policy = self
            .policies
            .get(&policy_id)
            .unwrap_or_else(|| env::panic_str("E01 POLICY_NOT_FOUND"));
        assert_eq!(policy.status, PolicyStatus::Active, "E02 NOT_ACTIVE");

        let now = env::block_timestamp();
        assert!(
            now > policy.window_end_ns.saturating_add(RECEIPT_GRACE_NS),
            "E24 NOT_EXPIRED: the window is still open"
        );

        policy.status = PolicyStatus::Expired;
        self.policies.insert(&policy_id, &policy);

        let mut pool = self.pool_by_id(1);
        pool.committed = pool.committed.saturating_sub(policy.limit);
        self.pools.insert(&1u64, &pool);
        self.active_policies = self.active_policies.saturating_sub(1);

        env::log_str(&format!(
            r#"{{"standard":"correlation","version":"1.0.0","event":"policy_expired","data":{{"policy_id":{policy_id},"released":"{}"}}}}"#,
            policy.limit
        ));
    }

    pub fn get_index(&self, policy_id: PolicyId) -> Option<IndexView> {
        self.policies.get(&policy_id).map(|policy| IndexView {
            policy_id: policy.policy_id,
            failed: policy.failed,
            started: policy.started,
            index_bps: index_bps(policy.failed, policy.started),
            triggered: matches!(policy.status, PolicyStatus::Triggered | PolicyStatus::Paid),
        })
    }
}
