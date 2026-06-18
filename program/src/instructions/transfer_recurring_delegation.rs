use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::RecurringTransferEvent,
    helpers::{
        get_token_account_owner, transfer_with_delegate, validate_recurring_transfer, Delegation,
        DelegationTransferAccounts, TransferAccounts, TransferData,
    },
    state::RecurringDelegation,
    SubscriptionsError,
};
use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

/// Instruction discriminator byte for `TransferRecurring`.
pub const DISCRIMINATOR: &u8 = &5;

/// Executes a transfer against a [`RecurringDelegation`].
///
/// Validates authorization and per-period limits, advances the period if
/// necessary, performs the SPL token transfer via the [`SubscriptionAuthority`](crate::SubscriptionAuthority)
/// PDA, and emits a [`RecurringTransferEvent`].
pub fn process(accounts: &mut [AccountView], transfer_data: &TransferData) -> ProgramResult {
    let accounts_struct = DelegationTransferAccounts::try_from(accounts)?;

    let current_ts = Clock::get()?.unix_timestamp;
    let period_start: i64;
    let amount_pulled_in_period: u64;
    let period_length_s: u64;
    let delegatee_address: Address;
    let init_id: i64;
    {
        let mut binding = accounts_struct.delegation_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let delegation_mut = RecurringDelegation::load_mut(&mut binding)?;

        Delegation::check(&delegation_mut.header, &transfer_data.delegator, accounts_struct.delegatee.address())?;
        if delegation_mut.subscription_authority != *accounts_struct.subscription_authority.address() {
            return Err(SubscriptionsError::InvalidDelegatePda.into());
        }
        if delegation_mut.mint != transfer_data.mint {
            return Err(SubscriptionsError::MintMismatch.into());
        }

        delegatee_address = *accounts_struct.delegatee.address();
        period_length_s = delegation_mut.period_length_s;

        let mut ps = delegation_mut.current_period_start_ts;
        let mut pulled = delegation_mut.amount_pulled_in_period;
        validate_recurring_transfer(
            transfer_data.amount,
            delegation_mut.amount_per_period,
            delegation_mut.period_length_s,
            &mut ps,
            &mut pulled,
            delegation_mut.expiry_ts,
            current_ts,
        )?;
        delegation_mut.current_period_start_ts = ps;
        delegation_mut.amount_pulled_in_period = pulled;

        period_start = ps;
        amount_pulled_in_period = pulled;
        init_id = delegation_mut.header.init_id;
    }

    let receiver_owner: Address = {
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        get_token_account_owner(&receiver_data)?
    };

    transfer_with_delegate(
        transfer_data.amount,
        &transfer_data.delegator,
        &transfer_data.mint,
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

    let period_end_ts = period_start + period_length_s as i64;
    let event = RecurringTransferEvent::new(
        *accounts_struct.delegation_pda.address(),
        transfer_data.delegator,
        delegatee_address,
        transfer_data.mint,
        transfer_data.amount,
        period_start,
        period_end_ts,
        amount_pulled_in_period,
        receiver_owner,
        *accounts_struct.receiver_ata.address(),
    );
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}
