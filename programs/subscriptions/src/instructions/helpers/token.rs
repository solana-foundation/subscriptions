//! Token account validation, initialization, and interface helpers.
//!
//! Provides [`AccountCheck`] and init implementations for both SPL Token and
//! Token-2022 mints and token accounts, along with unified interface types
//! ([`MintInterface`], [`TokenAccountInterface`], [`TokenProgramInterface`])
//! that dispatch to the correct variant based on account ownership.

use pinocchio::{
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_associated_token_account::instructions::Create;
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::{
    instructions::{InitializeAccount3, InitializeMint2},
    state::{Mint, TokenAccount as TokenAccountState},
    ID as SPL_TOKEN_PROGRAM_ID,
};

use super::traits::{
    AccountCheck, AssociatedTokenAccountCheck, AssociatedTokenAccountInit, MintInit, TokenInit,
};
use crate::{
    constants::{
        TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET, TOKEN_2022_MINT_DISCRIMINATOR,
        TOKEN_2022_PROGRAM_ID, TOKEN_2022_TOKEN_ACCOUNT_DISCRIMINATOR,
    },
    SubscriptionsError,
};

const EXTENSION_TYPE_TRANSFER_FEE_CONFIG: u16 = 1;
const EXTENSION_TYPE_MINT_CLOSE_AUTHORITY: u16 = 3;
const EXTENSION_TYPE_CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
const EXTENSION_TYPE_NON_TRANSFERABLE: u16 = 9;
const EXTENSION_TYPE_PERMANENT_DELEGATE: u16 = 12;
const EXTENSION_TYPE_TRANSFER_HOOK: u16 = 14;
const EXTENSION_TYPE_PAUSABLE: u16 = 26;

const TLV_EXTENSIONS_START: usize = 166;

/// Validates that a Token-2022 mint does not contain any blocked extensions.
///
/// Walks the TLV extension entries starting at byte 166 and rejects mints
/// that have ConfidentialTransfer, NonTransferable, PermanentDelegate,
/// TransferHook, TransferFee, MintCloseAuthority, or Pausable extensions.
fn validate_mint_extensions(data: &[u8]) -> Result<(), ProgramError> {
    let mut offset = TLV_EXTENSIONS_START;

    while offset + 4 <= data.len() {
        let ext_type = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let ext_len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;

        // Type 0 = Uninitialized, signals end of TLV entries
        if ext_type == 0 {
            break;
        }

        match ext_type {
            EXTENSION_TYPE_TRANSFER_FEE_CONFIG => {
                return Err(SubscriptionsError::MintHasTransferFee.into());
            }
            EXTENSION_TYPE_MINT_CLOSE_AUTHORITY => {
                return Err(SubscriptionsError::MintHasMintCloseAuthority.into());
            }
            EXTENSION_TYPE_CONFIDENTIAL_TRANSFER_MINT => {
                return Err(SubscriptionsError::MintHasConfidentialTransfer.into());
            }
            EXTENSION_TYPE_NON_TRANSFERABLE => {
                return Err(SubscriptionsError::MintHasNonTransferable.into());
            }
            EXTENSION_TYPE_PERMANENT_DELEGATE => {
                return Err(SubscriptionsError::MintHasPermanentDelegate.into());
            }
            EXTENSION_TYPE_TRANSFER_HOOK => {
                return Err(SubscriptionsError::MintHasTransferHook.into());
            }
            EXTENSION_TYPE_PAUSABLE => {
                return Err(SubscriptionsError::MintHasPausable.into());
            }
            _ => {}
        }

        offset += 4 + ext_len;
    }

    Ok(())
}

// Private helpers to consolidate initialization logic

fn init_mint_helper(
    account: &AccountView,
    payer: &AccountView,
    decimals: u8,
    mint_authority: &Address,
    freeze_authority: Option<&Address>,
    owner_program_id: &Address,
) -> ProgramResult {
    let lamports = Rent::get()?.try_minimum_balance(Mint::LEN)?;

    CreateAccount {
        from: payer,
        to: account,
        lamports,
        space: Mint::LEN as u64,
        owner: owner_program_id,
    }
    .invoke()?;

    InitializeMint2 {
        mint: account,
        decimals,
        mint_authority,
        freeze_authority,
    }
    .invoke()
}

fn init_token_helper(
    account: &AccountView,
    mint: &AccountView,
    payer: &AccountView,
    owner: &Address,
    owner_program_id: &Address,
) -> ProgramResult {
    let lamports = Rent::get()?.try_minimum_balance(TokenAccountState::LEN)?;

    CreateAccount {
        from: payer,
        to: account,
        lamports,
        space: TokenAccountState::LEN as u64,
        owner: owner_program_id,
    }
    .invoke()?;

    InitializeAccount3 {
        account,
        mint,
        owner,
    }
    .invoke()
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

        Ok(())
    }
}

impl MintInit for MintAccount {
    fn init(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult {
        init_mint_helper(
            account,
            payer,
            decimals,
            mint_authority,
            freeze_authority,
            &pinocchio_token::ID,
        )
    }

    fn init_if_needed(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult {
        match Self::check(account) {
            Ok(_) => Ok(()),
            Err(_) => Self::init(account, payer, decimals, mint_authority, freeze_authority),
        }
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

impl TokenInit for TokenAccount {
    fn init(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult {
        init_token_helper(account, mint, payer, owner, &pinocchio_token::ID)
    }

    fn init_if_needed(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult {
        match Self::check(account) {
            Ok(_) => Ok(()),
            Err(_) => Self::init(account, mint, payer, owner),
        }
    }
}

// Mint2022Account

/// Validation for Token-2022 mint accounts.
///
/// Checks ownership by the Token-2022 program, minimum data length, the
/// `0x01` discriminator at byte 165, and rejects blocked extensions via
/// [`validate_mint_extensions`].
pub struct Mint2022Account;

impl AccountCheck for Mint2022Account {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&crate::constants::TOKEN_2022_PROGRAM_ID) {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        if account.data_len() == Mint::LEN {
            return Ok(());
        }

        let data = account.try_borrow()?;

        if data[TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET].ne(&TOKEN_2022_MINT_DISCRIMINATOR) {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        validate_mint_extensions(&data)?;

        Ok(())
    }
}

impl MintInit for Mint2022Account {
    fn init(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult {
        init_mint_helper(
            account,
            payer,
            decimals,
            mint_authority,
            freeze_authority,
            &crate::constants::TOKEN_2022_PROGRAM_ID,
        )
    }

    fn init_if_needed(
        account: &AccountView,
        payer: &AccountView,
        decimals: u8,
        mint_authority: &Address,
        freeze_authority: Option<&Address>,
    ) -> ProgramResult {
        match Self::check(account) {
            Ok(_) => Ok(()),
            Err(_) => Self::init(account, payer, decimals, mint_authority, freeze_authority),
        }
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

        if data[TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET].ne(&TOKEN_2022_TOKEN_ACCOUNT_DISCRIMINATOR)
        {
            return Err(SubscriptionsError::InvalidToken2022TokenAccountData.into());
        }

        Ok(())
    }
}

impl TokenInit for TokenAccount2022Account {
    fn init(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult {
        init_token_helper(
            account,
            mint,
            payer,
            owner,
            &crate::constants::TOKEN_2022_PROGRAM_ID,
        )
    }

    fn init_if_needed(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &Address,
    ) -> ProgramResult {
        match Self::check(account) {
            Ok(_) => Ok(()),
            Err(_) => Self::init(account, mint, payer, owner),
        }
    }
}

/// Unified validator that accepts either SPL Token or Token-2022 program accounts.
pub struct TokenProgramInterface;

impl TokenProgramInterface {
    pub fn check(account: &AccountView) -> Result<(), ProgramError> {
        if account.address().ne(&SPL_TOKEN_PROGRAM_ID)
            && account.address().ne(&TOKEN_2022_PROGRAM_ID)
        {
            return Err(SubscriptionsError::InvalidTokenProgram.into());
        }
        Ok(())
    }
}

/// Unified validator/initializer for mint accounts across both SPL Token and Token-2022.
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
    pub fn check_with_program(
        account: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError> {
        Self::check(account)?;

        if !account.owned_by(token_program.address()) {
            return Err(SubscriptionsError::InvalidTokenProgram.into());
        }

        Ok(())
    }
}

/// Unified validator/initializer for token accounts across both SPL Token and Token-2022.
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
    pub fn check_with_program(
        account: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError> {
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
            Self::check(account)?;

            if !account.owned_by(token_program.address()) {
                return Err(SubscriptionsError::InvalidTokenProgram.into());
            }
        }
        Ok(())
    }
}

/// Unified ATA check and creation for both SPL Token and Token-2022.
pub struct AssociatedTokenAccount;

impl AssociatedTokenAccount {
    /// Verifies that the given account is a valid ATA using the provided bump.
    /// This is cheaper than the trait method as it doesn't derive the bump.
    pub fn check_with_bump(
        account: &AccountView,
        authority: &AccountView,
        mint: &AccountView,
        token_program: &AccountView,
        bump: u8,
    ) -> Result<(), ProgramError> {
        TokenAccountInterface::check(account)?;

        let expected_pda = Address::create_program_address(
            &[
                authority.address().as_ref(),
                token_program.address().as_ref(),
                mint.address().as_ref(),
                &[bump],
            ],
            &pinocchio_associated_token_account::ID,
        )
        .map_err(|_| SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress)?;

        if expected_pda.ne(account.address()) {
            return Err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress.into());
        }

        Ok(())
    }
}

impl AssociatedTokenAccountCheck for AssociatedTokenAccount {
    fn check(
        account: &AccountView,
        authority: &AccountView,
        mint: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError> {
        TokenAccountInterface::check(account)?;

        if Address::find_program_address(
            &[
                authority.address().as_ref(),
                token_program.address().as_ref(),
                mint.address().as_ref(),
            ],
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

impl AssociatedTokenAccountInit for AssociatedTokenAccount {
    fn init(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &AccountView,
        system_program: &AccountView,
        token_program: &AccountView,
    ) -> ProgramResult {
        Create {
            funding_account: payer,
            account,
            wallet: owner,
            mint,
            system_program,
            token_program,
        }
        .invoke()
    }

    fn init_if_needed(
        account: &AccountView,
        mint: &AccountView,
        payer: &AccountView,
        owner: &AccountView,
        system_program: &AccountView,
        token_program: &AccountView,
    ) -> ProgramResult {
        match Self::check(account, owner, mint, token_program) {
            Ok(_) => Ok(()),
            Err(_) => Self::init(account, mint, payer, owner, system_program, token_program),
        }
    }
}
