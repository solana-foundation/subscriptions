use crate::event_engine::event_authority_pda;
use crate::{
    instructions::cancel_subscription_now,
    state::{header::VERSION_OFFSET, subscription_delegation::SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::PROGRAM_ID,
        pda::{get_plan_pda, get_subscription_authority_pda, get_subscription_pda},
        utils::{
            build_and_send_transaction, current_ts, days, init_ata, init_wallet, setup_with_subscription,
            CancelSubscription, CancelSubscriptionNow, CreatePlan, RevokeSubscription, Subscribe, TransferSubscription,
        },
    },
    SubscriptionsError,
};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;

fn cancel_subscription_now_instruction(
    subscriber: Pubkey,
    subscriber_is_signer: bool,
    merchant: Pubkey,
    merchant_is_signer: bool,
    plan_pda: Pubkey,
    subscription_pda: Pubkey,
) -> Instruction {
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(subscriber, subscriber_is_signer),
            AccountMeta::new_readonly(merchant, merchant_is_signer),
            AccountMeta::new_readonly(plan_pda, false),
            AccountMeta::new(subscription_pda, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ],
        data: vec![*cancel_subscription_now::DISCRIMINATOR],
    }
}

#[test]
fn cancel_subscription_now_expires_at_current_clock() {
    let (mut litesvm, subscriber, merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda).execute().assert_ok();

    let account = litesvm.get_account(&subscription_pda).unwrap();
    let subscription = SubscriptionDelegation::load(&account.data).unwrap();
    assert_eq!({ subscription.expires_at_ts }, litesvm.get_sysvar::<Clock>().unix_timestamp);
}

#[test]
fn cancel_subscription_now_requires_both_signatures() {
    let (mut litesvm, subscriber, merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    let missing_subscriber = cancel_subscription_now_instruction(
        subscriber.pubkey(),
        false,
        merchant.pubkey(),
        true,
        plan_pda,
        subscription_pda,
    );
    build_and_send_transaction(&mut litesvm, &[&merchant], &merchant.pubkey(), &missing_subscriber)
        .assert_err(SubscriptionsError::NotSigner);

    let missing_merchant = cancel_subscription_now_instruction(
        subscriber.pubkey(),
        true,
        merchant.pubkey(),
        false,
        plan_pda,
        subscription_pda,
    );
    build_and_send_transaction(&mut litesvm, &[&subscriber], &subscriber.pubkey(), &missing_merchant)
        .assert_err(SubscriptionsError::NotSigner);
}

#[test]
fn cancel_subscription_now_rejects_wrong_subscriber_merchant_and_plan() {
    let (mut litesvm, subscriber, merchant, mint, plan_pda, _, subscription_pda) = setup_with_subscription();
    let attacker = init_wallet(&mut litesvm, 10_000_000_000);

    CancelSubscriptionNow::new(&mut litesvm, &attacker, &merchant, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &attacker, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::NotPlanOwner);

    let (create_plan, other_plan) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(2)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(current_ts() + days(30) as i64)
        .execute();
    create_plan.assert_ok();
    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, other_plan, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionPlanMismatch);
}

#[test]
fn cancel_subscription_now_accelerates_pending_cancellation() {
    let (mut litesvm, subscriber, merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &subscriber, plan_pda, subscription_pda).execute().assert_ok();
    let account = litesvm.get_account(&subscription_pda).unwrap();
    let pending_expiry = { SubscriptionDelegation::load(&account.data).unwrap().expires_at_ts };
    assert!(pending_expiry > litesvm.get_sysvar::<Clock>().unix_timestamp);

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda).execute().assert_ok();

    let account = litesvm.get_account(&subscription_pda).unwrap();
    let subscription = SubscriptionDelegation::load(&account.data).unwrap();
    assert_eq!({ subscription.expires_at_ts }, litesvm.get_sysvar::<Clock>().unix_timestamp);
}

#[test]
fn cancel_subscription_now_blocks_pulls_and_allows_immediate_revoke() {
    let (mut litesvm, subscriber, merchant, mint, plan_pda, _, subscription_pda) = setup_with_subscription();
    let merchant_ata = init_ata(&mut litesvm, mint, merchant.pubkey(), 0);
    let (subscription_authority, _) = get_subscription_authority_pda(&subscriber.pubkey(), &mint);

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda).execute().assert_ok();

    TransferSubscription::new(&mut litesvm, &merchant, subscriber.pubkey(), mint, subscription_pda, plan_pda)
        .amount(1)
        .to(merchant_ata)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionCancelled);

    RevokeSubscription::new(&mut litesvm, &subscriber, subscription_pda, plan_pda).execute().assert_ok();
    assert!(litesvm.get_account(&subscription_pda).map(|account| account.lamports).unwrap_or(0) == 0);
    assert!(litesvm.get_account(&subscription_authority).is_some());
}

#[test]
fn cancel_subscription_now_preserves_other_subscriptions_on_shared_authority() {
    let (mut litesvm, subscriber, first_merchant, mint, first_plan, _, first_subscription) = setup_with_subscription();
    let second_merchant = init_wallet(&mut litesvm, 10_000_000_000);
    let second_merchant_ata = init_ata(&mut litesvm, mint, second_merchant.pubkey(), 0);
    let (create_plan, second_plan) = CreatePlan::new(&mut litesvm, &second_merchant, mint)
        .plan_id(2)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(current_ts() + days(30) as i64)
        .execute();
    create_plan.assert_ok();
    let (_, second_plan_bump) = get_plan_pda(&second_merchant.pubkey(), 2);
    Subscribe::new(&mut litesvm, &subscriber, second_merchant.pubkey(), second_plan, 2, second_plan_bump, mint)
        .execute()
        .assert_ok();
    let (second_subscription, _) = get_subscription_pda(&second_plan, &subscriber.pubkey());

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &first_merchant, first_plan, first_subscription)
        .execute()
        .assert_ok();

    TransferSubscription::new(
        &mut litesvm,
        &second_merchant,
        subscriber.pubkey(),
        mint,
        second_subscription,
        second_plan,
    )
    .amount(1)
    .to(second_merchant_ata)
    .execute()
    .assert_ok();
}

#[test]
fn cancel_subscription_now_rejects_effective_cancellation_and_old_version() {
    let (mut litesvm, subscriber, merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda).execute().assert_ok();
    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionAlreadyCancelled);

    let (mut litesvm, subscriber, merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();
    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    CancelSubscriptionNow::new(&mut litesvm, &subscriber, &merchant, plan_pda, subscription_pda)
        .execute()
        .assert_err(SubscriptionsError::MigrationRequired);
}
