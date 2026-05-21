use crate::{
    state::{header::VERSION_OFFSET, subscription_delegation::SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        utils::{
            current_ts, days, hours, init_ata, init_wallet, move_clock_forward, setup_with_subscription,
            CancelSubscription, CreatePlan, ResumeSubscription, TransferSubscription,
        },
    },
    SubscriptionsError,
};
use solana_signer::Signer;

#[test]
fn resume_subscription_happy_path() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let period_start = sub.current_period_start_ts;
    let amount_pulled = sub.amount_pulled_in_period;
    assert_ne!({ sub.expires_at_ts }, 0);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!({ sub.expires_at_ts }, 0);
    assert_eq!({ sub.current_period_start_ts }, period_start);
    assert_eq!({ sub.amount_pulled_in_period }, amount_pulled);
}

#[test]
fn resume_subscription_allows_transfer_after_cancelled_period_elapsed() {
    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();
    init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    move_clock_forward(&mut litesvm, hours(1));

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionCancelled);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute()
        .assert_ok();
}

#[test]
fn resume_subscription_not_cancelled_rejected() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionNotCancelled);
}

#[test]
fn resume_subscription_non_subscriber_rejected() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let attacker = init_wallet(&mut litesvm, 10_000_000_000);
    ResumeSubscription::new(&mut litesvm, &attacker, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn resume_subscription_plan_mismatch_rejected() {
    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let (res, wrong_plan) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(2)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(current_ts() + days(30) as i64)
        .execute();
    res.assert_ok();

    ResumeSubscription::new(&mut litesvm, &alice, wrong_plan, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionPlanMismatch);
}

#[test]
fn resume_subscription_version_mismatch() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::MigrationRequired);
}
