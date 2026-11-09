use near_sdk::collections::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

pub mod errors;
pub mod types;
pub mod verify;

use types::{PolicyId, RegisterSignerArgs, SignerRegistration, SignerView};
use verify::{from_hex, to_hex};

/// State per blueprint §6.3. Only the parts needed by the verification gate exist
/// yet; policies, pools and receipts arrive with their own modules.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner: AccountId,
    pub paused: bool,
    pub next_policy_id: PolicyId,
    pub next_pool_id: u64,
    /// 64-byte secp256k1 keys, registered only after off-chain attestation (D11).
    pub signers: LookupMap<[u8; 64], SignerRegistration>,
}

fn fixed_hex<const N: usize>(label: &str, value: &str) -> [u8; N] {
    let bytes = match from_hex(value) {
        Ok(bytes) => bytes,
        Err(_) => env::panic_str(&format!("E06 BAD_SIGNATURE_JSON: {label} is not hex")),
    };
    match bytes.as_slice().try_into() {
        Ok(array) => array,
        Err(_) => env::panic_str(&format!(
            "E06 BAD_SIGNATURE_JSON: {label} must be {N} bytes, got {}",
            bytes.len()
        )),
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            paused: false,
            next_policy_id: 1,
            next_pool_id: 1,
            signers: LookupMap::new(b"signers".to_vec()),
        }
    }

    /// Owner-only. The caller must have verified the TDX quote off-chain first.
    pub fn register_signer(&mut self, args: RegisterSignerArgs) {
        self.assert_owner();
        let registration = SignerRegistration {
            public_key: fixed_hex("public_key", &args.public_key),
            model_name: args.model_name,
            compose_hash: fixed_hex("compose_hash", &args.compose_hash),
            os_image_hash: fixed_hex("os_image_hash", &args.os_image_hash),
            policy_hash: fixed_hex("policy_hash", &args.policy_hash),
            verified_at_ns: args.verified_at_ns,
            expires_at_ns: args.expires_at_ns,
        };
        self.signers.insert(&registration.public_key, &registration);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn get_signer(&self, public_key: String) -> Option<SignerView> {
        let key: [u8; 64] = from_hex(&public_key).ok()?.as_slice().try_into().ok()?;
        self.signers.get(&key).map(|registration| SignerView {
            public_key: to_hex(&registration.public_key),
            model_name: registration.model_name,
            compose_hash: to_hex(&registration.compose_hash),
            os_image_hash: to_hex(&registration.os_image_hash),
            policy_hash: to_hex(&registration.policy_hash),
            verified_at_ns: registration.verified_at_ns,
            expires_at_ns: registration.expires_at_ns,
        })
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "E17 UNAUTHORIZED"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const PUBLIC_KEY: &str = "8272671aa3d29e75085543f812537250d979716e36e60f4890ba8d53e4cc4b8f1941a1fdb767279167b5dad998d40950a44e1cc09741437f0d1caf6195728c6b";

    fn context(predecessor: &str) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(predecessor.parse().unwrap());
        builder
    }

    fn args() -> RegisterSignerArgs {
        RegisterSignerArgs {
            public_key: PUBLIC_KEY.to_string(),
            model_name: "z-ai/glm-5.3-flash".to_string(),
            compose_hash: "e8416a02".to_string() + &"0".repeat(56),
            os_image_hash: "11".repeat(32),
            policy_hash: "22".repeat(32),
            verified_at_ns: 1_700_000_000_000_000_000,
            expires_at_ns: 1_700_000_000_000_000_000 + 86_400_000_000_000,
        }
    }

    /// T1 — new sets owner, not paused.
    #[test]
    fn t1_new_sets_owner_and_unpaused() {
        testing_env!(context("owner.testnet").build());
        let contract = Contract::new("owner.testnet".parse().unwrap());
        assert_eq!(
            contract.get_owner(),
            "owner.testnet".parse::<AccountId>().unwrap()
        );
        assert!(!contract.is_paused());
        assert_eq!(contract.next_policy_id, 1);
    }

    #[test]
    fn register_signer_is_owner_only() {
        testing_env!(context("owner.testnet").build());
        let mut contract = Contract::new("owner.testnet".parse().unwrap());

        testing_env!(context("attacker.testnet").build());
        let denied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.register_signer(args())
        }));
        assert!(denied.is_err(), "non-owner must not register a signer");

        testing_env!(context("owner.testnet").build());
        contract.register_signer(args());
        let signer = contract.get_signer(PUBLIC_KEY.to_string()).unwrap();
        assert_eq!(signer.model_name, "z-ai/glm-5.3-flash");
        assert_eq!(signer.public_key, PUBLIC_KEY);
        assert_eq!(signer.compose_hash, args().compose_hash);
    }

    #[test]
    fn signer_lookup_rejects_bad_hex() {
        testing_env!(context("owner.testnet").build());
        let contract = Contract::new("owner.testnet".parse().unwrap());
        assert!(contract.get_signer("not-hex".to_string()).is_none());
    }
}
