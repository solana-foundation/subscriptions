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
    events::SubscriptionResumedEvent,
    state::{
        common::AccountDiscriminator, plan::Plan, subscription_authority::SubscriptionAuthority,
        subscription_delegation::SubscriptionDelegation,
    },
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionAuthorityAccount, SubscriptionsError, WritableAccount,
};

/// Instruction discriminator byte for `ResumeSubscription`.
pub const DISCRIMINATOR: &u8 = &13;

/// Instruction data payload for resuming a cancelled subscription.
#[repr(C, packed)]
#[derive(CodamaType, Debug, Clone)]
pub struct ResumeData {
    /// The `expires_at_ts` the subscriber observed when signing. The program
    /// rejects if the live value differs, so a stale signed resume cannot clear
    /// a later cancellation the subscriber never approved.
    pub expected_expires_at_ts: i64,
}

impl ResumeData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<ResumeData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Resumes a cancelled subscription by clearing its `expires_at_ts`.
///
/// Rejects when the cancellation period has elapsed, the plan account is
/// closed, expired, or no longer matches the subscription's snapshotted terms.
/// Period accounting (`current_period_start_ts`, `amount_pulled_in_period`) is
/// unchanged. Emits a [`SubscriptionResumedEvent`].
pub fn process(accounts: &mut [AccountView], data: &ResumeData) -> ProgramResult {
    let accounts_struct = ResumeSubscriptionAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    let plan_pda;
    {
        let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding, AccountDiscriminator::SubscriptionDelegation)?;
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

        if subscription.expires_at_ts != data.expected_expires_at_ts {
            return Err(SubscriptionsError::SubscriptionCancelled.into());
        }

        if !accounts_struct.plan_pda.owned_by(&crate::ID) {
            return Err(SubscriptionsError::PlanClosed.into());
        }

        let plan_mint;
        {
            let plan_data = accounts_struct.plan_pda.try_borrow()?;
            let plan = Plan::load(&plan_data)?;

            if plan.data.end_ts != 0 && current_ts > plan.data.end_ts {
                return Err(SubscriptionsError::PlanExpired.into());
            }

            subscription.check_plan_terms(&plan.data.terms)?;
            plan_mint = plan.data.mint;
        }

        {
            let authority_data = accounts_struct.subscription_authority.try_borrow()?;
            let authority = SubscriptionAuthority::load(&authority_data)?;
            authority.check_owner(accounts_struct.subscriber.address())?;
            if authority.token_mint != plan_mint {
                return Err(SubscriptionsError::MintMismatch.into());
            }
            if authority.init_id != subscription.header.init_id {
                return Err(SubscriptionsError::StaleSubscriptionAuthority.into());
            }
        }

        if subscription.expires_at_ts <= current_ts {
            return Err(SubscriptionsError::SubscriptionCancelled.into());
        }

        plan_pda = subscription.header.delegatee;
        subscription.expires_at_ts = 0;
    }

    let event = SubscriptionResumedEvent::new(plan_pda, *accounts_struct.subscriber.address(), current_ts);
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}

/// Validated accounts for the [`ResumeSubscription`](crate::SubscriptionsInstruction::ResumeSubscription) instruction.
pub struct ResumeSubscriptionAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a mut AccountView,
    pub subscription_authority: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for ResumeSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, plan_pda, subscription_pda, subscription_authority, event_authority, self_program] = accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;
        SubscriptionAuthorityAccount::check(subscription_authority)?;

        Ok(Self { subscriber, plan_pda, subscription_pda, subscription_authority, event_authority, self_program })
    }
}
