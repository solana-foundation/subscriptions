use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::FixedTransferEvent,
    helpers::{
        get_token_account_owner, transfer_with_delegate, validate_fixed_transfer, Delegation,
        DelegationTransferAccounts, TransferAccounts, TransferData,
    },
    state::FixedDelegation,
    SubscriptionsError,
};

/// Instruction discriminator byte for `TransferFixed`.
pub const DISCRIMINATOR: &u8 = &4;

/// Executes a transfer against a [`FixedDelegation`].
///
/// Validates authorization and remaining allowance, decrements the delegation's
/// `amount`, performs the SPL token transfer via the [`SubscriptionAuthority`](crate::SubscriptionAuthority)
/// PDA, and emits a [`FixedTransferEvent`].
pub fn process(accounts: &[AccountView], transfer: &TransferData) -> ProgramResult {
    let accounts_struct = DelegationTransferAccounts::try_from(accounts)?;

    let remaining_amount: u64;
    let delegatee_address: Address;
    let init_id: i64;
    {
        let mut binding = accounts_struct.delegation_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let delegation = FixedDelegation::load_mut(&mut binding)?;

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

    let receiver_owner: Address = {
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        get_token_account_owner(&receiver_data)?
    };

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
