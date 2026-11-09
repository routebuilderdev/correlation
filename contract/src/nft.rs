use near_sdk::{near, AccountId};

use crate::types::{NftMetadata, NftToken, PolicyId, TokenId};
use crate::{Contract, ContractExt};

#[near]
impl Contract {
    /// NEP-171 view. The token id is derived from the policy id, so it is stable
    /// and no separate counter is needed.
    pub fn nft_token(&self, token_id: TokenId) -> Option<NftToken> {
        let owner_id = self.token_owner.get(&token_id)?;
        let policy_id = self.tokens.get(&token_id)?;
        Some(NftToken {
            token_id: token_id.clone(),
            owner_id,
            policy_id,
            frozen: self.token_frozen.get(&token_id).unwrap_or(false),
            metadata: NftMetadata {
                title: format!("Correlation policy {token_id}"),
                description: "Parametric cover for correlated agent failure. Testnet prototype, no real funds.".to_string(),
                copies: 1,
            },
        })
    }
}

impl Contract {
    pub(crate) fn mint_policy_token(&mut self, policy_id: PolicyId, owner: &AccountId) -> TokenId {
        let token_id = format!("p-{policy_id:03}");
        self.token_owner.insert(&token_id, owner);
        self.tokens.insert(&token_id, &policy_id);
        self.token_frozen.insert(&token_id, &false);
        token_id
    }

    /// A paid policy cannot move. Transfers are intentionally not exposed yet.
    #[allow(dead_code)]
    pub(crate) fn freeze_token(&mut self, token_id: &TokenId) {
        if self.token_owner.contains_key(token_id) {
            self.token_frozen.insert(token_id, &true);
        }
    }
}
