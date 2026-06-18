use crate::{
    state::{common::PlanStatus, header::VERSION_OFFSET, subscription_delegation::SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        pda::{get_plan_pda, get_subscription_authority_pda, get_subscription_pda},
        utils::{
            current_ts, days, hours, init_ata, init_mint, init_wallet, initialize_subscription_authority_action,
            move_clock_forward, setup, setup_with_subscription, CancelSubscription, CloseSubscriptionAuthority,
            CreatePlan, DeletePlan, ResumeSubscription, Subscribe, TransferSubscription, UpdatePlan,
        },
    },
    SubscriptionsError,
};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

/// Creates a subscription whose plan ends exactly one period after creation, so
/// the cancellation `expires_at_ts` is pinned to `plan.end_ts` and the
/// `PlanExpired`/`PlanClosed` guards in resume become reachable.
fn setup_subscription_with_tight_plan_end() -> (LiteSVM, Keypair, Keypair, Pubkey, Pubkey, Pubkey) {
    let (mut litesvm, alice) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let end_ts = litesvm.get_sysvar::<Clock>().unix_timestamp + hours(1) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);
    Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint).execute().assert_ok();

    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    (litesvm, alice, merchant, plan_pda, subscription_pda, mint)
}

#[test]
fn resume_subscription_happy_path() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let period_start = sub.current_period_start_ts;
    let amount_pulled = sub.amount_pulled_in_period;
    assert_ne!({ sub.expires_at_ts }, 0);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint).execute().assert_ok();

    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!({ sub.expires_at_ts }, 0);
    assert_eq!({ sub.current_period_start_ts }, period_start);
    assert_eq!({ sub.amount_pulled_in_period }, amount_pulled);
}

#[test]
fn resume_subscription_rejected_at_cancelled_period_end() {
    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();
    init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    move_clock_forward(&mut litesvm, hours(1));

    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionCancelled);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionCancelled);
}

#[test]
fn resume_subscription_not_cancelled_rejected() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionNotCancelled);
}

#[test]
fn resume_subscription_non_subscriber_rejected() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let attacker = init_wallet(&mut litesvm, 10_000_000_000);
    ResumeSubscription::new(&mut litesvm, &attacker, plan_pda, subscription_pda, mint)
        .subscription_authority(get_subscription_authority_pda(&alice.pubkey(), &mint).0)
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

    ResumeSubscription::new(&mut litesvm, &alice, wrong_plan, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionPlanMismatch);
}

#[test]
fn resume_subscription_rejected_after_cancelled_period_elapsed() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    move_clock_forward(&mut litesvm, hours(1) + 1);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionCancelled);
}

#[test]
fn resume_subscription_rejected_when_plan_expired() {
    let (mut litesvm, alice, _merchant, plan_pda, subscription_pda, mint) = setup_subscription_with_tight_plan_end();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Advance just past plan.end_ts. Resume is rejected because the plan no
    // longer supports active subscriptions.
    move_clock_forward(&mut litesvm, hours(1) + 1);

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::PlanExpired);
}

#[test]
fn resume_subscription_allows_when_plan_sunset() {
    let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
        .status(PlanStatus::Sunset)
        .end_ts(current_ts() + days(7) as i64)
        .execute()
        .assert_ok();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint).execute().assert_ok();

    let account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&account.data).unwrap();
    assert_eq!({ sub.expires_at_ts }, 0);
}

#[test]
fn resume_subscription_rejected_when_plan_deleted() {
    let (mut litesvm, alice, merchant, plan_pda, subscription_pda, mint) = setup_subscription_with_tight_plan_end();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    move_clock_forward(&mut litesvm, hours(1) + 1);
    DeletePlan::new(&mut litesvm, &merchant, plan_pda).execute().assert_ok();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::PlanClosed);
}

#[test]
fn resume_subscription_cancel_resume_cancel_across_period_boundary() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    let first_expires_at = {
        let account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&account.data).unwrap();
        sub.expires_at_ts
    };

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint).execute().assert_ok();

    // Advance past the original period end so the second cancel must compute a
    // new period boundary, not reuse the stale one.
    move_clock_forward(&mut litesvm, hours(2));

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    let account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&account.data).unwrap();
    assert!(
        { sub.expires_at_ts } > first_expires_at,
        "second cancel should advance expires_at_ts past the prior period boundary",
    );
}

#[test]
fn resume_subscription_rejects_reinitialized_authority() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    CloseSubscriptionAuthority::new(&mut litesvm, &alice, mint).execute().assert_ok();
    move_clock_forward(&mut litesvm, 1);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn resume_subscription_version_mismatch() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    ResumeSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda, mint)
        .execute()
        .assert_err(SubscriptionsError::MigrationRequired);
}
