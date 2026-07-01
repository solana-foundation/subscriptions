use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::UpToTransferEvent,
    helpers::{
        check_token_account_mint, get_token_account_owner, transfer_with_delegate, validate_up_to_transfer, Delegation,
        DelegationTransferAccounts, TransferAccounts, TransferData,
    },
    state::common::AccountDiscriminator,
    state::UpToDelegation,
    SubscriptionsError,
};

/// Instruction discriminator byte for `TransferUpTo`.
pub const DISCRIMINATOR: &u8 = &18;

/// Executes the single draw against an [`UpToDelegation`].
///
/// Validates authorization, the bound recipient, and the ceiling; moves
/// `actual <= max_amount` (possibly zero) to the recipient via the
/// [`SubscriptionAuthority`](crate::SubscriptionAuthority) PDA; consumes the
/// delegation by zeroing `max_amount`; and emits an [`UpToTransferEvent`].
pub fn process(accounts: &mut [AccountView], transfer: &TransferData) -> ProgramResult {
    let accounts_struct = DelegationTransferAccounts::try_from(accounts)?;

    let delegatee_address: Address;
    let recipient: Address;
    let init_id: i64;
    {
        let mut binding = accounts_struct.delegation_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding, AccountDiscriminator::UpToDelegation)?;
        let delegation = UpToDelegation::load_mut(&mut binding)?;

        Delegation::check(&delegation.header, &transfer.delegator, accounts_struct.delegatee.address())?;
        if delegation.subscription_authority != *accounts_struct.subscription_authority.address() {
            return Err(SubscriptionsError::InvalidDelegatePda.into());
        }
        if delegation.mint != transfer.mint {
            return Err(SubscriptionsError::MintMismatch.into());
        }

        delegatee_address = *accounts_struct.delegatee.address();
        recipient = delegation.recipient;

        let current_ts = Clock::get()?.unix_timestamp;
        validate_up_to_transfer(transfer.amount, delegation.max_amount, delegation.expiry_ts, current_ts)?;

        delegation.max_amount = UpToDelegation::CONSUMED_SENTINEL;

        init_id = delegation.header.init_id;
    }

    let receiver_owner: Address = {
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        check_token_account_mint(&receiver_data, &transfer.mint)?;
        get_token_account_owner(&receiver_data)?
    };
    if receiver_owner != recipient {
        return Err(SubscriptionsError::UpToRecipientMismatch.into());
    }

    if transfer.amount > 0 {
        transfer_with_delegate(
            transfer.amount,
            &transfer.delegator,
            &transfer.mint,
            init_id,
            &TransferAccounts {
                delegator_ata: accounts_struct.delegator_ata,
                to_ata: accounts_struct.receiver_ata,
                token_mint: accounts_struct.token_mint,
                subscription_authority_pda: accounts_struct.subscription_authority,
                token_program: accounts_struct.token_program,
            },
            accounts_struct.remaining,
        )?;
    }

    let event = UpToTransferEvent::new(
        *accounts_struct.delegation_pda.address(),
        transfer.delegator,
        delegatee_address,
        transfer.mint,
        transfer.amount,
        recipient,
        *accounts_struct.receiver_ata.address(),
    );
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}
