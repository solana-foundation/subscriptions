//! Ephemeral per-transfer context published for Token-2022 transfer hooks.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{state::common::AccountDiscriminator, state::versioning::CURRENT_VERSION, SubscriptionsError};

/// Details of the in-flight pull, readable by a mint's transfer hook.
///
/// Token-2022 hands a hook the [`SubscriptionAuthority`](super::subscription_authority::SubscriptionAuthority)
/// PDA as the transfer authority and nothing about the delegate that initiated the
/// pull. A hook resolves this account through its `ExtraAccountMetaList` as an
/// external PDA with seeds `[Literal("TransferContext"), AccountKey(3)]` and reads
/// the initiator from it.
///
/// The account exists only for the duration of the transfer instruction that
/// creates it, so a hook that finds it can treat its contents as describing the
/// transfer currently executing.
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
    /// PDA bump seed.
    pub bump: u8,
    /// The delegate that initiated the pull.
    pub initiator: Address,
    /// The delegation account authorizing the pull.
    pub delegation: Address,
    /// Discriminator of the account type at [`delegation`](Self::delegation).
    pub delegation_kind: u8,
    /// The token mint being transferred.
    pub mint: Address,
    /// Token amount of the transfer this context describes.
    pub amount: u64,
    /// Slot the context was written in.
    pub slot: u64,
}

impl TransferContext {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<TransferContext>();

    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"TransferContext";

    /// Initializes a freshly created account, setting all fields.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    pub fn init(
        bytes: &mut [u8],
        bump: u8,
        initiator: &Address,
        delegation: &Address,
        delegation_kind: AccountDiscriminator,
        mint: &Address,
        amount: u64,
        slot: u64,
    ) -> Result<(), ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        let account = unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) };
        account.discriminator = AccountDiscriminator::TransferContext as u8;
        account.version = CURRENT_VERSION;
        account.bump = bump;
        account.initiator = *initiator;
        account.delegation = *delegation;
        account.delegation_kind = delegation_kind as u8;
        account.mint = *mint;
        account.amount = amount;
        account.slot = slot;
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
