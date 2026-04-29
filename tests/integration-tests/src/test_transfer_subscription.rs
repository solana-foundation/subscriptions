use std::vec::Vec;

use crate::{
    event_engine::event_authority_pda,
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, TOKEN_PROGRAM_ID},
        pda::{get_plan_pda, get_subscription_authority_pda},
        utils::{
            build_and_send_transaction, current_ts, days, get_ata_balance, hours, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, move_clock_forward, setup, CancelSubscription, CreatePlan,
            CreateSubscription, DeletePlan, TransferSubscription, UpdatePlan,
        },
    },
    SubscriptionsError,
};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_associated_token_account::get_associated_token_address_with_program_id;

#[allow(clippy::type_complexity)]
fn setup_plan_and_subscription(
    amount_per_period: u64,
    period_hours: u64,
    end_ts: i64,
    destinations: Vec<Pubkey>,
    pullers: Vec<Pubkey>,
) -> (
    LiteSVM,
    Keypair, // alice (subscriber)
    Keypair, // merchant (plan owner)
    Pubkey,  // mint
    Pubkey,  // plan_pda
    u8,      // plan_bump
    Pubkey,  // subscription_pda
    Pubkey,  // alice_ata
    Pubkey,  // merchant_ata
) {
    let (mut litesvm, alice) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let merchant_ata = init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    // Initialize subscription_authority for alice
    let init_result = initialize_subscription_authority_action(&mut litesvm, &alice, mint);
    init_result.0.assert_ok();

    // Create plan
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(amount_per_period)
        .period_hours(period_hours)
        .end_ts(end_ts)
        .destinations(destinations)
        .pullers(pullers)
        .execute();
    res.assert_ok();

    // Manually inject subscription delegation (use LiteSVM clock, not system time)
    let svm_ts = litesvm.get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>().unix_timestamp;
    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let plan_terms = plan.data.terms;
    let subscription_pda =
        CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts).terms(plan_terms).execute();

    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);

    (litesvm, alice, merchant, mint, plan_pda, plan_bump, subscription_pda, alice_ata, merchant_ata)
}

#[test]
fn test_transfer_subscription_success() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);

    let transfer_amount = 10_000_000u64;
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(transfer_amount)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);

    // Verify subscription state was updated
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let pulled = sub.amount_pulled_in_period;
    assert_eq!(pulled, 10_000_000);
}

#[test]
fn test_transfer_subscription_puller_authorized() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let puller = Keypair::new();

    let (mut litesvm, alice, _merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![puller.pubkey()]);

    litesvm.airdrop(&puller.pubkey(), 10_000_000_000).unwrap();

    let transfer_amount = 10_000_000u64;
    TransferSubscription::new(&mut litesvm, &puller, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(transfer_amount)
        .to(merchant_ata)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);
}

#[test]
fn test_transfer_subscription_unauthorized_caller() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, _merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    let random_signer = Keypair::new();
    litesvm.airdrop(&random_signer.pubkey(), 10_000_000_000).unwrap();

    let transfer_amount = 10_000_000u64;
    let result =
        TransferSubscription::new(&mut litesvm, &random_signer, alice.pubkey(), mint, subscription_pda, plan_pda)
            .amount(transfer_amount)
            .to(merchant_ata)
            .execute();

    result.assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn test_transfer_subscription_multiple_pulls_within_period() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // First pull
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(20_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 20_000_000);

    // Second pull
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(20_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 40_000_000);

    // Verify pulled amount
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let pulled = sub.amount_pulled_in_period;
    assert_eq!(pulled, 40_000_000);
}

#[test]
fn test_transfer_subscription_exceeds_period_limit() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(60_000_000)
        .execute();

    result.assert_err(SubscriptionsError::AmountExceedsPeriodLimit);
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);
}

#[test]
fn test_transfer_subscription_period_rollover() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Pull full period
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(50_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 50_000_000);

    // Move to next period
    move_clock_forward(&mut litesvm, hours(1));

    // Pull again in new period
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(30_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 80_000_000);

    // Verify pulled reset
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let pulled = sub.amount_pulled_in_period;
    assert_eq!(pulled, 30_000_000);
}

#[test]
fn test_transfer_subscription_plan_expired() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(2) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Move past plan expiry
    move_clock_forward(&mut litesvm, days(3));

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::PlanExpired);
}

#[test]
fn test_transfer_subscription_subscription_cancelled() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, _, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Create subscription with expires_at_ts set to end of a past period
    let period_start = current_ts() - hours(2) as i64;
    let expires_at = period_start + hours(1) as i64; // end of that period, which is in the past
    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let plan_terms = plan.data.terms;
    let subscription_pda = CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, period_start)
        .terms(plan_terms)
        .expires_at_ts(expires_at)
        .execute();

    // Current time is past expires_at_ts
    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::SubscriptionCancelled);
}

#[test]
fn test_transfer_subscription_cancelled_allows_current_period() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Cancel the subscription (sets expires_at_ts = end of current period)
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Pull within the same period should still succeed
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);
}

#[test]
fn test_transfer_subscription_cancelled_blocks_next_period() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Cancel the subscription
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Move clock past the period boundary
    move_clock_forward(&mut litesvm, hours(1));

    // Pull should now fail
    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::SubscriptionCancelled);
}

#[test]
fn test_transfer_subscription_destination_valid() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let dest_wallet = Keypair::new();

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![dest_wallet.pubkey()], vec![]);

    let dest_ata = init_ata(&mut litesvm, mint, dest_wallet.pubkey(), 0);

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(dest_ata)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &dest_ata), 10_000_000);
}

#[test]
fn test_transfer_subscription_destination_invalid() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let dest_wallet = Keypair::new();

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![dest_wallet.pubkey()], vec![]);

    // Send to merchant instead of whitelisted dest
    let merchant_ata = init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .execute();

    result.assert_err(SubscriptionsError::UnauthorizedDestination);
}

#[test]
fn test_transfer_subscription_no_destinations_any_receiver() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Random third party receives
    let charlie = Keypair::new();
    let charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 0);

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(charlie_ata)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 10_000_000);
}

#[test]
fn test_transfer_subscription_wrong_subscription_for_plan() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, _, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Create a second plan
    let (res, plan_pda_2) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(2)
        .amount(amount_per_period)
        .period_hours(period_hours)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    // Create subscription for plan 2
    let plan2_account = litesvm.get_account(&plan_pda_2).unwrap();
    let plan2 = Plan::load(&plan2_account.data).unwrap();
    let plan2_terms = plan2.data.terms;
    let subscription_for_plan2 = CreateSubscription::new(&mut litesvm, plan_pda_2, alice.pubkey(), mint, current_ts())
        .terms(plan2_terms)
        .execute();

    // Try to use subscription for plan 2 with plan 1
    let result = TransferSubscription::new(
        &mut litesvm,
        &merchant,
        alice.pubkey(),
        mint,
        subscription_for_plan2,
        plan_pda, // plan 1
    )
    .amount(10_000_000)
    .execute();

    result.assert_err(SubscriptionsError::SubscriptionPlanMismatch);
}

#[test]
fn test_transfer_subscription_zero_amount() {
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(0)
        .execute();

    result.assert_err(SubscriptionsError::InvalidAmount);
}

#[test]
fn test_transfer_subscription_sunset_allows_transfer() {
    // A sunset plan (status=0) should still allow existing subscription pulls.
    // The plan status doesn't block transfers; only end_ts and subscription expires_at_ts do.
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Manually set plan status to Sunset (0)
    let mut plan_account = litesvm.get_account(&plan_pda).unwrap();
    // Plan layout: discriminator(1) + owner(32) + bump(1) + status(1) + data(...)
    // status is at offset 34
    plan_account.data[34] = 0; // PlanStatus::Sunset
    litesvm.set_account(plan_pda, plan_account).unwrap();

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);
}

#[test]
fn test_transfer_subscription_plan_closed() {
    // When a Plan account is closed (zeroed + ownership transferred to system program),
    // the transfer must fail with PlanClosed rather than a generic error.
    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    // Simulate plan closure: zero the data and transfer ownership to system program
    let mut plan_account = litesvm.get_account(&plan_pda).unwrap();
    plan_account.data = vec![];
    plan_account.owner = solana_pubkey::Pubkey::default(); // system program
    litesvm.set_account(plan_pda, plan_account).unwrap();

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::PlanClosed);
}

#[test]
fn writable_accounts_must_be_writable() {
    use crate::{instructions::transfer_subscription, tests::idl};

    let writable = idl::writable_account_indices("transferSubscription");

    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);
    let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

    let (subscription_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegator_ata = get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let receiver_ata = get_associated_token_address_with_program_id(&merchant.pubkey(), &mint, &TOKEN_PROGRAM_ID);

    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

    for (idx, _name, is_signer) in &writable {
        let mut accounts = vec![
            AccountMeta::new(subscription_pda, false),
            AccountMeta::new_readonly(plan_pda, false),
            AccountMeta::new_readonly(subscription_authority_pda, false),
            AccountMeta::new(delegator_ata, false),
            AccountMeta::new(receiver_ata, false),
            AccountMeta::new_readonly(merchant.pubkey(), true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

        let transfer_amount: u64 = 10_000_000;
        let data = [
            vec![*transfer_subscription::DISCRIMINATOR],
            transfer_amount.to_le_bytes().to_vec(),
            alice.pubkey().to_bytes().to_vec(),
            mint.to_bytes().to_vec(),
        ]
        .concat();

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        let res = build_and_send_transaction(&mut litesvm, &[&fee_payer, &merchant], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::AccountNotWritable);
    }
}

#[test]
fn signer_accounts_must_be_signers() {
    use crate::{instructions::transfer_subscription, tests::idl};

    let signers = idl::signer_account_indices("transferSubscription");

    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);
    let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

    let (subscription_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegator_ata = get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let receiver_ata = get_associated_token_address_with_program_id(&merchant.pubkey(), &mint, &TOKEN_PROGRAM_ID);

    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

    for (idx, _name, is_writable) in &signers {
        let mut accounts = vec![
            AccountMeta::new(subscription_pda, false),
            AccountMeta::new_readonly(plan_pda, false),
            AccountMeta::new_readonly(subscription_authority_pda, false),
            AccountMeta::new(delegator_ata, false),
            AccountMeta::new(receiver_ata, false),
            AccountMeta::new_readonly(merchant.pubkey(), true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] =
            if *is_writable { AccountMeta::new(pubkey, false) } else { AccountMeta::new_readonly(pubkey, false) };

        let transfer_amount: u64 = 10_000_000;
        let data = [
            vec![*transfer_subscription::DISCRIMINATOR],
            transfer_amount.to_le_bytes().to_vec(),
            alice.pubkey().to_bytes().to_vec(),
            mint.to_bytes().to_vec(),
        ]
        .concat();

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        let res = build_and_send_transaction(&mut litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::NotSigner);
    }
}

#[test]
fn test_subscription_transfer_version_mismatch() {
    use crate::state::header::VERSION_OFFSET;

    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::MigrationRequired);
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);
}

#[test]
fn test_subscription_transfer_stale_subscription_authority() {
    use crate::tests::utils::{move_clock_forward, CloseSubscriptionAuthority};

    let amount_per_period = 50_000_000;
    let period_hours = 24;
    let end_ts = current_ts() + days(30) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, merchant_ata) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    CloseSubscriptionAuthority::new(&mut litesvm, &alice, mint).execute().assert_ok();

    move_clock_forward(&mut litesvm, 2);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::StaleSubscriptionAuthority);
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);
}

#[test]
fn test_transfer_subscription_ghost_plan_rejected() {
    use crate::state::common::PlanStatus;

    let amount_per_period = 50_000_000u64;
    let period_hours = 1u64;
    let end_ts = current_ts() + days(2) as i64;

    let (mut litesvm, alice, merchant, mint, plan_pda, _, subscription_pda, _, _) =
        setup_plan_and_subscription(amount_per_period, period_hours, end_ts, vec![], vec![]);

    UpdatePlan::new(&mut litesvm, &merchant, plan_pda).status(PlanStatus::Sunset).end_ts(end_ts).execute().assert_ok();

    move_clock_forward(&mut litesvm, days(3));

    DeletePlan::new(&mut litesvm, &merchant, plan_pda).execute().assert_ok();

    let new_end_ts = current_ts() + days(60) as i64;
    let (res, new_plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(999_000_000)
        .period_hours(720)
        .end_ts(new_end_ts)
        .execute();
    res.assert_ok();
    assert_eq!(plan_pda, new_plan_pda);

    let result = TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute();

    result.assert_err(SubscriptionsError::PlanTermsMismatch);
}
