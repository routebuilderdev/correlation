use near_sdk::json_types::U128;
use near_sdk::{env, near};
use serde::Deserialize;

use crate::types::*;
use crate::verify::{from_hex, sha256_hex};
use crate::{Contract, ContractExt};

/// The exact fields the buyer commits to. `terms_json` is parsed only after its
/// hash is confirmed, so a policy can never reference terms it did not sign.
#[derive(Deserialize)]
struct TermsBody {
    limit: U128,
    premium: U128,
    trigger_bps: u16,
    window_start_ns: u64,
    window_end_ns: u64,
    min_agents: u32,
    min_receipts: u32,
    model_id: String,
    signer_pubkey: String,
}

#[near]
impl Contract {
    /// Anyone can register a fingerprint; two swarms sharing one dependency
    /// produce the same fingerprint and therefore the same failure.
    pub fn register_swarm(&mut self, swarm_id: SwarmId, fingerprint: SwarmFingerprint) {
        assert!(!self.paused, "E18 PAUSED");
        assert!(
            !fingerprint.agent_ids.is_empty(),
            "E04 UNKNOWN_AGENT: swarm has no agents"
        );
        assert!(
            !fingerprint.model_id.is_empty(),
            "E21 BAD_TERMS_JSON: swarm has no model"
        );
        self.swarms.insert(&swarm_id, &fingerprint);
    }

    #[payable]
    pub fn buy_policy(&mut self, swarm_id: SwarmId, terms: PolicyTerms) -> TokenId {
        assert!(!self.paused, "E18 PAUSED");

        let swarm = self
            .swarms
            .get(&swarm_id)
            .unwrap_or_else(|| env::panic_str("E22 SWARM_NOT_FOUND"));

        let computed = sha256_hex(terms.terms_json.as_bytes());
        assert_eq!(
            computed,
            terms.terms_hash.to_lowercase(),
            "E20 TERMS_HASH_MISMATCH: terms_json hashes to {computed}"
        );

        let body: TermsBody = serde_json::from_str(&terms.terms_json)
            .unwrap_or_else(|_| env::panic_str("E21 BAD_TERMS_JSON"));

        assert_eq!(body.model_id, swarm.model_id, "E09 WRONG_MODEL");
        assert!(
            body.min_agents as usize <= swarm.agent_ids.len(),
            "E04 UNKNOWN_AGENT: min_agents exceeds the swarm size"
        );
        assert!(
            body.min_receipts <= body.min_agents,
            "E21 BAD_TERMS_JSON: min_receipts exceeds min_agents"
        );
        assert!(
            (1..=10_000).contains(&body.trigger_bps),
            "E21 BAD_TERMS_JSON: trigger_bps must be 1..=10000"
        );
        assert!(
            body.window_end_ns > body.window_start_ns,
            "E21 BAD_TERMS_JSON: empty window"
        );

        let signer: [u8; 64] = from_hex(&body.signer_pubkey)
            .ok()
            .and_then(|bytes| bytes.as_slice().try_into().ok())
            .unwrap_or_else(|| env::panic_str("E06 BAD_SIGNATURE_JSON: signer_pubkey"));
        assert!(self.signers.get(&signer).is_some(), "E11 UNKNOWN_SIGNER");

        let limit = body.limit.0;
        let premium = body.premium.0;
        let paid = env::attached_deposit().as_yoctonear();
        assert_eq!(
            paid, premium,
            "E19 PREMIUM_MISMATCH: expected {premium} yoctoNEAR, got {paid}"
        );

        // MVP: one pool. The premium is LP income and the limit is committed
        // against it, so coverage can never exceed capital (§6.10 #1).
        let mut pool = self.pool_by_id(1);
        assert!(
            pool.committed.saturating_add(limit) <= pool.total,
            "E15 POOL_EXHAUSTED: committed {} + limit {} exceeds total {}",
            pool.committed,
            limit,
            pool.total
        );
        pool.total += premium;
        pool.committed += limit;
        self.pools.insert(&1u64, &pool);

        let policy_id = self.next_policy_id;
        let buyer = env::predecessor_account_id();
        let token_id = self.mint_policy_token(policy_id, &buyer);

        self.policies.insert(
            &policy_id,
            &Policy {
                policy_id,
                swarm_id,
                buyer,
                terms_hash: from_hex(&terms.terms_hash)
                    .ok()
                    .and_then(|bytes| bytes.as_slice().try_into().ok())
                    .unwrap_or_else(|| env::panic_str("E20 TERMS_HASH_MISMATCH: not 32 bytes")),
                limit,
                premium,
                trigger_bps: body.trigger_bps,
                window_start_ns: body.window_start_ns,
                window_end_ns: body.window_end_ns,
                min_agents: body.min_agents,
                min_receipts: body.min_receipts,
                model_id: body.model_id,
                signer_pubkey: signer,
                status: PolicyStatus::Active,
                failed: 0,
                started: 0,
                paid_amount: 0,
                token_id: token_id.clone(),
            },
        );

        self.next_policy_id = policy_id + 1;
        self.active_policies += 1;

        token_id
    }

    pub fn get_policy(&self, policy_id: PolicyId) -> Option<PolicyView> {
        self.policies.get(&policy_id).map(|policy| PolicyView {
            policy_id: policy.policy_id,
            swarm_id: policy.swarm_id,
            buyer: policy.buyer,
            token_id: policy.token_id,
            status: policy.status,
            limit: U128(policy.limit),
            premium: U128(policy.premium),
            paid_amount: U128(policy.paid_amount),
            trigger_bps: policy.trigger_bps,
            window_start_ns: policy.window_start_ns,
            window_end_ns: policy.window_end_ns,
            min_agents: policy.min_agents,
            min_receipts: policy.min_receipts,
            model_id: policy.model_id,
            signer_pubkey: crate::verify::to_hex(&policy.signer_pubkey),
            terms_hash: crate::verify::to_hex(&policy.terms_hash),
            failed: policy.failed,
            started: policy.started,
        })
    }
}
