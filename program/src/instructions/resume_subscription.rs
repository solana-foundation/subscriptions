use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    check_and_update_version, state::subscription_delegation::SubscriptionDelegation, AccountCheck, ProgramAccount,
    SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction discriminator byte for `ResumeSubscription`.
pub const DISCRIMINATOR: &u8 = &13;

/// Resumes a cancelled subscription by clearing its `expires_at_ts`.
///
/// The current billing period start and pulled amount are left unchanged.
pub fn process(accounts: &mut [AccountView]) -> ProgramResult {
    let accounts_struct = ResumeSubscriptionAccounts::try_from(accounts)?;

    let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;
    check_and_update_version(&mut binding)?;
    let subscription = SubscriptionDelegation::load_mut_with_min_size(&mut binding)?;

    if subscription.header.delegator != *accounts_struct.subscriber.address() {
        return Err(SubscriptionsError::Unauthorized.into());
    }

    if subscription.header.delegatee != *accounts_struct.plan_pda.address() {
        return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
    }

    if subscription.expires_at_ts == 0 {
        return Err(SubscriptionsError::SubscriptionNotCancelled.into());
    }

    subscription.expires_at_ts = 0;

    Ok(())
}

/// Validated accounts for the [`ResumeSubscription`](crate::SubscriptionsInstruction::ResumeSubscription) instruction.
pub struct ResumeSubscriptionAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a mut AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for ResumeSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, plan_pda, subscription_pda] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        if !plan_pda.owned_by(&crate::ID) {
            return Err(SubscriptionsError::PlanClosed.into());
        }
        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;

        Ok(Self { subscriber, plan_pda, subscription_pda })
    }
}
