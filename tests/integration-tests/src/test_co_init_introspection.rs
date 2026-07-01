use crate::{
    event_engine::event_authority_pda,
    instructions::{create_fixed_delegation, create_recurring_delegation, subscribe},
    state::{FixedDelegation, Plan, RecurringDelegation, SubscriptionAuthority, SubscriptionDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{INSTRUCTIONS_SYSVAR_ID, MINT_DECIMALS, PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
        pda::{get_delegation_pda, get_plan_pda, get_subscription_authority_pda, get_subscription_pda},
        utils::{
            build_and_send_transaction_multi, current_ts, days, init_ata, init_authority_ix, init_mint, init_wallet,
            initialize_subscription_authority_action, setup, CreatePlan,
        },
    },
    SubscriptionsError, UNKNOWN_INIT_ID,
};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

#[allow(clippy::too_many_arguments)]
fn subscribe_ix(
    subscriber: &Pubkey,
    merchant: &Pubkey,
    plan_pda: Pubkey,
    subscription_pda: Pubkey,
    authority_pda: Pubkey,
    plan_id: u64,
    plan_bump: u8,
    plan: &Plan,
    init_id: i64,
) -> Instruction {
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());
    let expected_mint = plan.data.mint;
    let expected_amount = plan.data.terms.amount;
    let expected_period_hours = plan.data.terms.period_hours;
    let expected_created_at = plan.data.terms.created_at;

    let accounts = vec![
        AccountMeta::new(*subscriber, true),
        AccountMeta::new_readonly(*merchant, false),
        AccountMeta::new_readonly(plan_pda, false),
        AccountMeta::new(subscription_pda, false),
        AccountMeta::new_readonly(authority_pda, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(PROGRAM_ID, false),
        AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
    ];

    let data = [
        vec![*subscribe::DISCRIMINATOR],
        plan_id.to_le_bytes().to_vec(),
        vec![plan_bump],
        expected_mint.as_ref().to_vec(),
        expected_amount.to_le_bytes().to_vec(),
        expected_period_hours.to_le_bytes().to_vec(),
        expected_created_at.to_le_bytes().to_vec(),
        init_id.to_le_bytes().to_vec(),
    ]
    .concat();

    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn delegation_accounts(
    delegator: &Pubkey,
    authority_pda: Pubkey,
    delegation_pda: Pubkey,
    delegatee: Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*delegator, true),
        AccountMeta::new(authority_pda, false),
        AccountMeta::new(delegation_pda, false),
        AccountMeta::new_readonly(delegatee, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
    ]
}

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

    (litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump)
}

#[test]
fn co_init_then_subscribe_succeeds() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    assert!(litesvm.get_account(&authority_pda).map(|a| a.data.is_empty()).unwrap_or(true));

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let sub_ix = subscribe_ix(
        &alice.pubkey(),
        &merchant.pubkey(),
        plan_pda,
        subscription_pda,
        authority_pda,
        1,
        plan_bump,
        plan,
        UNKNOWN_INIT_ID,
    );

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
    let data = [
        vec![*create_fixed_delegation::DISCRIMINATOR],
        0u64.to_le_bytes().to_vec(),
        1_000u64.to_le_bytes().to_vec(),
        (current_ts() + days(1) as i64).to_le_bytes().to_vec(),
        UNKNOWN_INIT_ID.to_le_bytes().to_vec(),
    ]
    .concat();
    let del_ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: delegation_accounts(&alice.pubkey(), authority_pda, delegation_pda, delegatee),
        data,
    };

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
    let data = [
        vec![*create_recurring_delegation::DISCRIMINATOR],
        0u64.to_le_bytes().to_vec(),
        1_000u64.to_le_bytes().to_vec(),
        3_600u64.to_le_bytes().to_vec(),
        0i64.to_le_bytes().to_vec(),
        (current_ts() + days(30) as i64).to_le_bytes().to_vec(),
        UNKNOWN_INIT_ID.to_le_bytes().to_vec(),
    ]
    .concat();
    let del_ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: delegation_accounts(&alice.pubkey(), authority_pda, delegation_pda, delegatee),
        data,
    };

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, del_ix]).assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    assert_eq!(account.data.len(), RecurringDelegation::LEN);
}

#[test]
fn idempotent_co_init_then_subscribe_succeeds() {
    let (mut litesvm, alice, merchant, mint, alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, authority_pda);
    let sub_ix = subscribe_ix(
        &alice.pubkey(),
        &merchant.pubkey(),
        plan_pda,
        subscription_pda,
        authority_pda,
        1,
        plan_bump,
        plan,
        UNKNOWN_INIT_ID,
    );

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[init_ix, sub_ix]).assert_ok();
}

#[test]
fn sentinel_without_co_init_rejected() {
    let (mut litesvm, alice, merchant, mint, _alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let sub_ix = subscribe_ix(
        &alice.pubkey(),
        &merchant.pubkey(),
        plan_pda,
        subscription_pda,
        authority_pda,
        1,
        plan_bump,
        plan,
        UNKNOWN_INIT_ID,
    );

    build_and_send_transaction_multi(&mut litesvm, &[&alice], &alice.pubkey(), &[sub_ix])
        .assert_err(SubscriptionsError::StaleSubscriptionAuthority);
}

#[test]
fn co_init_for_different_mint_does_not_satisfy_subscribe() {
    let (mut litesvm, alice, merchant, mint, _alice_ata, plan_pda, plan_bump) = setup_plan();
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    let other_mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let other_ata = init_ata(&mut litesvm, other_mint, alice.pubkey(), 100_000_000);
    let (other_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &other_mint);

    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = Plan::load(&plan_account.data).unwrap();
    let init_ix = init_authority_ix(&alice.pubkey(), other_mint, other_ata, other_authority_pda);
    let sub_ix = subscribe_ix(
        &alice.pubkey(),
        &merchant.pubkey(),
        plan_pda,
        subscription_pda,
        authority_pda,
        1,
        plan_bump,
        plan,
        UNKNOWN_INIT_ID,
    );

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

    let init_ix = init_authority_ix(&alice.pubkey(), mint, alice_ata, alice_authority_pda);
    let sub_ix = subscribe_ix(
        &bob.pubkey(),
        &merchant.pubkey(),
        plan_pda,
        bob_subscription_pda,
        alice_authority_pda,
        1,
        plan_bump,
        plan,
        UNKNOWN_INIT_ID,
    );

    build_and_send_transaction_multi(&mut litesvm, &[&alice, &bob], &alice.pubkey(), &[init_ix, sub_ix])
        .assert_err_at(1, SubscriptionsError::Unauthorized);
}
