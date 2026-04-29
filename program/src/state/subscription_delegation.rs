//! Subscription delegation account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::error::ProgramError;

use crate::{
    check_min_account_size, instructions::create_plan::PlanTerms, state::common::AccountDiscriminator,
    state::header::DISCRIMINATOR_OFFSET, Header, SubscriptionsError,
};

/// A subscriber's delegation linked to a specific [`Plan`](super::plan::Plan).
///
/// Created when a user subscribes to a plan. The plan owner (or whitelisted
/// pullers) can transfer up to the plan's `amount` per period from the
/// subscriber's ATA. Cancellation sets [`expires_at_ts`](Self::expires_at_ts)
/// to the end of the current billing period; after that timestamp, no further
/// transfers are allowed and the account can be closed via revoke.
///
/// **PDA seeds:** `["subscription", plan_pda, subscriber]`
#[repr(C, packed)]
#[derive(Debug, CodamaAccount)]
#[codama(seed(type = string(utf8), value = "subscription"))]
#[codama(seed(name = "planPda", type = public_key))]
#[codama(seed(name = "subscriber", type = public_key))]
pub struct SubscriptionDelegation {
    /// Common delegation header (discriminator, version, bump, delegator, delegatee, payer).
    ///
    /// In this context, `delegator` is the subscriber and `delegatee` is the plan PDA.
    pub header: Header,
    /// Snapshot of the plan's billing terms at subscribe time.
    pub terms: PlanTerms,
    /// Token amount already transferred in the current billing period.
    pub amount_pulled_in_period: u64,
    /// Unix timestamp marking the start of the current billing period.
    pub current_period_start_ts: i64,
    /// Unix timestamp after which this subscription is no longer valid.
    ///
    /// `0` means the subscription is active (not cancelled). Set to a future
    /// timestamp when the subscriber cancels; transfers are blocked once the
    /// clock passes this value.
    pub expires_at_ts: i64,
}

impl SubscriptionDelegation {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"subscription";

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::SubscriptionDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }

    /// Deserializes a mutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load_mut(bytes: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::SubscriptionDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    pub fn load_with_min_size(bytes: &[u8]) -> Result<&Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::SubscriptionDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }

    pub fn load_mut_with_min_size(bytes: &mut [u8]) -> Result<&mut Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::SubscriptionDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    pub fn check_plan_terms(&self, plan_terms: &PlanTerms) -> Result<(), ProgramError> {
        if self.terms.created_at != plan_terms.created_at
            || self.terms.amount != plan_terms.amount
            || self.terms.period_hours != plan_terms.period_hours
        {
            return Err(SubscriptionsError::PlanTermsMismatch.into());
        }
        Ok(())
    }
}

pub const SUBSCRIPTION_DELEGATION_LEN_V1: usize = 155;
const _: () = assert!(SubscriptionDelegation::LEN == SUBSCRIPTION_DELEGATION_LEN_V1);
