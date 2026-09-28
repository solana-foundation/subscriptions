//! Traits for account validation, initialization, and lifecycle operations.

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, ProgramResult};

/// Performs a read-only validation check on an account (e.g., ownership, size, discriminator).
pub trait AccountCheck {
    /// Returns `Ok(())` if the account passes the check, or an appropriate
    /// [`ProgramError`] otherwise.
    fn check(account: &AccountView) -> Result<(), ProgramError>;
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

/// Creates a program-owned PDA account via CPI.
pub trait ProgramAccountInit {
    /// Allocates `space` bytes, assigns to this program, and funds rent from `payer`.
    fn init(payer: &AccountView, account: &AccountView, seeds: &[Seed], space: usize) -> ProgramResult;
}

/// Closes a program-owned account, returning lamports to `destination`.
pub trait AccountClose {
    /// Zeroes account data, sets lamports to zero, and transfers rent to `destination`.
    fn close(account: &AccountView, destination: &AccountView) -> ProgramResult;
}
