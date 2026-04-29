use crate::{
    check_and_update_version,
    constants::{TOKEN_ACCOUNT_OWNER_END, TOKEN_ACCOUNT_OWNER_OFFSET},
    event_engine::{self, EventSerialize},
    events::RecurringTransferEvent,
    helpers::{
        transfer_with_delegate, validate_recurring_transfer, Delegation, TransferAccounts,
        TransferData,
    },
    state::RecurringDelegation,
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionAuthorityAccount, SubscriptionsError,
    TokenAccountInterface, TokenProgramInterface, WritableAccount,
};
use pinocchio::{
    error::ProgramError,
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
pub fn process(accounts: &[AccountView], transfer_data: &TransferData) -> ProgramResult {
    let accounts_struct = RecurringTransferAccounts::try_from(accounts)?;

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

        // Fail fast: Check authorization first
        Delegation::check(
            &delegation_mut.header,
            &transfer_data.delegator,
            accounts_struct.delegatee.address(),
        )?;
        if delegation_mut.subscription_authority
            != *accounts_struct.subscription_authority.address()
        {
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

    // Extract receiver owner from token account data
    let receiver_owner: Address;
    {
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        if receiver_data.len() < TOKEN_ACCOUNT_OWNER_END {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        let mut owner_bytes = [0u8; 32];
        owner_bytes
            .copy_from_slice(&receiver_data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_END]);
        receiver_owner = Address::from(owner_bytes);
    }

    transfer_with_delegate(
        transfer_data.amount,
        &transfer_data.delegator,
        &transfer_data.mint,
        init_id,
        &TransferAccounts {
            delegator_ata: accounts_struct.delegator_ata,
            to_ata: accounts_struct.receiver_ata,
            subscription_authority_pda: accounts_struct.subscription_authority,
            token_program: accounts_struct.token_program,
        },
    )?;

    // Emit RecurringTransferEvent via self-CPI
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
    );
    let event_data = event.to_bytes();
    event_engine::emit_event(
        &crate::ID,
        accounts_struct.event_authority,
        accounts_struct.self_program,
        &event_data,
    )?;

    Ok(())
}

/// Validated accounts for the [`TransferRecurring`](crate::SubscriptionsInstruction::TransferRecurring) instruction.
pub struct RecurringTransferAccounts<'a> {
    pub delegation_pda: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    pub delegator_ata: &'a AccountView,
    pub receiver_ata: &'a AccountView,
    pub token_program: &'a AccountView,
    pub delegatee: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for RecurringTransferAccounts<'a> {
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
        TokenAccountInterface::check_accounts_with_program(
            token_program,
            &[delegator_ata, receiver_ata],
        )?;
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

#[cfg(test)]
mod tests {
    use crate::{
        event_engine::event_authority_pda,
        instructions::transfer_recurring_delegation,
        state::{header::VERSION_OFFSET, RecurringDelegation},
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, PROGRAM_ID, TOKEN_PROGRAM_ID},
            idl,
            pda::get_subscription_authority_pda,
            utils::{
                build_and_send_transaction, current_ts, days, get_ata_balance, hours, init_ata,
                init_aux_token_account, init_mint, init_wallet,
                initialize_subscription_authority_action, minutes, move_clock_forward, setup,
                CloseSubscriptionAuthority, CreateDelegation, TransferDelegation,
            },
        },
        SubscriptionsError,
    };
    use litesvm::LiteSVM;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;
    use solana_transaction_error::TransactionError::InstructionError;
    use spl_associated_token_account::get_associated_token_address_with_program_id;
    use spl_token::instruction::TokenInstruction::{Approve, Revoke};

    fn setup_recurring_delegation(
        amount_per_period: u64,
        period_length_s: u64,
        start_ts: i64,
        expiry_ts: i64,
        nonce: u64,
    ) -> (
        LiteSVM,
        Keypair,
        Keypair,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
    ) {
        let (mut litesvm, alice) = setup();
        let bob = Keypair::new();
        litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

        let mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
        let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

        let init_result = initialize_subscription_authority_action(&mut litesvm, &alice, mint);
        init_result.0.assert_ok();

        let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
            .nonce(nonce)
            .recurring(amount_per_period, period_length_s, start_ts, expiry_ts);
        res.assert_ok();

        (
            litesvm,
            alice,
            bob,
            delegation_pda,
            mint,
            alice_ata,
            bob_ata,
            init_result.1,
        )
    }

    #[test]
    fn test_recurring_transfer_success() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        let transfer_amount: u64 = 10_000_000;
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = RecurringDelegation::load(&delegation_account.data).unwrap();
        let delegation_amount_pulled_in_period = delegation.amount_pulled_in_period;
        let delegation_current_period_start_ts = delegation.current_period_start_ts;
        let delegation_period_length_s = delegation.period_length_s;
        assert_eq!(delegation_amount_pulled_in_period, 10_000_000);
        assert_eq!(delegation_current_period_start_ts, start_ts);
        assert_eq!(delegation_period_length_s, period_length_s);

        move_clock_forward(&mut litesvm, minutes(15));

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 20_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = RecurringDelegation::load(&delegation_account.data).unwrap();
        let delegation_amount_pulled_in_period = delegation.amount_pulled_in_period;
        assert_eq!(delegation_amount_pulled_in_period, 20_000_000);

        move_clock_forward(&mut litesvm, minutes(15));

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = RecurringDelegation::load(&delegation_account.data).unwrap();
        let delegation_amount_pulled_in_period = delegation.amount_pulled_in_period;
        assert_eq!(delegation_amount_pulled_in_period, 30_000_000);
    }

    #[test]
    fn test_recurring_transfer_exceeds_period_limit() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 1;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        move_clock_forward(&mut litesvm, period_length_s + 1);

        let transfer_amount: u64 = 60_000_000;
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(transfer_amount)
                .recurring();

        result.assert_err(SubscriptionsError::AmountExceedsPeriodLimit);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
    }

    #[test]
    fn test_recurring_transfer_expired() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 1;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        let transfer_amount: u64 = 30_000_000;
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(transfer_amount)
                .recurring();
        result.assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

        // Now let's move the clock and try to transfer again
        move_clock_forward(&mut litesvm, (current_ts() + (days(2) as i64)) as u64);

        let transfer_amount: u64 = 30_000_000;
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(transfer_amount)
                .recurring();
        result.assert_err(SubscriptionsError::DelegationExpired);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);
    }

    #[test]
    fn test_recurring_transfer_multiple_periods() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 1;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(30_000_000)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation_amount_pulled_in_period =
            RecurringDelegation::load(&delegation_account.data)
                .unwrap()
                .amount_pulled_in_period;
        assert_eq!(delegation_amount_pulled_in_period, 30_000_000);

        // Move forward until new time period
        move_clock_forward(&mut litesvm, period_length_s);

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(30_000_000)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 60_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation_amount_pulled_in_period =
            RecurringDelegation::load(&delegation_account.data)
                .unwrap()
                .amount_pulled_in_period;
        assert_eq!(delegation_amount_pulled_in_period, 30_000_000);
    }

    #[test]
    fn test_recurring_transfer_skip_multiple_periods() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 2;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        // Period 0: Transfer 10M
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(10_000_000)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);

        // Move forward 3 periods
        move_clock_forward(&mut litesvm, period_length_s * 3);

        // Period 3: Transfer 10M
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(10_000_000)
            .recurring()
            .assert_ok();

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 20_000_000);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = RecurringDelegation::load(&delegation_account.data).unwrap();

        // New start should be start_ts + 3 * period
        let expected_start = start_ts + (period_length_s * 3) as i64;
        let actual_start = delegation.current_period_start_ts;
        let actual_pulled = delegation.amount_pulled_in_period;

        assert_eq!(actual_start, expected_start);
        assert_eq!(actual_pulled, 10_000_000);
    }

    #[test]
    fn test_recurring_transfer_skip_period_cannot_double_claim() {
        // Bug hypothesis: after skipping one period with no claims, the delegatee
        // can claim twice (2x amount_per_period) in the next period.
        //
        // Scenario:
        //   Period 0: claim full allowance
        //   Period 1: no claims (skipped)
        //   Period 2 start: claim full allowance, then immediately try again
        //
        // Expected: second claim in period 2 should fail — skipped periods
        // do not accumulate allowance.
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(7) as i64;
        let nonce = 3;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        // Period 0: Use the full allowance
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(amount_per_period)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 50_000_000);

        // Skip period 1 entirely — advance exactly to the start of period 2
        move_clock_forward(&mut litesvm, period_length_s * 2);

        // Period 2, transfer 1: claim full allowance — should succeed
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(amount_per_period)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 100_000_000);

        // Period 2, transfer 2: immediately try to claim again — should fail
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(amount_per_period)
                .recurring();
        result.assert_err(SubscriptionsError::AmountExceedsPeriodLimit);

        // Balances unchanged after failed transfer
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 100_000_000);

        // Verify delegation state
        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = RecurringDelegation::load(&delegation_account.data).unwrap();
        let actual_pulled = delegation.amount_pulled_in_period;
        let actual_start = delegation.current_period_start_ts;
        assert_eq!(actual_pulled, amount_per_period);
        let expected_start = start_ts + (period_length_s * 2) as i64;
        assert_eq!(actual_start, expected_start);
    }

    #[test]
    fn recurring_delegation_rejects_transfer_with_different_mint_authority() {
        let (mut litesvm, alice) = setup();
        let bob = Keypair::new();
        litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

        let low_value_mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        let high_value_mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );

        let _alice_low_ata = init_ata(&mut litesvm, low_value_mint, alice.pubkey(), 100_000_000);
        let alice_high_ata = init_ata(&mut litesvm, high_value_mint, alice.pubkey(), 100_000_000);
        let _bob_low_ata = init_ata(&mut litesvm, low_value_mint, bob.pubkey(), 0);
        let bob_high_ata = init_ata(&mut litesvm, high_value_mint, bob.pubkey(), 0);

        initialize_subscription_authority_action(&mut litesvm, &alice, low_value_mint)
            .0
            .assert_ok();
        initialize_subscription_authority_action(&mut litesvm, &alice, high_value_mint)
            .0
            .assert_ok();

        let amount_per_period = 50_000_000;
        let period_length_s = hours(1);
        let start_ts = current_ts();
        let expiry_ts = start_ts + days(1) as i64;
        let (res, low_value_delegation_pda) =
            CreateDelegation::new(&mut litesvm, &alice, low_value_mint, bob.pubkey())
                .nonce(7)
                .recurring(amount_per_period, period_length_s, start_ts, expiry_ts);
        res.assert_ok();

        TransferDelegation::new(
            &mut litesvm,
            &bob,
            alice.pubkey(),
            high_value_mint,
            low_value_delegation_pda,
        )
        .amount(10_000_000)
        .recurring()
        .assert_err(SubscriptionsError::InvalidDelegatePda);

        assert_eq!(get_ata_balance(&litesvm, &alice_high_ata), 100_000_000);
        assert_eq!(get_ata_balance(&litesvm, &bob_high_ata), 0);

        let delegation_account = litesvm.get_account(&low_value_delegation_pda).unwrap();
        let amount_pulled = RecurringDelegation::load(&delegation_account.data)
            .unwrap()
            .amount_pulled_in_period;
        assert_eq!(amount_pulled, 0);
    }

    #[test]
    fn recurring_transfer_rejects_approved_non_canonical_source() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (
            mut litesvm,
            alice,
            bob,
            delegation_pda,
            mint,
            alice_ata,
            bob_ata,
            subscription_authority_pda,
        ) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );

        let alice_aux = init_aux_token_account(&mut litesvm, mint, alice.pubkey(), 100_000_000);
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(alice_aux, false),
                AccountMeta::new(subscription_authority_pda, false),
                AccountMeta::new(alice.pubkey(), true),
            ],
            data: Approve { amount: u64::MAX }.pack(),
        };
        build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix).assert_ok();

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .from(alice_aux)
            .amount(10_000_000)
            .recurring()
            .assert_err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress);

        assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
        assert_eq!(get_ata_balance(&litesvm, &alice_aux), 100_000_000);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
        let amount_pulled = RecurringDelegation::load(&delegation_account.data)
            .unwrap()
            .amount_pulled_in_period;
        assert_eq!(amount_pulled, 0);
    }

    #[test]
    fn writable_accounts_must_be_writable() {
        let writable = idl::writable_account_indices("transferRecurring");

        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, _, _) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );
        let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

        let (subscription_authority_pda, _) =
            get_subscription_authority_pda(&alice.pubkey(), &mint);
        let delegator_ata =
            get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
        let receiver_ata =
            get_associated_token_address_with_program_id(&bob.pubkey(), &mint, &TOKEN_PROGRAM_ID);
        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        for (idx, _name, is_signer) in &writable {
            let mut accounts = vec![
                AccountMeta::new(delegation_pda, false),
                AccountMeta::new_readonly(subscription_authority_pda, false),
                AccountMeta::new(delegator_ata, false),
                AccountMeta::new(receiver_ata, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(bob.pubkey(), true),
                AccountMeta::new_readonly(event_authority, false),
                AccountMeta::new_readonly(PROGRAM_ID, false),
            ];

            // Flip writable account to readonly, preserving signer flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

            let transfer_amount: u64 = 10_000_000;
            let data = [
                vec![*transfer_recurring_delegation::DISCRIMINATOR],
                transfer_amount.to_le_bytes().to_vec(),
                alice.pubkey().to_bytes().to_vec(),
                mint.to_bytes().to_vec(),
            ]
            .concat();

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data,
            };

            let res = build_and_send_transaction(
                &mut litesvm,
                &[&fee_payer, &bob],
                &fee_payer.pubkey(),
                &ix,
            );
            res.assert_err(SubscriptionsError::AccountNotWritable);
        }
    }

    #[test]
    fn signer_accounts_must_be_signers() {
        let signers = idl::signer_account_indices("transferRecurring");

        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, _, _) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );
        let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

        let (subscription_authority_pda, _) =
            get_subscription_authority_pda(&alice.pubkey(), &mint);
        let delegator_ata =
            get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
        let receiver_ata =
            get_associated_token_address_with_program_id(&bob.pubkey(), &mint, &TOKEN_PROGRAM_ID);
        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        for (idx, _name, is_writable) in &signers {
            let mut accounts = vec![
                AccountMeta::new(delegation_pda, false),
                AccountMeta::new_readonly(subscription_authority_pda, false),
                AccountMeta::new(delegator_ata, false),
                AccountMeta::new(receiver_ata, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(bob.pubkey(), true),
                AccountMeta::new_readonly(event_authority, false),
                AccountMeta::new_readonly(PROGRAM_ID, false),
            ];

            // Flip signer to non-signer, preserving writable flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = if *is_writable {
                AccountMeta::new(pubkey, false)
            } else {
                AccountMeta::new_readonly(pubkey, false)
            };

            let transfer_amount: u64 = 10_000_000;
            let data = [
                vec![*transfer_recurring_delegation::DISCRIMINATOR],
                transfer_amount.to_le_bytes().to_vec(),
                alice.pubkey().to_bytes().to_vec(),
                mint.to_bytes().to_vec(),
            ]
            .concat();

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data,
            };

            let res =
                build_and_send_transaction(&mut litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
            res.assert_err(SubscriptionsError::NotSigner);
        }
    }

    #[test]
    fn test_recurring_transfer_delegator_mismatch_exploit() {
        // This test demonstrates the access control vulnerability where an attacker
        // can use their own delegation to transfer funds from another user's account

        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        // Setup: Alice (victim) with funds and Bob (attacker)
        let (mut litesvm, alice, bob, _alice_delegation_pda, mint, alice_ata, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        initialize_subscription_authority_action(&mut litesvm, &bob, mint)
            .0
            .assert_ok();

        // Attacker (Bob) creates a self-delegation (Bob -> Bob) with a large allowance
        let (_res, bob_delegation_pda) =
            CreateDelegation::new(&mut litesvm, &bob, mint, bob.pubkey())
                .nonce(nonce)
                .recurring(1_000_000_000, period_length_s, start_ts, expiry_ts);
        _res.assert_ok();

        let transfer_amount: u64 = 30_000_000;

        // Exploit: Attacker tries to transfer from Alice's ATA using their own delegation
        // by passing Alice's delegator_pubkey in the instruction data
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, bob_delegation_pda)
                .amount(transfer_amount)
                .to(bob_ata)
                .recurring();

        // After the fix, this should fail with Unauthorized error
        result.assert_err(SubscriptionsError::Unauthorized);

        // Verify Alice's funds are untouched
        assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
        // Verify Bob received no funds
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
    }

    #[test]
    fn test_recurring_transfer_token_revoke() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (
            mut litesvm,
            alice,
            bob,
            delegation_pda,
            mint,
            alice_ata,
            bob_ata,
            subscription_authority_pda,
        ) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(50_000_000)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 50_000_000);

        // Let's revoke the token approval
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(alice_ata, false),
                AccountMeta::new(alice.pubkey(), true),
            ],
            data: Revoke.pack(),
        };
        assert!(build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix).is_ok());

        // Now let's move the clock and try to fetch recurring delegation again
        move_clock_forward(&mut litesvm, period_length_s);

        // Now, let's try again
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(50_000_000)
                .recurring();
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().err,
            InstructionError(
                0,
                solana_instruction::error::InstructionError::Custom(
                    spl_token::error::TokenError::OwnerMismatch as u32
                ),
            )
        );

        // Doing approval once again fixes it, but it has to be max possible for it to work

        // Scenario 1: We approve, but less amount
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(alice_ata, false),
                AccountMeta::new(subscription_authority_pda, false),
                AccountMeta::new(alice.pubkey(), true),
            ],
            data: Approve { amount: 100000 }.pack(),
        };
        assert!(build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix).is_ok());

        // Since the approval amount is less than what is needed, we fail again
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(50_000_000)
                .recurring();
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().err,
            InstructionError(
                0,
                solana_instruction::error::InstructionError::Custom(
                    spl_token::error::TokenError::InsufficientFunds as u32
                ),
            )
        );

        // Scenario 2: We approve for max amount. Now it should work as usual
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(alice_ata, false),
                AccountMeta::new(subscription_authority_pda, false),
                AccountMeta::new(alice.pubkey(), true),
            ],
            data: Approve { amount: u64::MAX }.pack(),
        };
        assert!(build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix).is_ok());

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(50_000_000)
            .recurring()
            .assert_ok();
    }

    #[test]
    fn test_recurring_transfer_to_third_party() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        // Alice delegates to Bob
        let (mut litesvm, alice, bob, delegation_pda, mint, _, _, _) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );

        // Charlie is a third party
        let charlie = Keypair::new();
        let charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 0);

        let transfer_amount: u64 = 10_000_000;

        // Bob transfers from Alice -> Charlie
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .to(charlie_ata)
            .recurring()
            .assert_ok();

        // Verify Charlie received funds
        assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 10_000_000);
    }

    #[test]
    fn test_recurring_transfer_version_mismatch() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        let mut account = litesvm.get_account(&delegation_pda).unwrap();
        account.data[VERSION_OFFSET] = 0;
        litesvm.set_account(delegation_pda, account).unwrap();

        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(10_000_000)
                .recurring();

        result.assert_err(SubscriptionsError::MigrationRequired);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
    }

    #[test]
    fn test_recurring_transfer_stale_subscription_authority() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s = days(1);
        let start_ts = current_ts();
        let expiry_ts = current_ts() + days(30) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, alice_ata, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        CloseSubscriptionAuthority::new(&mut litesvm, &alice, mint)
            .execute()
            .assert_ok();

        move_clock_forward(&mut litesvm, 2);

        initialize_subscription_authority_action(&mut litesvm, &alice, mint)
            .0
            .assert_ok();

        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(10_000_000)
                .recurring();

        result.assert_err(SubscriptionsError::StaleSubscriptionAuthority);
        assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
    }

    #[test]
    fn test_recurring_transfer_not_started() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts() + hours(1) as i64;
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        let transfer_amount: u64 = 10_000_000;
        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(transfer_amount)
                .recurring();
        result.assert_err(SubscriptionsError::DelegationNotStarted);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

        move_clock_forward(&mut litesvm, hours(1) + 1);

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), transfer_amount);
    }

    #[test]
    fn test_recurring_transfer_within_drift_window() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + hours(1) as i64;
        let nonce = 0;
        let transfer_amount = 10_000_000;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, _, _) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );

        move_clock_forward(&mut litesvm, hours(1) + 60);

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .recurring()
            .assert_ok();
    }

    #[test]
    fn test_recurring_rollover_blocked_at_expiry_boundary() {
        let amount_per_period: u64 = 1_000_000;
        let period_length_s: u64 = 1;
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = start_ts + period_length_s as i64;
        let nonce = 0;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata, _) =
            setup_recurring_delegation(
                amount_per_period,
                period_length_s,
                start_ts,
                expiry_ts,
                nonce,
            );

        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
            .amount(amount_per_period)
            .recurring()
            .assert_ok();
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), amount_per_period);

        move_clock_forward(&mut litesvm, period_length_s);

        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(amount_per_period)
                .recurring();
        result.assert_err(SubscriptionsError::AmountExceedsPeriodLimit);
        assert_eq!(get_ata_balance(&litesvm, &bob_ata), amount_per_period);
    }

    #[test]
    fn test_recurring_transfer_past_drift_window() {
        let amount_per_period: u64 = 50_000_000;
        let period_length_s: u64 = hours(1);
        let start_ts: i64 = current_ts();
        let expiry_ts: i64 = current_ts() + hours(1) as i64;
        let nonce = 0;
        let transfer_amount = 10_000_000;

        let (mut litesvm, alice, bob, delegation_pda, mint, _, _, _) = setup_recurring_delegation(
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
            nonce,
        );

        move_clock_forward(&mut litesvm, hours(1) + 121);

        let result =
            TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
                .amount(transfer_amount)
                .recurring();
        result.assert_err(SubscriptionsError::DelegationExpired);
    }
}
