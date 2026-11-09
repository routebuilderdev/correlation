use near_sdk::{env, near};
use serde::Deserialize;

use crate::types::*;
use crate::verify::{to_hex, verify_receipt as verify_signature};
use crate::{Contract, ContractExt};

/// Receipts are accepted a little after the window closes so a slow final call
/// still lands; §6.5 step 4 calls this the grace period.
pub const RECEIPT_GRACE_NS: u64 = 5 * 60 * 1_000_000_000;

pub const TASK_MOD: u64 = 1_000_003;
pub const TASK_MULT: u64 = 37;

/// The expected task input is derived, not submitted: the contract computes the
/// same number the orchestrator asked the model for, from the policy id and the
/// agent's position in the swarm. That is what lets step 18 of §6.5 check `n`
/// without trusting the caller's mapping.
pub fn expected_task_input(policy_id: PolicyId, index: usize) -> u64 {
    10_000_000 + ((policy_id % 1_000) * 20 + index as u64) % 20_000
}

pub fn nullifier(policy_id: PolicyId, agent_id: &str, window_start_ns: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + agent_id.len());
    out.extend_from_slice(&policy_id.to_be_bytes());
    out.extend_from_slice(agent_id.as_bytes());
    out.extend_from_slice(&window_start_ns.to_be_bytes());
    out
}

fn fixed32(bytes: &[u8]) -> [u8; 32] {
    bytes.try_into().expect("sha256 returns 32 bytes")
}

#[derive(Deserialize)]
struct Verdict {
    n: u64,
    a: u64,
}

/// Accept the verdict either bare or wrapped in an OpenAI chat-completions
/// envelope.
///
/// The signature covers the **raw response body** (NEAR AI docs: "response_hash
/// = SHA-256(exact response-body bytes)... Do not parse and re-serialize JSON").
/// A cloud completion body is `{id, choices:[{message:{content:"{...}"}}]}`, so
/// the contract has to unwrap the content string before checking the arithmetic —
/// and must not ask the orchestrator to do it, because then the bytes it hashes
/// would no longer be the bytes that were signed.
fn parse_verdict(bytes: &[u8]) -> Option<Verdict> {
    if let Ok(verdict) = serde_json::from_slice::<Verdict>(bytes) {
        return Some(verdict);
    }
    let envelope: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let content = envelope
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    serde_json::from_str::<Verdict>(content).ok()
}

#[near]
impl Contract {
    #[payable]
    pub fn post_receipt(
        &mut self,
        policy_id: PolicyId,
        agent_id: AgentId,
        request_bytes: Vec<u8>,
        response_bytes: Vec<u8>,
        signature_json: String,
    ) {
        assert!(!self.paused, "E18 PAUSED");

        let mut policy = self
            .policies
            .get(&policy_id)
            .unwrap_or_else(|| env::panic_str("E01 POLICY_NOT_FOUND"));
        assert_eq!(policy.status, PolicyStatus::Active, "E02 NOT_ACTIVE");

        let now = env::block_timestamp();
        assert!(
            now >= policy.window_start_ns,
            "E03 OUTSIDE_WINDOW: before window start"
        );
        assert!(
            now <= policy.window_end_ns.saturating_add(RECEIPT_GRACE_NS),
            "E03 OUTSIDE_WINDOW: past the grace period"
        );

        let swarm = self
            .swarms
            .get(&policy.swarm_id)
            .unwrap_or_else(|| env::panic_str("E22 SWARM_NOT_FOUND"));
        let index = swarm
            .agent_ids
            .iter()
            .position(|id| id == &agent_id)
            .unwrap_or_else(|| env::panic_str("E04 UNKNOWN_AGENT"));

        let nullifier = nullifier(policy_id, &agent_id, policy.window_start_ns);
        assert!(
            !self.nullifiers.contains(&nullifier),
            "E05 DUPLICATE: this agent already posted in this window"
        );

        // The verdict is not a claim; it is re-derived from signed bytes.
        let verified = verify_signature(
            &policy.model_id,
            &policy.signer_pubkey,
            &request_bytes,
            &response_bytes,
            &signature_json,
        )
        .unwrap_or_else(|err| env::panic_str(&err.to_string()));

        let verdict = parse_verdict(&response_bytes)
            .unwrap_or_else(|| env::panic_str("E12 UNPARSEABLE"));

        let expected_n = expected_task_input(policy_id, index);
        assert_eq!(
            verdict.n, expected_n,
            "E13 TASK_MISMATCH: expected n {expected_n}"
        );

        let ok = verdict.a == verdict.n.wrapping_mul(TASK_MULT) % TASK_MOD;
        let request_hash = fixed32(&env::sha256(&request_bytes));
        let response_hash = fixed32(&env::sha256(&response_bytes));

        self.nullifiers.insert(&nullifier);
        self.receipts.insert(
            &(policy_id, agent_id.clone()),
            &Receipt {
                ok,
                failure_class: if ok { 0 } else { 1 },
                request_hash,
                response_hash,
                signer: verified.recovered,
                posted_at_ns: now,
            },
        );

        policy.started += 1;
        if !ok {
            policy.failed += 1;
        }
        self.policies.insert(&policy_id, &policy);

        env::log_str(&format!(
            r#"{{"standard":"correlation","version":"1.0.0","event":"receipt_posted","data":{{"policy_id":{policy_id},"agent_id":"{agent_id}","ok":{ok},"request_hash":"{}","response_hash":"{}"}}}}"#,
            to_hex(&request_hash),
            to_hex(&response_hash)
        ));
    }

    pub fn get_receipt(&self, policy_id: PolicyId, agent_id: AgentId) -> Option<ReceiptView> {
        self.receipts
            .get(&(policy_id, agent_id))
            .map(|receipt| ReceiptView {
                ok: receipt.ok,
                failure_class: receipt.failure_class,
                request_hash: to_hex(&receipt.request_hash),
                response_hash: to_hex(&receipt.response_hash),
                signer: to_hex(&receipt.signer),
                posted_at_ns: receipt.posted_at_ns,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::parse_verdict;

    #[test]
    fn parses_a_bare_verdict() {
        let verdict = parse_verdict(br#"{"n":10000022,"a":999707}"#).unwrap();
        assert_eq!((verdict.n, verdict.a), (10_000_022, 999_707));
    }

    /// A real completion body is an envelope; its content string is the verdict.
    #[test]
    fn parses_an_openai_envelope() {
        let body = br#"{"id":"abc","choices":[{"message":{"role":"assistant","content":"{\"n\":10000022,\"a\":999707}"}}]}"#;
        let verdict = parse_verdict(body).unwrap();
        assert_eq!((verdict.n, verdict.a), (10_000_022, 999_707));
    }

    #[test]
    fn rejects_prose_and_empty_content() {
        assert!(parse_verdict(b"the answer is 42").is_none());
        assert!(parse_verdict(br#"{"choices":[{"message":{"content":"nope"}}]}"#).is_none());
        assert!(parse_verdict(br#"{"choices":[]}"#).is_none());
    }
}
