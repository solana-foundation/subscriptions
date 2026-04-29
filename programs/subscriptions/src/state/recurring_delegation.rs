//! Recurring (periodic) delegation account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{
    check_min_account_size, state::common::AccountDiscriminator,
    state::header::DISCRIMINATOR_OFFSET, Header, SubscriptionsError,
};

/// A recurring delegation that grants a periodic token transfer allowance.
///
/// Each period the delegatee may transfer up to [`amount_per_period`](Self::amount_per_period)
/// tokens. The period counter rolls forward automatically: when a transfer occurs
/// after the current period has elapsed, the period start is advanced and the
/// pulled amount resets to zero. Skipped periods do **not** accumulate allowance.
///
/// **PDA seeds:** `["delegation", subscription_authority, delegator, delegatee, nonce]`
#[repr(C, packed)]
#[derive(Debug, CodamaAccount)]
#[codama(seed(type = string(utf8), value = "delegation"))]
#[codama(seed(name = "subscriptionAuthority", type = public_key))]
#[codama(seed(name = "delegator", type = public_key))]
#[codama(seed(name = "delegatee", type = public_key))]
#[codama(seed(name = "nonce", type = number(u64)))]
pub struct RecurringDelegation {
    /// Common delegation header (discriminator, version, bump, delegator, delegatee, payer).
    pub header: Header,
    /// The exact SubscriptionAuthority PDA used when this delegation was created.
    pub subscription_authority: Address,
    /// The token mint this delegation authorizes.
    pub mint: Address,
    /// Unix timestamp marking the start of the current period.
    pub current_period_start_ts: i64,
    /// Length of each period in seconds.
    pub period_length_s: u64,
    /// Unix timestamp after which this delegation is no longer valid.
    /// A value of `0` means no expiry.
    pub expiry_ts: i64,
    /// Maximum token amount transferable per period.
    pub amount_per_period: u64,
    /// Token amount already transferred in the current period.
    pub amount_pulled_in_period: u64,
}

impl RecurringDelegation {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::RecurringDelegation as u8 {
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
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::RecurringDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    pub fn load_with_min_size(bytes: &[u8]) -> Result<&Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::RecurringDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }
}

pub const RECURRING_DELEGATION_LEN: usize = 211;
const _: () = assert!(RecurringDelegation::LEN == RECURRING_DELEGATION_LEN);
