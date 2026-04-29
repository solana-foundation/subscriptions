use pinocchio::{
    cpi::{Seed, Signer},
    AccountView, Address, ProgramResult,
};
use pinocchio_token_2022::instructions::Transfer;

use crate::{
    constants::{
        TOKEN_ACCOUNT_MINT_END, TOKEN_ACCOUNT_MINT_OFFSET, TOKEN_ACCOUNT_OWNER_END, TOKEN_ACCOUNT_OWNER_OFFSET,
    },
    SubscriptionAuthority, SubscriptionsError,
};

/// Verifies that the token account's owner field matches `expected`.
pub fn check_token_account_owner(data: &[u8], expected: &Address) -> Result<(), SubscriptionsError> {
    if data.len() < TOKEN_ACCOUNT_OWNER_END {
        return Err(SubscriptionsError::InvalidAccountData);
    }
    if data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_END] != expected.as_ref()[..] {
        return Err(SubscriptionsError::Unauthorized);
    }
    Ok(())
}

/// Verifies that the token account's mint field matches `expected`.
pub fn check_token_account_mint(data: &[u8], expected: &Address) -> Result<(), SubscriptionsError> {
    if data.len() < TOKEN_ACCOUNT_MINT_END {
        return Err(SubscriptionsError::InvalidAccountData);
    }
    if data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_MINT_END] != expected.as_ref()[..] {
        return Err(SubscriptionsError::MintMismatch);
    }
    Ok(())
}

/// Reads the owner pubkey from raw SPL token account data.
pub fn get_token_account_owner(data: &[u8]) -> Result<Address, SubscriptionsError> {
    if data.len() < TOKEN_ACCOUNT_OWNER_END {
        return Err(SubscriptionsError::InvalidAccountData);
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_END]);
    Ok(Address::from(owner))
}

/// Accounts required to execute a delegated token transfer.
pub struct TransferAccounts<'a> {
    /// The delegator's Associated Token Account (source).
    pub delegator_ata: &'a AccountView,
    /// The receiver's Associated Token Account (destination).
    pub to_ata: &'a AccountView,
    /// The [`SubscriptionAuthority`] PDA that is the SPL delegate on `delegator_ata`.
    pub subscription_authority_pda: &'a AccountView,
    /// The token program (SPL Token or Token-2022).
    pub token_program: &'a AccountView,
}

/// Executes an SPL Token transfer using the [`SubscriptionAuthority`] PDA as the delegate signer.
///
/// Reads the PDA bump from the [`SubscriptionAuthority`] account data, verifies the
/// delegator and mint match, validates both token accounts, and performs the
/// `Transfer` CPI signed by the SubscriptionAuthority PDA.
pub fn transfer_with_delegate(
    amount: u64,
    delegator: &Address,
    mint: &Address,
    init_id: i64,
    accounts: &TransferAccounts,
) -> ProgramResult {
    let bump = {
        // Read the bump from the SubscriptionAuthority account data (cheaper than find_program_address)
        let subscription_authority_data = accounts.subscription_authority_pda.try_borrow()?;
        let subscription_authority = SubscriptionAuthority::load(&subscription_authority_data)?;

        // Verify that the SubscriptionAuthority account matches the provided delegator and mint.
        // Since the account is owned by the program (checked in instruction processor),
        // we can trust its data. If the data matches, it is the correct PDA.
        if subscription_authority.user != *delegator || subscription_authority.token_mint != *mint {
            return Err(SubscriptionsError::InvalidDelegatePda.into());
        }
        if subscription_authority.init_id != init_id {
            return Err(SubscriptionsError::StaleSubscriptionAuthority.into());
        }
        subscription_authority.bump
    };

    {
        let ata_data = accounts.delegator_ata.try_borrow()?;
        check_token_account_owner(&ata_data, delegator)?;
        check_token_account_mint(&ata_data, mint)?;
    }
    let expected_ata = Address::find_program_address(
        &[delegator.as_ref(), accounts.token_program.address().as_ref(), mint.as_ref()],
        &pinocchio_associated_token_account::ID,
    )
    .0;
    if expected_ata != *accounts.delegator_ata.address() {
        return Err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress.into());
    }

    {
        let to_data = accounts.to_ata.try_borrow()?;
        check_token_account_mint(&to_data, mint)?;
    }

    let bump_bytes = [bump];
    let seeds = [
        Seed::from(SubscriptionAuthority::SEED),
        Seed::from(delegator.as_ref()),
        Seed::from(mint.as_ref()),
        Seed::from(&bump_bytes),
    ];
    let signer = [Signer::from(&seeds)];

    Transfer {
        from: accounts.delegator_ata,
        to: accounts.to_ata,
        authority: accounts.subscription_authority_pda,
        amount,
        token_program: accounts.token_program.address(),
    }
    .invoke_signed(&signer)?;

    Ok(())
}
