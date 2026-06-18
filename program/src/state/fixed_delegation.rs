//! Fixed (one-time) delegation account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{
    check_min_account_size, state::common::AccountDiscriminator, state::header::DISCRIMINATOR_OFFSET, Header,
    SubscriptionsError,
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
#[codama(seed(type = string(utf8), value = "delegation"))]
#[codama(seed(name = "subscriptionAuthority", type = public_key))]
#[codama(seed(name = "delegator", type = public_key))]
#[codama(seed(name = "delegatee", type = public_key))]
#[codama(seed(name = "nonce", type = number(u64)))]
pub struct FixedDelegation {
    /// Common delegation header (discriminator, version, bump, delegator, delegatee, payer).
    pub header: Header,
    /// The exact SubscriptionAuthority PDA used when this delegation was created.
    pub subscription_authority: Address,
    /// The token mint this delegation authorizes.
    pub mint: Address,
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

    /// First-version length; recovery's frozen minimum. Never change: later versions append trailing bytes, not fields.
    pub const V1_LEN: usize = 187;

    /// Owned, version-agnostic load for revoke/close: gates on frozen [`V1_LEN`](Self::V1_LEN),
    /// zero-pads an older (smaller) account to `LEN` so appended fields read as zero.
    pub fn load_for_revoke(bytes: &[u8]) -> Result<Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::V1_LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::FixedDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        let mut buf = [0u8; Self::LEN];
        let n = bytes.len().min(Self::LEN);
        buf[..n].copy_from_slice(&bytes[..n]);
        Ok(unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const Self) })
    }
}

const _: () = assert!(FixedDelegation::LEN >= FixedDelegation::V1_LEN);
