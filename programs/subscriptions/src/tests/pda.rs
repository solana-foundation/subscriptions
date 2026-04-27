use solana_pubkey::Pubkey;

use crate::{
    tests::constants::PROGRAM_ID, SubscriptionAuthority, Plan, SubscriptionDelegation, DELEGATE_BASE_SEED,
};

pub fn get_subscription_authority_pda(user: &Pubkey, token_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SubscriptionAuthority::SEED, user.as_ref(), token_mint.as_ref()],
        &PROGRAM_ID,
    )
}

pub fn get_delegation_pda(
    subscription_authority: &Pubkey,
    delegator: &Pubkey,
    delegatee: &Pubkey,
    nonce: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            DELEGATE_BASE_SEED,
            subscription_authority.as_ref(),
            delegator.as_ref(),
            delegatee.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
}

pub fn get_plan_pda(owner: &Pubkey, plan_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[Plan::SEED, owner.as_ref(), &plan_id.to_le_bytes()],
        &PROGRAM_ID,
    )
}

pub fn get_subscription_pda(plan_pda: &Pubkey, subscriber: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SubscriptionDelegation::SEED,
            plan_pda.as_ref(),
            subscriber.as_ref(),
        ],
        &PROGRAM_ID,
    )
}
