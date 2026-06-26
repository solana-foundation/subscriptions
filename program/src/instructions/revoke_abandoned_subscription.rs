use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    AccountCheck, AccountClose, ProgramAccount, SignerAccount, SubscriptionAuthority, SubscriptionsError,
    WritableAccount,
};

/// Validated accounts for the [`RevokeAbandonedSubscription`](crate::SubscriptionsInstruction::RevokeAbandonedSubscription) instruction.
pub struct RevokeAbandonedSubscriptionAccounts<'a> {
    /// The recorded payer (sponsor) reclaiming rent (signer + writable).
    pub payer: &'a AccountView,
    /// The subscription PDA to close.
    pub subscription_account: &'a AccountView,
    /// The subscriber's recorded SubscriptionAuthority PDA; may be closed.
    pub subscription_authority: &'a AccountView,
    /// The plan the subscription belongs to, used to recover the mint.
    pub plan_pda: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for RevokeAbandonedSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [payer, subscription_account, subscription_authority, plan_pda, ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(payer)?;
        WritableAccount::check(payer)?;
        WritableAccount::check(subscription_account)?;
        ProgramAccount::check(subscription_account)?;

        Ok(Self { payer, subscription_account, subscription_authority, plan_pda })
    }
}

/// Instruction discriminator byte for `RevokeAbandonedSubscription`.
pub const DISCRIMINATOR: &u8 = &16;

/// Closes an abandoned subscription, returning rent to the recorded payer, once
/// its authority is terminal: the subscriber's `SubscriptionAuthority` for the
/// plan's mint is closed, or its `init_id` no longer matches the subscription.
/// Subscription analogue of `revoke_abandoned_delegation`.
///
/// The mint comes from the bound plan, never the supplied authority's own
/// `token_mint`, so a sponsor cannot pass an unrelated-mint authority to spoof
/// "abandoned" and close a still-billable subscription.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeAbandonedSubscriptionAccounts::try_from(accounts)?;

    {
        let data = accounts.subscription_account.try_borrow()?;
        let subscription = SubscriptionDelegation::load_for_revoke(&data)?;

        let delegator = subscription.header.delegator;
        let delegatee = subscription.header.delegatee;
        let payer = subscription.header.payer;
        let init_id = subscription.header.init_id;

        if payer != *accounts.payer.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        if delegatee != *accounts.plan_pda.address() {
            return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
        }

        // Plan must be live to read its mint; a closed plan is recoverable via revoke_delegation.
        if !accounts.plan_pda.owned_by(&crate::ID) {
            return Err(SubscriptionsError::PlanClosed.into());
        }
        let plan_mint = {
            let plan_data = accounts.plan_pda.try_borrow()?;
            let plan = Plan::load(&plan_data)?;
            plan.data.mint
        };

        let expected_authority = SubscriptionAuthority::find_pda(&delegator, &plan_mint).0;
        if expected_authority != *accounts.subscription_authority.address() {
            return Err(SubscriptionsError::InvalidSubscriptionAuthorityPda.into());
        }

        // Terminal: authority closed or init_id rotated (inverse of the transfer-time check).
        let authority_is_dead = if !accounts.subscription_authority.owned_by(&crate::ID) {
            true
        } else {
            let authority_data = accounts.subscription_authority.try_borrow()?;
            match SubscriptionAuthority::load(&authority_data) {
                Ok(authority) => authority.init_id != init_id,
                Err(_) => true,
            }
        };

        if !authority_is_dead {
            return Err(SubscriptionsError::Unauthorized.into());
        }
    }

    ProgramAccount::close(accounts.subscription_account, accounts.payer)
}
