//! The root subscription-authority account that enables subscription-authority for a specific token mint.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{state::common::AccountDiscriminator, SubscriptionsError};

/// Root PDA that acts as the SPL Token delegate for a user's associated token account.
///
/// One `SubscriptionAuthority` account exists per (user, token_mint) pair. The program
/// approves itself (this PDA) as the delegate on the user's ATA with `u64::MAX`
/// allowance, then individual delegation PDAs control how much each delegatee can
/// actually transfer.
///
/// **PDA seeds:** `["SubscriptionAuthority", user, token_mint]`
#[repr(C, packed)]
#[derive(CodamaAccount)]
#[codama(seed(type = string(utf8), value = "SubscriptionAuthority"))]
#[codama(seed(name = "user", type = public_key))]
#[codama(seed(name = "tokenMint", type = public_key))]
pub struct SubscriptionAuthority {
    /// Account type discriminator ([`AccountDiscriminator::SubscriptionAuthority`]).
    pub discriminator: u8,
    /// The wallet that owns this subscription-authority instance.
    pub user: Address,
    /// The SPL token mint this delegation covers.
    pub token_mint: Address,
    /// The account that funded the PDA creation. Receives rent on close.
    /// Defaults to `user` when no separate sponsor was provided at init time.
    pub payer: Address,
    /// PDA bump seed.
    pub bump: u8,
    /// Initialization identifier set from `Clock::slot` when the account is created.
    pub init_id: i64,
}

impl SubscriptionAuthority {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<SubscriptionAuthority>();

    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"SubscriptionAuthority";

    /// Initializes a freshly created account by setting all fields including
    /// the discriminator. Use this instead of `load_mut` when the account
    /// has just been created.
    #[inline(always)]
    pub fn init<'a>(
        bytes: &'a mut [u8],
        user: &Address,
        token_mint: &Address,
        payer: &Address,
        bump: u8,
        init_id: i64,
    ) -> Result<&'a Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        let account = unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) };
        account.discriminator = AccountDiscriminator::SubscriptionAuthority as u8;
        account.user = *user;
        account.token_mint = *token_mint;
        account.payer = *payer;
        account.bump = bump;
        account.init_id = init_id;
        Ok(account)
    }

    /// Deserializes a mutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    #[inline(always)]
    pub fn load_mut(bytes: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[0] != AccountDiscriminator::SubscriptionAuthority as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    #[inline(always)]
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[0] != AccountDiscriminator::SubscriptionAuthority as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }

    /// Asserts that `expected_user` matches the stored [`user`](Self::user) field.
    pub fn check_owner(&self, expected_user: &Address) -> Result<(), ProgramError> {
        if self.user != *expected_user {
            return Err(SubscriptionsError::Unauthorized.into());
        }
        Ok(())
    }

    /// Verifies that the given seeds and bump produce a valid PDA.
    ///
    /// This is cheaper than [`find_pda`](Self::find_pda) as it doesn't iterate
    /// through bumps. Returns the computed PDA if valid, or an error if the bump
    /// is invalid.
    pub fn verify_pda(
        user: &Address,
        token_mint: &Address,
        bump: u8,
    ) -> Result<Address, ProgramError> {
        Address::create_program_address(
            &[Self::SEED, user.as_ref(), token_mint.as_ref(), &[bump]],
            &crate::ID,
        )
        .map_err(|_| SubscriptionsError::InvalidSubscriptionAuthorityPda.into())
    }

    /// Finds the canonical PDA and bump for the subscription-authority account.
    pub fn find_pda(user: &Address, token_mint: &Address) -> (Address, u8) {
        Address::find_program_address(
            &[Self::SEED, user.as_ref(), token_mint.as_ref()],
            &crate::ID,
        )
    }
}
