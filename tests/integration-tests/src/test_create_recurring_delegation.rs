use std::time::{SystemTime, UNIX_EPOCH};

use solana_pubkey::Pubkey;
use solana_signer::Signer;

use crate::tests::utils::current_ts;
use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            days, get_ata_balance, init_ata, init_mint, initialize_subscription_authority_action, move_clock_forward,
            setup, CloseSubscriptionAuthority, CreateDelegation, TransferDelegation,
        },
    },
    AccountDiscriminator, RecurringDelegation, SubscriptionsError,
};

#[test]
fn create_recurring_delegation() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 86400;
    let start_ts: i64 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let expiry_ts = start_ts + days(7) as i64;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();

    let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation = RecurringDelegation::load(&account.data).unwrap();

    let header = delegation.header;
    let del_amount_per_period = delegation.amount_per_period;
    let del_period_length_s = delegation.period_length_s;
    let del_expiry_s = delegation.expiry_ts;
    let del_amount_pulled_in_period = delegation.amount_pulled_in_period;
    let del_current_period_start_ts = delegation.current_period_start_ts;

    assert_eq!(header.delegator.to_bytes(), payer.pubkey().to_bytes());
    assert_eq!(header.delegatee.to_bytes(), delegatee.to_bytes());
    assert_eq!(header.payer.to_bytes(), payer.pubkey().to_bytes());
    assert_eq!(header.discriminator, AccountDiscriminator::RecurringDelegation as u8);
    assert_eq!(del_amount_per_period, amount_per_period);
    assert_eq!(del_period_length_s, period_length_s);
    assert_eq!(del_expiry_s, expiry_ts);
    assert_eq!(del_amount_pulled_in_period, 0);
    assert_eq!(del_current_period_start_ts, start_ts);
}

#[test]
fn create_recurring_delegation_rejects_stale_subscription_authority_generation() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 86400;
    let start_ts: i64 = current_ts();
    let expiry_ts = start_ts + days(7) as i64;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    let (_, subscription_authority_pda, _) = initialize_subscription_authority_action(litesvm, payer, mint);
    let old_init_id =
        crate::state::SubscriptionAuthority::load(&litesvm.get_account(&subscription_authority_pda).unwrap().data)
            .unwrap()
            .init_id;

    CloseSubscriptionAuthority::new(litesvm, payer, mint).execute().assert_ok();
    move_clock_forward(litesvm, 1);
    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let new_init_id =
        crate::state::SubscriptionAuthority::load(&litesvm.get_account(&subscription_authority_pda).unwrap().data)
            .unwrap()
            .init_id;
    assert_ne!(old_init_id, new_init_id);

    let delegatee = Pubkey::new_unique();
    let (res, _) = CreateDelegation::new(litesvm, payer, mint, delegatee)
        .expected_subscription_authority_init_id(old_init_id)
        .nonce(nonce)
        .recurring(amount_per_period, period_length_s, start_ts, expiry_ts);
    res.assert_err(SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn create_recurring_delegation_with_past_start_ts() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 86400;
    let start_ts: i64 = i64::MIN;
    let expiry_ts = current_ts() + 100000000;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();

    let (res, _delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_err(SubscriptionsError::RecurringDelegationStartTimeInPast);
}

#[test]
fn create_recurring_delegation_with_zero_period() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 0;
    let start_ts: i64 = current_ts() + 10000;
    let expiry_ts = current_ts() + 100000000;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();

    let (res, _delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_err(SubscriptionsError::InvalidPeriodLength);
}

#[test]
fn create_recurring_delegation_with_start_ts_greater_than_expiry_ts() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 1;
    let start_ts: i64 = current_ts() + 100000000;
    let expiry_ts = current_ts() + 10000;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();

    let (res, _delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_err(SubscriptionsError::RecurringDelegationStartTimeGreaterThanExpiry);
}

#[test]
fn create_recurring_delegation_with_period_exceeding_max() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 31_536_001;
    let start_ts: i64 = current_ts();
    let expiry_ts = current_ts() + days(365) as i64;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();

    let (res, _delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_err(SubscriptionsError::InvalidPeriodLength);
}

#[test]
fn create_recurring_delegation_with_zero_expiry() {
    let (litesvm, user) = &mut setup();
    let payer = user;
    let amount_per_period: u64 = 50_000_000;
    let period_length_s: u64 = 86400;
    let start_ts: i64 = current_ts();
    let expiry_ts: i64 = 0;
    let nonce: u64 = 0;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 100_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = solana_keypair::Keypair::new();
    litesvm.airdrop(&delegatee.pubkey(), 10_000_000).unwrap();
    let delegatee_ata = init_ata(litesvm, mint, delegatee.pubkey(), 0);

    let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee.pubkey()).nonce(nonce).recurring(
        amount_per_period,
        period_length_s,
        start_ts,
        expiry_ts,
    );
    res.assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation = RecurringDelegation::load(&account.data).unwrap();
    let del_expiry_ts = delegation.expiry_ts;
    assert_eq!(del_expiry_ts, 0);

    move_clock_forward(litesvm, days(30));

    let transfer_amount: u64 = 10_000_000;
    TransferDelegation::new(litesvm, &delegatee, payer.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .recurring()
        .assert_ok();

    assert_eq!(get_ata_balance(litesvm, &delegatee_ata), transfer_amount);
}
