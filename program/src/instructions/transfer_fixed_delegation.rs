use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    check_and_update_version,
    constants::{TOKEN_ACCOUNT_OWNER_END, TOKEN_ACCOUNT_OWNER_OFFSET},
    event_engine::{self, EventSerialize},
    events::FixedTransferEvent,
    helpers::{transfer_with_delegate, validate_fixed_transfer, Delegation, TransferAccounts, TransferData},
    state::FixedDelegation,
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionAuthorityAccount, SubscriptionsError,
    TokenAccountInterface, TokenProgramInterface, WritableAccount,
};

/// Instruction discriminator byte for `TransferFixed`.
pub const DISCRIMINATOR: &u8 = &4;

/// Executes a transfer against a [`FixedDelegation`].
///
/// Validates authorization and remaining allowance, decrements the delegation's
/// `amount`, performs the SPL token transfer via the [`SubscriptionAuthority`](crate::SubscriptionAuthority)
/// PDA, and emits a [`FixedTransferEvent`].
pub fn process(accounts: &[AccountView], transfer: &TransferData) -> ProgramResult {
    let accounts_struct = FixedTransferAccounts::try_from(accounts)?;

    let remaining_amount: u64;
    let delegatee_address: Address;
    let init_id: i64;
    {
        let mut binding = accounts_struct.delegation_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let delegation = FixedDelegation::load_mut(&mut binding)?;

        // Fail fast: Check authorization first
        Delegation::check(&delegation.header, &transfer.delegator, accounts_struct.delegatee.address())?;
        if delegation.subscription_authority != *accounts_struct.subscription_authority.address() {
            return Err(SubscriptionsError::InvalidDelegatePda.into());
        }
        if delegation.mint != transfer.mint {
            return Err(SubscriptionsError::MintMismatch.into());
        }

        delegatee_address = *accounts_struct.delegatee.address();

        let current_ts = Clock::get()?.unix_timestamp;
        validate_fixed_transfer(transfer.amount, delegation.amount, delegation.expiry_ts, current_ts)?;

        delegation.amount =
            delegation.amount.checked_sub(transfer.amount).ok_or(SubscriptionsError::ArithmeticUnderflow)?;

        remaining_amount = delegation.amount;
        init_id = delegation.header.init_id;
    }

    // Extract receiver owner from token account data
    let receiver_owner: Address;
    {
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        if receiver_data.len() < TOKEN_ACCOUNT_OWNER_END {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        let mut owner_bytes = [0u8; 32];
        owner_bytes.copy_from_slice(&receiver_data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_END]);
        receiver_owner = Address::from(owner_bytes);
    }

    transfer_with_delegate(
        transfer.amount,
        &transfer.delegator,
        &transfer.mint,
        init_id,
        &TransferAccounts {
            delegator_ata: accounts_struct.delegator_ata,
            to_ata: accounts_struct.receiver_ata,
            subscription_authority_pda: accounts_struct.subscription_authority,
            token_program: accounts_struct.token_program,
        },
    )?;

    // Emit FixedTransferEvent via self-CPI
    let event = FixedTransferEvent::new(
        *accounts_struct.delegation_pda.address(),
        transfer.delegator,
        delegatee_address,
        transfer.mint,
        transfer.amount,
        remaining_amount,
        receiver_owner,
    );
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}

/// Validated accounts for the [`TransferFixed`](crate::SubscriptionsInstruction::TransferFixed) instruction.
pub struct FixedTransferAccounts<'a> {
    pub delegation_pda: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    pub delegator_ata: &'a AccountView,
    pub receiver_ata: &'a AccountView,
    pub token_program: &'a AccountView,
    pub delegatee: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for FixedTransferAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [delegation_pda, subscription_authority, delegator_ata, receiver_ata, token_program, delegatee, event_authority, self_program] =
            accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        ProgramAccount::check(delegation_pda)?;
        WritableAccount::check(delegation_pda)?;
        WritableAccount::check(delegator_ata)?;
        WritableAccount::check(receiver_ata)?;
        SubscriptionAuthorityAccount::check(subscription_authority)?;
        TokenProgramInterface::check(token_program)?;
        TokenAccountInterface::check_accounts_with_program(token_program, &[delegator_ata, receiver_ata])?;
        SignerAccount::check(delegatee)?;

        Ok(Self {
            delegation_pda,
            subscription_authority,
            delegator_ata,
            receiver_ata,
            token_program,
            delegatee,
            event_authority,
            self_program,
        })
    }
}
