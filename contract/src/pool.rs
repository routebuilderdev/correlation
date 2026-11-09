use near_sdk::json_types::U128;
use near_sdk::{env, near, NearToken, Promise};

use crate::types::{Pool, PoolId, PoolView};
use crate::{Contract, ContractExt};

#[near]
impl Contract {
    #[payable]
    pub fn deposit(&mut self, pool_id: PoolId) {
        assert!(!self.paused, "E18 PAUSED");
        let amount = env::attached_deposit().as_yoctonear();
        if amount == 0 {
            return;
        }
        let mut pool = self.pool_by_id(pool_id);
        pool.total += amount;
        self.pools.insert(&pool_id, &pool);
    }

    pub fn withdraw(&mut self, pool_id: PoolId, amount: u128) {
        assert!(!self.paused, "E18 PAUSED");
        // §6.10 #6: capital cannot leave while it is backing a live policy.
        assert_eq!(
            self.active_policies, 0,
            "E16 WITHDRAW_LOCKED: policies are still active"
        );
        let mut pool = self.pool_by_id(pool_id);
        let available = pool.total.saturating_sub(pool.committed);
        assert!(
            amount <= available,
            "E15 POOL_EXHAUSTED: available {available} yoctoNEAR"
        );
        pool.total -= amount;
        self.pools.insert(&pool_id, &pool);
        if amount > 0 {
            // The promise is scheduled on construction; the handle is unused.
            let _ = Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(amount));
        }
    }

    pub fn get_pool(&self, pool_id: PoolId) -> Option<PoolView> {
        self.pools.get(&pool_id).map(|pool| PoolView {
            pool_id: pool.pool_id,
            total: U128(pool.total),
            committed: U128(pool.committed),
            available: U128(pool.total.saturating_sub(pool.committed)),
            active_policies: self.active_policies,
        })
    }
}

impl Contract {
    pub(crate) fn pool_by_id(&self, pool_id: PoolId) -> Pool {
        self.pools
            .get(&pool_id)
            .unwrap_or_else(|| env::panic_str("E23 POOL_NOT_FOUND"))
    }
}
