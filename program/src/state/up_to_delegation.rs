//! Up-to (variable, recipient-bound, single-use) delegation account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{
    check_min_account_size, state::common::AccountDiscriminator, state::header::DISCRIMINATOR_OFFSET, Header,
    SubscriptionsError,
};

/// A single-use delegation that authorizes one variable-amount transfer to a
/// pinned recipient.
///
/// The delegatee may move any `actual <= max_amount` (including zero) to the
/// bound [`recipient`](Self::recipient) before the optional
/// [`expiry_ts`](Self::expiry_ts). The draw consumes the delegation by zeroing
/// `max_amount`; a zeroed `max_amount` is the spent sentinel, so no second draw
/// is possible (creation rejects a zero `max_amount`).
///
/// **PDA seeds:** `["delegation", subscription_authority, delegator, delegatee, nonce]`
#[repr(C, packed)]
#[derive(Debug, CodamaAccount)]
#[codama(seed(type = string(utf8), value = "delegation"))]
#[codama(seed(name = "subscriptionAuthority", type = public_key))]
#[codama(seed(name = "delegator", type = public_key))]
#[codama(seed(name = "delegatee", type = public_key))]
#[codama(seed(name = "nonce", type = number(u64)))]
pub struct UpToDelegation {
    /// Common delegation header (discriminator, version, bump, delegator, delegatee, payer).
    pub header: Header,
    /// The exact SubscriptionAuthority PDA used when this delegation was created.
    pub subscription_authority: Address,
    /// The token mint this delegation authorizes.
    pub mint: Address,
    /// The bound recipient wallet. The receiver token account's owner must equal this.
    pub recipient: Address,
    /// Ceiling for the single draw. Zeroed once the delegation is consumed.
    pub max_amount: u64,
    /// Unix timestamp after which this delegation is no longer valid.
    /// A value of `0` means no expiry.
    pub expiry_ts: i64,
}

impl UpToDelegation {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// `max_amount` value written on the single draw to mark this delegation consumed.
    /// Creation rejects a zero `max_amount`, so a zero here unambiguously means spent.
    pub const CONSUMED_SENTINEL: u64 = 0;

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::UpToDelegation as u8 {
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
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::UpToDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    /// First-version length; recovery's frozen minimum. Never change: later versions append trailing bytes, not fields.
    pub const V1_LEN: usize = 219;

    /// Owned, version-agnostic load for revoke/close: gates on frozen [`V1_LEN`](Self::V1_LEN),
    /// zero-pads an older (smaller) account to `LEN` so appended fields read as zero.
    pub fn load_for_revoke(bytes: &[u8]) -> Result<Self, ProgramError> {
        check_min_account_size(bytes.len(), Self::V1_LEN)?;
        if bytes[DISCRIMINATOR_OFFSET] != AccountDiscriminator::UpToDelegation as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        let mut buf = [0u8; Self::LEN];
        let n = bytes.len().min(Self::LEN);
        buf[..n].copy_from_slice(&bytes[..n]);
        Ok(unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const Self) })
    }
}

const _: () = assert!(UpToDelegation::LEN >= UpToDelegation::V1_LEN);
const _: () = assert!(UpToDelegation::V1_LEN == Header::LEN + 32 + 32 + 32 + 8 + 8);
