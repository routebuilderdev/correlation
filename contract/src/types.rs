use near_sdk::json_types::U128;
use near_sdk::near;

pub type PolicyId = u64;
pub type PoolId = u64;
pub type TokenId = String;
pub type AgentId = String;
pub type SwarmId = String;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyStatus {
    Active,
    Triggered,
    Paid,
    Expired,
    Cancelled,
}

/// Storage type. Borsh only: `[u8; 64]` has no serde impl, so the JSON boundary
/// uses the hex-string views below (`SignerView`, and later `PolicyView`).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    pub policy_id: PolicyId,
    pub swarm_id: SwarmId,
    pub buyer: near_sdk::AccountId,
    /// Hash of the exact terms JSON the buyer signed.
    pub terms_hash: [u8; 32],
    /// yoctoNEAR
    pub limit: u128,
    /// yoctoNEAR
    pub premium: u128,
    /// 2500 = 25%
    pub trigger_bps: u16,
    pub window_start_ns: u64,
    pub window_end_ns: u64,
    /// N — every agent must have posted before the index counts.
    pub min_agents: u32,
    /// Q * N — coverage threshold.
    pub min_receipts: u32,
    pub model_id: String,
    /// Pinned at purchase; the only trust root (D11).
    pub signer_pubkey: [u8; 64],
    pub status: PolicyStatus,
    pub failed: u32,
    pub started: u32,
    pub paid_amount: u128,
    pub token_id: TokenId,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub ok: bool,
    pub failure_class: u16,
    pub request_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub signer: [u8; 64],
    pub posted_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SignerRegistration {
    pub public_key: [u8; 64],
    pub model_name: String,
    /// Recorded evidence only — never a gate (D11).
    pub compose_hash: [u8; 32],
    pub os_image_hash: [u8; 32],
    /// Hash of the verification policy applied off-chain.
    pub policy_hash: [u8; 32],
    pub verified_at_ns: u64,
    pub expires_at_ns: u64,
}

/// What the swarm shares. Two swarms with the same fingerprint fail together.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SwarmFingerprint {
    pub model_id: String,
    pub prompt_hash: [u8; 32],
    pub agent_ids: Vec<AgentId>,
}

/// The signature record returned by `GET /v1/signature/{id}`.
/// Field names mirror the API response so the JSON can be submitted verbatim.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct SignatureRecord {
    pub text: String,
    /// 65 bytes, hex. `0x` prefix tolerated.
    pub signature: String,
    pub signing_algo: String,
    pub signature_kind: String,
    pub signing_address: Option<String>,
    pub signing_public_key: Option<String>,
    /// Present on some responses; the signed text is authoritative.
    pub model: Option<String>,
}

/// JSON input for `register_signer`. Hex strings keep the call usable by hand.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RegisterSignerArgs {
    /// 64 bytes: 128 hex chars.
    pub public_key: String,
    pub model_name: String,
    /// 32 bytes: 64 hex chars.
    pub compose_hash: String,
    pub os_image_hash: String,
    pub policy_hash: String,
    pub verified_at_ns: u64,
    pub expires_at_ns: u64,
}

/// JSON output for `get_signer`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignerView {
    pub public_key: String,
    pub model_name: String,
    pub compose_hash: String,
    pub os_image_hash: String,
    pub policy_hash: String,
    pub verified_at_ns: u64,
    pub expires_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Pool {
    pub pool_id: PoolId,
    /// Deposits plus collected premiums, in yoctoNEAR.
    pub total: u128,
    /// Sum of limits of live policies; never exceeds `total` (§6.10 #1).
    pub committed: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PoolView {
    pub pool_id: PoolId,
    pub total: U128,
    pub committed: U128,
    pub available: U128,
    pub active_policies: u32,
}

/// What the buyer signs. `terms_json` is submitted verbatim and hashed by the
/// contract, so the terms cannot change under the policy (§6.10 #7).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyTerms {
    pub terms_json: String,
    /// sha256 of `terms_json`, lowercase hex.
    pub terms_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NftMetadata {
    pub title: String,
    pub description: String,
    pub copies: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NftToken {
    pub token_id: TokenId,
    pub owner_id: near_sdk::AccountId,
    pub policy_id: PolicyId,
    pub frozen: bool,
    pub metadata: NftMetadata,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ReceiptView {
    pub ok: bool,
    pub failure_class: u16,
    pub request_hash: String,
    pub response_hash: String,
    pub signer: String,
    pub posted_at_ns: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IndexView {
    pub policy_id: PolicyId,
    pub failed: u32,
    pub started: u32,
    pub index_bps: u16,
    pub triggered: bool,
}

/// JSON view of a policy. Amounts are strings, keys are hex (§8.5).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyView {
    pub policy_id: PolicyId,
    pub swarm_id: SwarmId,
    pub buyer: near_sdk::AccountId,
    pub token_id: TokenId,
    pub status: PolicyStatus,
    pub limit: U128,
    pub premium: U128,
    pub paid_amount: U128,
    pub trigger_bps: u16,
    pub window_start_ns: u64,
    pub window_end_ns: u64,
    pub min_agents: u32,
    pub min_receipts: u32,
    pub model_id: String,
    pub signer_pubkey: String,
    pub terms_hash: String,
    pub failed: u32,
    pub started: u32,
}
