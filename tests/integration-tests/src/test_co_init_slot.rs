use crate::{
    event_engine::event_authority_pda,
    instructions::subscribe,
    state::{FixedDelegation, Plan, RecurringDelegation, SubscriptionAuthority, SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
        pda::{get_delegation_pda, get_plan_pda, get_subscription_authority_pda, get_subscription_pda},
        utils::{
            advance_slots, build_and_send_transaction_multi, current_ts, days, init_ata, init_authority_ix, init_mint,
            init_wallet, initialize_subscription_authority_action, setup, CreateDelegation, CreatePlan, Subscribe,
        },
    },
    SubscriptionsError, UNKNOWN_INIT_ID,
};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

/// Sets up a plan and advances to a non-zero baseline slot so a stored `init_id`
/// of `0` can never coincidentally satisfy the same-slot sentinel check.
fn setup_plan() -> (LiteSVM, Keypair, Keypair, Pubkey, Pubkey, Pubkey, u8) {
    let (mut litesvm, alice) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

    let end_ts = current_ts() + days(30) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();
    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);

    advance_slots(&mut litesvm, 100);

    (litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump)
}

#[test]
fn co_init_then_subscribe_succeeds() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    assert!(litesvm.get_account(&authority_pda).map(|a| a.data.is_empty()).unwrap_or(true));

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let sub_ix = Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .expected_init_id(UNKNOWN_INIT_ID)
        .instruction();

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, sub_ix]).assert_ok();

    let authority_account = litesvm.get_account(&authority_pda).unwrap();
    let live_init_id = SubscriptionAuthority::load(&authority_account.data).unwrap().init_id;
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    let stored_init_id = sub.header.init_id;
    assert_eq!(stored_init_id, live_init_id);
}

#[test]
fn co_init_then_fixed_delegation_succeeds() {
    let (mut litesvm, alice, _merchant, mint, alice_ata, _plan_pda, _plan_bump) = setup_plan();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegatee = Pubkey::new_unique();
    let (delegation_pda, _) = get_delegation_pda(&authority_pda, &alice.pubkey(), &delegatee, 0);

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let del_ix = CreateDelegation::new(&mut litesvm, &alice, mint, delegatee)
        .expected_subscription_authority_init_id(UNKNOWN_INIT_ID)
        .fixed_instruction(1_000, current_ts() + days(1) as i64);

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, del_ix]).assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    assert_eq!(account.data.len(), FixedDelegation::LEN);
}

#[test]
fn co_init_then_recurring_delegation_succeeds() {
    let (mut litesvm, alice, _merchant, mint, alice_ata, _plan_pda, _plan_bump) = setup_plan();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegatee = Pubkey::new_unique();
    let (delegation_pda, _) = get_delegation_pda(&authority_pda, &alice.pubkey(), &delegatee, 0);

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let del_ix = CreateDelegation::new(&mut litesvm, &alice, mint, delegatee)
        .expected_subscription_authority_init_id(UNKNOWN_INIT_ID)
        .recurring_instruction(1_000, 3_600, 0, current_ts() + days(30) as i64);

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, del_ix]).assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    assert_eq!(account.data.len(), RecurringDelegation::LEN);
}

#[test]
fn sentinel_rejected_when_authority_from_prior_slot() {
    let (mut litesvm, alice, merchant, mint, _alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    advance_slots(&mut litesvm, 1);

    let sub_ix = Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .expected_init_id(UNKNOWN_INIT_ID)
        .instruction();

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[sub_ix])
        .assert_err(SubscriptionsError::StaleSubscriptionAuthority);
}

/// A returning user whose authority already exists from an earlier slot cannot
/// use the sentinel: idempotent re-init does not refresh `init_id`, so the
/// same-slot check still sees the stale value. Such callers must pass the real
/// `init_id` instead.
#[test]
fn sentinel_rejected_for_preexisting_authority_reinit_in_bundle() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    advance_slots(&mut litesvm, 1);
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let sub_ix = Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .expected_init_id(UNKNOWN_INIT_ID)
        .instruction();

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, sub_ix])
        .assert_err_at(1, SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn init_after_subscribe_in_same_tx_rejected() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    advance_slots(&mut litesvm, 1);
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let sub_ix = Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .expected_init_id(UNKNOWN_INIT_ID)
        .instruction();

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[sub_ix, init_ix])
        .assert_err(SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn co_init_for_different_mint_does_not_satisfy_subscribe() {
    let (mut litesvm, alice, merchant, mint, _alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    advance_slots(&mut litesvm, 1);

    let other_mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let other_ata = init_ata(&mut litesvm, other_mint, alice.pubkey(), 100_000_000);
    let (other_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &other_mint);

    let init_ix = init_authority_ix(&alice.pubkey(), other_mint, other_ata, other_authority_pda);
    let sub_ix = Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .expected_init_id(UNKNOWN_INIT_ID)
        .instruction();

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, sub_ix])
        .assert_err_at(1, SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn co_init_by_different_user_rejected() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    let bob = init_wallet(&mut litesvm, 10_000_000_000);

    let (alice_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (bob_subscription_pda, _) = get_subscription_pda(&plan_pda, &bob.pubkey());

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let expected_mint = plan.data.mint;
    let expected_amount = plan.data.terms.amount;
    let expected_period_hours = plan.data.terms.period_hours;
    let expected_created_at = plan.data.terms.created_at;

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, alice_authority_pda);

    // Hand-rolled: bob subscribes against alice's authority PDA (mismatch), which
    // the Subscribe builder cannot express since it derives the subscriber's own PDA.
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());
    let sub_ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(bob.pubkey(), true),
            AccountMeta::new_readonly(merchant.pubkey(), false),
            AccountMeta::new_readonly(plan_pda, false),
            AccountMeta::new(bob_subscription_pda, false),
            AccountMeta::new_readonly(alice_authority_pda, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ],
        data: [
            vec![*subscribe::DISCRIMINATOR],
            1u64.to_le_bytes().to_vec(),
            vec![plan_bump],
            expected_mint.as_ref().to_vec(),
            expected_amount.to_le_bytes().to_vec(),
            expected_period_hours.to_le_bytes().to_vec(),
            expected_created_at.to_le_bytes().to_vec(),
            UNKNOWN_INIT_ID.to_le_bytes().to_vec(),
        ]
        .concat(),
    };

    build_and_send_transaction_multi(&mut litesvm, &[&alice, &bob], &alice.pubkey(), &[init_ix, sub_ix])
        .assert_err_at(1, SubscriptionsError::Unauthorized);
}
