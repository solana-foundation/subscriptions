use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::SubscriptionCancelledEvent,
    state::{common::AccountDiscriminator, plan::Plan, subscription_delegation::SubscriptionDelegation},
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction discriminator byte for `CancelSubscriptionNow`.
pub const DISCRIMINATOR: &u8 = &17;

/// Instruction data payload for immediate cancellation.
#[repr(C, packed)]
#[derive(CodamaType, Debug, Clone)]
pub struct CancelSubscriptionNowData {
    /// The `current_period_start_ts` both parties observed when signing. The
    /// subscription PDA is reused across `(plan, subscriber)` incarnations, so
    /// this binds the dual approval to the specific incarnation and rejects a
    /// signed transaction replayed against a later re-subscription.
    pub expected_current_period_start_ts: i64,
}

impl CancelSubscriptionNowData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<CancelSubscriptionNowData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Cancels a subscription immediately with approval from both the subscriber
/// and the plan owner.
///
/// The subscription can be closed via
/// [`RevokeDelegation`](crate::instructions::revoke_delegation) as soon as this
/// instruction succeeds. Emits a [`SubscriptionCancelledEvent`].
pub fn process(accounts: &mut [AccountView], data: &CancelSubscriptionNowData) -> ProgramResult {
    let accounts = CancelSubscriptionNowAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    {
        let plan_data = accounts.plan_pda.try_borrow()?;
        let plan = Plan::load(&plan_data)?;
        if &plan.owner != accounts.merchant.address() {
            return Err(SubscriptionsError::NotPlanOwner.into());
        }
    }

    {
        let mut subscription_data = accounts.subscription_pda.try_borrow_mut()?;
        check_and_update_version(&mut subscription_data, AccountDiscriminator::SubscriptionDelegation)?;
        let subscription = SubscriptionDelegation::load_mut_with_min_size(&mut subscription_data)?;

        if subscription.header.delegator != *accounts.subscriber.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        if subscription.header.delegatee != *accounts.plan_pda.address() {
            return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
        }

        if subscription.current_period_start_ts != data.expected_current_period_start_ts {
            return Err(SubscriptionsError::StaleSubscriptionApproval.into());
        }

        if subscription.expires_at_ts != 0 && subscription.expires_at_ts <= current_ts {
            return Err(SubscriptionsError::SubscriptionAlreadyCancelled.into());
        }

        subscription.expires_at_ts = current_ts;
    }

    let event =
        SubscriptionCancelledEvent::new(*accounts.plan_pda.address(), *accounts.subscriber.address(), current_ts);
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts.event_authority, accounts.self_program, &event_data)?;

    Ok(())
}

/// Validated accounts for the
/// [`CancelSubscriptionNow`](crate::SubscriptionsInstruction::CancelSubscriptionNow)
/// instruction.
pub struct CancelSubscriptionNowAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub merchant: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a mut AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for CancelSubscriptionNowAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, merchant, plan_pda, subscription_pda, event_authority, self_program] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        SignerAccount::check(merchant)?;
        ProgramAccount::check(plan_pda)?;
        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;

        Ok(Self { subscriber, merchant, plan_pda, subscription_pda, event_authority, self_program })
    }
}
