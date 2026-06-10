use crate::{
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            current_ts, days, get_ata_balance, hours, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, minutes, move_clock_forward, setup, setup_with_subscription,
            CancelSubscription, CreatePlan, CreateSubscription, DeletePlan, RevokeSubscription, TransferSubscription,
            UpdatePlan,
        },
    },
    SubscriptionsError,
};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_signer::Signer;
#[test]
fn cancel_subscription_happy_path() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Verify expires_at_ts is set (end of current period)
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_ne!({ sub.expires_at_ts }, 0);
}

#[test]
fn cancel_at_exact_end_ts_keeps_final_period_billable() {
    let (mut litesvm, subscriber) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(subscriber.pubkey()), &[]);
    init_ata(&mut litesvm, mint, subscriber.pubkey(), 100_000_000);
    let merchant_ata = init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &subscriber, mint).0.assert_ok();

    let start_ts = litesvm.get_sysvar::<Clock>().unix_timestamp;
    let end_ts = start_ts + hours(2) as i64;

    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let terms = Plan::load(&plan_account.data).unwrap().data.terms;
    let subscription_pda =
        CreateSubscription::new(&mut litesvm, plan_pda, subscriber.pubkey(), mint, start_ts).terms(terms).execute();

    let now = litesvm.get_sysvar::<Clock>().unix_timestamp;
    move_clock_forward(&mut litesvm, u64::try_from(end_ts - now).unwrap());
    assert_eq!(litesvm.get_sysvar::<Clock>().unix_timestamp, end_ts);

    CancelSubscription::new(&mut litesvm, &subscriber, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!({ sub.expires_at_ts }, end_ts + 1);

    RevokeSubscription::new(&mut litesvm, &subscriber, subscription_pda, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionNotCancelled);

    TransferSubscription::new(&mut litesvm, &merchant, subscriber.pubkey(), mint, subscription_pda, plan_pda)
        .amount(20_000_000)
        .to(merchant_ata)
        .execute()
        .assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 20_000_000);
}

#[test]
fn cancel_subscription_non_subscriber_rejected() {
    let (mut litesvm, _alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    let attacker = init_wallet(&mut litesvm, 10_000_000_000);
    let res = CancelSubscription::new(&mut litesvm, &attacker, plan_pda, subscription_pda).execute();
    res.assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn cancel_subscription_already_cancelled_rejected() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    // Cancel once
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Cancel again should fail
    let res = CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute();
    res.assert_err(SubscriptionsError::SubscriptionAlreadyCancelled);
}

#[test]
fn test_cancel_subscription_version_mismatch() {
    use crate::state::header::VERSION_OFFSET;

    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::MigrationRequired);
}

#[test]
fn cancel_subscription_ghost_plan_expires_immediately() {
    use crate::state::common::PlanStatus;

    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    // Get current time before any clock manipulation
    let ts_before = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;

    // Sunset, expire, and delete the plan
    let end_ts = current_ts() + days(2) as i64;
    UpdatePlan::new(&mut litesvm, &merchant, plan_pda).status(PlanStatus::Sunset).end_ts(end_ts).execute().assert_ok();

    move_clock_forward(&mut litesvm, days(3));

    DeletePlan::new(&mut litesvm, &merchant, plan_pda).execute().assert_ok();

    // Recreate plan with same plan_id but different terms
    let new_end_ts = current_ts() + days(60) as i64;
    let (res, new_plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(999_000_000)
        .period_hours(720)
        .end_ts(new_end_ts)
        .execute();
    res.assert_ok();
    assert_eq!(plan_pda, new_plan_pda);

    // Cancel should succeed but expire immediately (no grace period)
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let expires = sub.expires_at_ts;
    // Should be immediate (current_ts), not end-of-period
    assert!(expires > ts_before);
    // Verify it's NOT a grace period (which would be period_start + period_length)
    // Ghost plan expires at current_ts, which is much less than period_start + 720h
    let svm_ts = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    assert_eq!(expires, svm_ts);
}

#[test]
fn cancel_subscription_caps_at_plan_end_ts() {
    use crate::instructions::create_plan::PlanTerms;
    use crate::tests::{
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            init_ata, init_mint, initialize_subscription_authority_action, move_clock_forward, setup, CreatePlan,
            CreateSubscription,
        },
    };
    use solana_signer::Signer;

    let (mut litesvm, alice) = setup();
    let merchant = solana_keypair::Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let end_ts = current_ts() + minutes(90) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let svm_ts = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    let subscription_pda = CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts)
        .terms(PlanTerms { amount: 50_000_000, period_hours: 1, created_at: svm_ts })
        .execute();

    move_clock_forward(&mut litesvm, hours(1) + minutes(5));

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!(
        { sub.expires_at_ts },
        end_ts + 1,
        "expires_at_ts should be capped just past the inclusive plan end_ts, not period end"
    );
}

#[test]
fn cancel_subscription_after_plan_expired_allows_immediate_revoke() {
    use crate::instructions::create_plan::PlanTerms;
    use crate::tests::{
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            init_ata, init_mint, initialize_subscription_authority_action, move_clock_forward, setup, CreatePlan,
            CreateSubscription,
        },
    };
    use solana_signer::Signer;

    let (mut litesvm, alice) = setup();
    let merchant = solana_keypair::Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let end_ts = current_ts() + hours(2) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let svm_ts = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    let subscription_pda = CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts)
        .terms(PlanTerms { amount: 50_000_000, period_hours: 1, created_at: svm_ts })
        .execute();

    move_clock_forward(&mut litesvm, hours(3));

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let current_clock = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    assert!(
        { sub.expires_at_ts } <= current_clock,
        "expires_at_ts ({}) should be <= current time ({}) so subscriber can revoke immediately",
        { sub.expires_at_ts },
        current_clock
    );
}
