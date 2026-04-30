use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::SubscriptionCancelledEvent,
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction discriminator byte for `CancelSubscription`.
pub const DISCRIMINATOR: &u8 = &12;

/// Cancels a subscription by setting its `expires_at_ts` to the end of the
/// current billing period.
///
/// After cancellation the subscription remains valid until `expires_at_ts`,
/// then it can be closed via [`RevokeDelegation`](crate::instructions::revoke_delegation).
/// Emits a [`SubscriptionCancelledEvent`].
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts_struct = CancelSubscriptionAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    let expires_at_ts;
    let plan_pda;
    {
        let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let subscription = SubscriptionDelegation::load_mut_with_min_size(&mut binding)?;

        if subscription.header.delegator != *accounts_struct.subscriber.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        if subscription.expires_at_ts != 0 {
            return Err(SubscriptionsError::SubscriptionAlreadyCancelled.into());
        }

        if subscription.header.delegatee != *accounts_struct.plan_pda.address() {
            return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
        }

        plan_pda = subscription.header.delegatee;

        if accounts_struct.plan_pda.owned_by(&crate::ID) {
            let plan_data = accounts_struct.plan_pda.try_borrow()?;
            let plan = Plan::load(&plan_data)?;

            if subscription.check_plan_terms(&plan.data.terms).is_err() {
                // Ghost plan (terms mismatch) — expire immediately so the subscriber can revoke without paying.
                expires_at_ts = current_ts;
            } else {
                let period_length_s = subscription.terms.period_length_secs() as i64;
                let period_start = subscription.current_period_start_ts;
                let elapsed = current_ts.saturating_sub(period_start);
                let periods_elapsed = elapsed / period_length_s;
                expires_at_ts = periods_elapsed
                    .checked_add(1)
                    .and_then(|p| p.checked_mul(period_length_s))
                    .and_then(|offset| period_start.checked_add(offset))
                    // Cap at plan end so the subscriber can revoke as soon as the plan expires.
                    .map(|ts| if plan.data.end_ts != 0 { ts.min(plan.data.end_ts) } else { ts })
                    .ok_or::<ProgramError>(SubscriptionsError::ArithmeticOverflow.into())?;
            }
        } else {
            // Plan account closed — expire immediately.
            expires_at_ts = current_ts;
        }

        subscription.expires_at_ts = expires_at_ts;
    }

    let event = SubscriptionCancelledEvent::new(plan_pda, *accounts_struct.subscriber.address(), expires_at_ts);
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}

/// Validated accounts for the [`CancelSubscription`](crate::SubscriptionsInstruction::CancelSubscription) instruction.
pub struct CancelSubscriptionAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for CancelSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, plan_pda, subscription_pda, event_authority, self_program] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;

        Ok(Self { subscriber, plan_pda, subscription_pda, event_authority, self_program })
    }
}
