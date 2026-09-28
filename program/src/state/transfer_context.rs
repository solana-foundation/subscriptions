//! Ephemeral per-transfer context published for Token-2022 transfer hooks.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{state::common::AccountDiscriminator, state::versioning::CURRENT_VERSION, SubscriptionsError};

/// Details of the in-flight pull, readable by a mint's transfer hook.
///
/// Token-2022 names the [`SubscriptionAuthority`](super::subscription_authority::SubscriptionAuthority)
/// PDA as the transfer authority, so nothing in `Execute` identifies the delegate
/// that pulled. A hook resolves this account as an external PDA with seeds
/// `[Literal("TransferContext"), AccountKey(3)]`.
///
/// It exists only for the duration of the transfer instruction that creates it.
///
/// Field offsets are a wire contract with hook programs: append new fields at the
/// tail behind a [`version`](Self::version) bump, never reorder.
///
/// **PDA seeds:** `["TransferContext", subscription_authority]`
#[repr(C, packed)]
#[derive(CodamaAccount)]
#[codama(seed(type = string(utf8), value = "TransferContext"))]
#[codama(seed(name = "subscriptionAuthority", type = public_key))]
pub struct TransferContext {
    /// Account type discriminator ([`AccountDiscriminator::TransferContext`]).
    pub discriminator: u8,
    /// Schema version, currently always [`CURRENT_VERSION`].
    pub version: u8,
    /// The delegate that initiated the pull.
    pub initiator: Address,
    /// The delegation account authorizing the pull.
    pub delegation: Address,
    /// Discriminator of the account type at [`delegation`](Self::delegation).
    pub delegation_kind: u8,
}

impl TransferContext {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<TransferContext>();

    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"TransferContext";

    /// Initializes a freshly created account.
    #[inline(always)]
    pub fn init(
        bytes: &mut [u8],
        initiator: &Address,
        delegation: &Address,
        delegation_kind: AccountDiscriminator,
    ) -> Result<(), ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        let account = unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) };
        account.discriminator = AccountDiscriminator::TransferContext as u8;
        account.version = CURRENT_VERSION;
        account.initiator = *initiator;
        account.delegation = *delegation;
        account.delegation_kind = delegation_kind as u8;
        Ok(())
    }

    /// Deserializes an immutable reference from raw account data.
    #[inline(always)]
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[0] != AccountDiscriminator::TransferContext as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }
}
