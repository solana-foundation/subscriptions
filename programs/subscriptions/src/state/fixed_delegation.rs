//! Fixed (one-time) delegation account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::error::ProgramError;

use crate::{
    check_min_account_size, state::common::AccountDiscriminator,
    state::header::DISCRIMINATOR_OFFSET, Header, SubscriptionsError,
};

/// A fixed delegation that grants a one-time token transfer allowance.
///
/// The delegatee may transfer up to [`amount`](Self::amount) tokens from the
/// delegator's ATA before the optional [`expiry_ts`](Self::expiry_ts). Each
/// successful transfer decrements `amount`; once it reaches zero (or the
/// delegation expires), no further transfers are possible.
///
/// **PDA seeds:** `["delegation", subscription_authority, delegator, delegatee, nonce]`
#[repr(C, packed)]
#[derive(Debug, CodamaAccount)]
pub struct FixedDelegation {
    /// Common delegation header (discriminator, version, bump, delegator, delegatee, payer).
    pub header: Header,
    /// Remaining token amount the delegatee is allowed to transfer.
    pub amount: u64,
    /// Unix timestamp after which this delegation is no longer valid.
    /// A value of `0` means no expiry.
    pub expiry_ts: i64,
}

impl FixedDelegation {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::FixedDelegation as u8 {
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
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::FixedDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    pub fn load_with_min_size(bytes: &[u8]) -> Result<&Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::FixedDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }
}
