//! Traits for account validation, initialization, and lifecycle operations.

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

/// Performs a read-only validation check on an account (e.g., ownership, size, discriminator).
pub trait AccountCheck {
    /// Returns `Ok(())` if the account passes the check, or an appropriate
    /// [`ProgramError`] otherwise.
    fn check(account: &AccountView) -> Result<(), ProgramError>;
}

/// Initializes an SPL Token mint account.
pub trait MintInit {
    /// Creates and initializes a new mint.
    fn init(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult;

    /// Initializes the mint only if it does not already exist.
    fn init_if_needed(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult;
}

/// Initializes an SPL Token account.
pub trait TokenInit {
    /// Creates and initializes a new token account.
    fn init(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult;

    /// Initializes the token account only if it does not already exist.
    fn init_if_needed(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult;
}

/// Validates that an account is the correct Associated Token Account for the given inputs.
pub trait AssociatedTokenAccountCheck {
    /// Checks ATA derivation against authority, mint, and token program.
    fn check(
        account: &AccountView,
        authority: &AccountView,
        mint: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError>;
}

/// Creates an Associated Token Account via CPI.
pub trait AssociatedTokenAccountInit {
    /// Creates a new ATA.
    fn init(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &AccountView,
        system_program: &AccountView,
        token_program: &AccountView,
    ) -> ProgramResult;

    /// Creates the ATA only if it does not already exist.
    fn init_if_needed(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &AccountView,
        system_program: &AccountView,
        token_program: &AccountView,
    ) -> ProgramResult;
}

/// Creates a program-owned PDA account via CPI.
pub trait ProgramAccountInit {
    /// Allocates `space` bytes, assigns to this program, and funds rent from `payer`.
    fn init<'a, T: Sized>(
        payer: &AccountView,
        account: &AccountView,
        seeds: &[Seed<'a>],
        space: usize,
    ) -> ProgramResult;
}

/// Closes a program-owned account, returning lamports to `destination`.
pub trait AccountClose {
    /// Zeroes account data, sets lamports to zero, and transfers rent to `destination`.
    fn close(account: &AccountView, destination: &AccountView) -> ProgramResult;
}
