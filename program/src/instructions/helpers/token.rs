//! Token account validation and interface helpers.
//!
//! Provides [`AccountCheck`] implementations for both SPL Token and
//! Token-2022 mints and token accounts, along with unified interface types
//! ([`MintInterface`], [`TokenAccountInterface`], [`TokenProgramInterface`])
//! that dispatch to the correct variant based on account ownership.

use pinocchio::{error::ProgramError, AccountView, Address};
use pinocchio_token::{
    state::{Account as TokenAccountState, Mint},
    ID as SPL_TOKEN_PROGRAM_ID,
};

use super::traits::{AccountCheck, AssociatedTokenAccountCheck};
use crate::{
    constants::{
        MINT_IS_INITIALIZED_OFFSET, TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET, TOKEN_2022_MINT_DISCRIMINATOR,
        TOKEN_2022_PROGRAM_ID, TOKEN_2022_TOKEN_ACCOUNT_DISCRIMINATOR, TOKEN_ACCOUNT_DELEGATE_END,
        TOKEN_ACCOUNT_DELEGATE_OFFSET, TOKEN_ACCOUNT_DELEGATE_TAG_OFFSET,
    },
    SubscriptionsError,
};

/// Reads the `delegate` field from raw SPL token account data.
/// Returns `None` when no delegate is set (`COption::None`).
pub fn get_token_account_delegate(data: &[u8]) -> Result<Option<Address>, SubscriptionsError> {
    if data.len() < TOKEN_ACCOUNT_DELEGATE_END {
        return Err(SubscriptionsError::InvalidAccountData);
    }
    if data[TOKEN_ACCOUNT_DELEGATE_TAG_OFFSET..TOKEN_ACCOUNT_DELEGATE_OFFSET].iter().all(|&b| b == 0) {
        return Ok(None);
    }
    let mut delegate = [0u8; 32];
    delegate.copy_from_slice(&data[TOKEN_ACCOUNT_DELEGATE_OFFSET..TOKEN_ACCOUNT_DELEGATE_END]);
    Ok(Some(Address::from(delegate)))
}

// MintAccount (SPL Token)

/// Validation for SPL Token mint accounts.
pub struct MintAccount;

impl AccountCheck for MintAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&pinocchio_token::ID) {
            return Err(SubscriptionsError::InvalidTokenSplMintAccountData.into());
        }

        if account.data_len() != Mint::LEN {
            return Err(SubscriptionsError::InvalidTokenSplMintAccountData.into());
        }

        let data = account.try_borrow()?;
        if data[MINT_IS_INITIALIZED_OFFSET] != 1 {
            return Err(SubscriptionsError::InvalidTokenSplMintAccountData.into());
        }

        Ok(())
    }
}

// TokenAccount (SPL Token)

/// Validation for SPL Token token accounts.
pub struct TokenAccount;

impl AccountCheck for TokenAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&pinocchio_token::ID) {
            return Err(SubscriptionsError::InvalidTokenSplTokenAccountData.into());
        }

        if account.data_len().ne(&TokenAccountState::LEN) {
            return Err(SubscriptionsError::InvalidTokenSplTokenAccountData.into());
        }

        Ok(())
    }
}

// Mint2022Account

/// Validation for Token-2022 mint accounts.
///
/// Checks ownership by the Token-2022 program, that the base mint is initialized,
/// and, for extended accounts, the `0x01` mint discriminator at byte 165.
pub struct Mint2022Account;

impl AccountCheck for Mint2022Account {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&crate::constants::TOKEN_2022_PROGRAM_ID) {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        let data = account.try_borrow()?;

        if data.len() < Mint::LEN || data[MINT_IS_INITIALIZED_OFFSET] != 1 {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        if data.len() != Mint::LEN
            && (data.len() <= TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET
                || data[TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET].ne(&TOKEN_2022_MINT_DISCRIMINATOR))
        {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        Ok(())
    }
}

// TokenAccount2022Account

/// Validation for Token-2022 token accounts.
pub struct TokenAccount2022Account;

impl AccountCheck for TokenAccount2022Account {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&TOKEN_2022_PROGRAM_ID) {
            return Err(SubscriptionsError::InvalidToken2022TokenAccountData.into());
        }

        if account.data_len() == TokenAccountState::LEN {
            return Ok(());
        }

        let data = account.try_borrow()?;

        if data.len() <= TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET
            || data[TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET].ne(&TOKEN_2022_TOKEN_ACCOUNT_DISCRIMINATOR)
        {
            return Err(SubscriptionsError::InvalidToken2022TokenAccountData.into());
        }

        Ok(())
    }
}

/// Unified validator that accepts either SPL Token or Token-2022 program accounts.
pub struct TokenProgramInterface;

impl TokenProgramInterface {
    pub fn check(account: &AccountView) -> Result<(), ProgramError> {
        if account.address().ne(&SPL_TOKEN_PROGRAM_ID) && account.address().ne(&TOKEN_2022_PROGRAM_ID) {
            return Err(SubscriptionsError::InvalidTokenProgram.into());
        }
        Ok(())
    }
}

/// Unified validator for mint accounts across both SPL Token and Token-2022.
pub struct MintInterface;

impl AccountCheck for MintInterface {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if account.owned_by(&TOKEN_2022_PROGRAM_ID) {
            Mint2022Account::check(account)
        } else {
            MintAccount::check(account)
        }
    }
}

impl MintInterface {
    pub fn check_with_program(account: &AccountView, token_program: &AccountView) -> Result<(), ProgramError> {
        Self::check(account)?;

        if !account.owned_by(token_program.address()) {
            return Err(SubscriptionsError::InvalidTokenProgram.into());
        }

        Ok(())
    }
}

/// Unified validator for token accounts across both SPL Token and Token-2022.
pub struct TokenAccountInterface;

impl AccountCheck for TokenAccountInterface {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if account.owned_by(&TOKEN_2022_PROGRAM_ID) {
            TokenAccount2022Account::check(account)
        } else {
            TokenAccount::check(account)
        }
    }
}

impl TokenAccountInterface {
    pub fn check_with_program(account: &AccountView, token_program: &AccountView) -> Result<(), ProgramError> {
        Self::check(account)?;

        if !account.owned_by(token_program.address()) {
            return Err(SubscriptionsError::InvalidTokenProgram.into());
        }

        Ok(())
    }

    pub fn check_accounts_with_program(
        token_program: &AccountView,
        accounts: &[&AccountView],
    ) -> Result<(), ProgramError> {
        for account in accounts {
            Self::check_with_program(account, token_program)?;
        }
        Ok(())
    }
}

/// Unified ATA check for both SPL Token and Token-2022.
pub struct AssociatedTokenAccount;

impl AssociatedTokenAccountCheck for AssociatedTokenAccount {
    fn check(
        account: &AccountView,
        authority: &AccountView,
        mint: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError> {
        TokenAccountInterface::check(account)?;

        if Address::find_program_address(
            &[authority.address().as_ref(), token_program.address().as_ref(), mint.address().as_ref()],
            &pinocchio_associated_token_account::ID,
        )
        .0
        .ne(account.address())
        {
            return Err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress.into());
        }

        Ok(())
    }
}
