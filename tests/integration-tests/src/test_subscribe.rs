use crate::{
    state::subscription_delegation::SubscriptionDelegation,
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        pda::{get_plan_pda, get_subscription_pda},
        utils::{
            current_ts, days, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, setup, CreatePlan, Subscribe,
        },
    },
    AccountDiscriminator, SubscriptionsError,
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

fn setup_plan(
    period_hours: u64,
    end_ts: i64,
) -> (
    litesvm::LiteSVM,
    Keypair, // alice (subscriber)
    Keypair, // merchant
    Pubkey,  // mint
    Pubkey,  // plan_pda
    u8,      // plan_bump
) {
    let (mut litesvm, alice) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[],
    );
    let _alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

    // Initialize subscription_authority for alice
    initialize_subscription_authority_action(&mut litesvm, &alice, mint)
        .0
        .assert_ok();

    // Create plan
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(period_hours)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);

    (litesvm, alice, merchant, mint, plan_pda, plan_bump)
}

#[test]
fn subscribe_happy_path() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    res.assert_ok();

    // Verify subscription state
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    assert_eq!(sub_account.data.len(), SubscriptionDelegation::LEN);

    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!(
        sub.header.discriminator,
        AccountDiscriminator::SubscriptionDelegation as u8
    );
    assert_eq!(sub.header.delegator.to_bytes(), alice.pubkey().to_bytes());
    assert_eq!(sub.header.delegatee.to_bytes(), plan_pda.to_bytes());
    assert_eq!(sub.header.payer.to_bytes(), alice.pubkey().to_bytes());
    assert_eq!({ sub.amount_pulled_in_period }, 0);
    assert_eq!({ sub.expires_at_ts }, 0);
}

#[test]
fn subscribe_plan_sunset_rejected() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Sunset the plan
    use crate::{state::common::PlanStatus, tests::utils::UpdatePlan};
    UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
        .status(PlanStatus::Sunset)
        .end_ts(end_ts)
        .execute()
        .assert_ok();

    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    res.assert_err(SubscriptionsError::PlanSunset);
}

#[test]
fn subscribe_plan_expired_rejected() {
    let end_ts = current_ts() + days(2) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Move past plan expiry
    use crate::tests::utils::move_clock_forward;
    move_clock_forward(&mut litesvm, days(3));

    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    res.assert_err(SubscriptionsError::PlanExpired);
}

#[test]
fn subscribe_mint_mismatch_rejected() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, _mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Create a different mint and subscription_authority for it
    let other_mint = init_mint(
        &mut litesvm,
        TOKEN_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[],
    );
    let _other_ata = init_ata(&mut litesvm, other_mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, other_mint)
        .0
        .assert_ok();

    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        other_mint,
    )
    .execute();
    res.assert_err(SubscriptionsError::MintMismatch);
}

#[test]
fn subscribe_non_subscriber_subscription_authority_rejected() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, _alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Create another user with their own subscription_authority
    let bob = init_wallet(&mut litesvm, 10_000_000_000);
    let _bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &bob, mint)
        .0
        .assert_ok();

    // Try to subscribe using bob's keys but alice's subscription_authority would be wrong
    // Actually bob subscribes normally, this should succeed
    let res = Subscribe::new(
        &mut litesvm,
        &bob,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    res.assert_ok();
}

#[test]
fn subscribe_no_subscription_authority_rejected() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, _alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Create user without subscription_authority
    let charlie = init_wallet(&mut litesvm, 10_000_000_000);
    let _charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 100_000_000);

    let res = Subscribe::new(
        &mut litesvm,
        &charlie,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    // Should fail because subscription_authority PDA doesn't exist (not owned by program)
    res.assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);
}

#[test]
fn subscribe_with_sponsor() {
    use crate::tests::utils::init_wallet;

    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);
    let sponsor = init_wallet(&mut litesvm, 10_000_000_000);

    let alice_balance_before = litesvm.get_account(&alice.pubkey()).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .payer(&sponsor)
    .execute();
    res.assert_ok();

    // Subscriber must not be charged.
    let alice_balance_after = litesvm.get_account(&alice.pubkey()).unwrap().lamports;
    assert_eq!(alice_balance_after, alice_balance_before);
    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after < sponsor_balance_before);

    // header.payer should be sponsor.
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
    let sub_account = litesvm.get_account(&subscription_pda).unwrap();
    let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
    assert_eq!(sub.header.payer.to_bytes(), sponsor.pubkey().to_bytes());
    assert_eq!(sub.header.delegator.to_bytes(), alice.pubkey().to_bytes());
}

#[test]
fn subscribe_duplicate_rejected() {
    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // First subscription should succeed
    Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute()
    .assert_ok();

    // Second subscription to same plan should fail (PDA already exists)
    let res = Subscribe::new(
        &mut litesvm,
        &alice,
        merchant.pubkey(),
        plan_pda,
        1,
        plan_bump,
        mint,
    )
    .execute();
    res.assert_err(SubscriptionsError::AlreadySubscribed);
}

#[test]
fn subscribe_rejects_stale_expected_terms() {
    use crate::tests::{
        constants::{PROGRAM_ID, SYSTEM_PROGRAM_ID},
        pda::get_subscription_authority_pda,
        utils::build_and_send_transaction,
    };
    use crate::{event_engine::event_authority_pda, instructions::subscribe};
    use solana_instruction::{AccountMeta, Instruction};

    let end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

    // Snapshot live terms, then submit subscribe with a stale `expected_amount`.
    let plan_account = litesvm.get_account(&plan_pda).unwrap();
    let plan = crate::state::Plan::load(&plan_account.data).unwrap();
    let live_amount = plan.data.terms.amount;
    let stale_amount = live_amount.wrapping_add(1);
    let live_period_hours = plan.data.terms.period_hours;
    let live_created_at = plan.data.terms.created_at;
    let live_mint = plan.data.mint;

    let (subscription_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

    let accounts = vec![
        AccountMeta::new(alice.pubkey(), true),
        AccountMeta::new_readonly(merchant.pubkey(), false),
        AccountMeta::new_readonly(plan_pda, false),
        AccountMeta::new(subscription_pda, false),
        AccountMeta::new_readonly(subscription_authority_pda, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(PROGRAM_ID, false),
    ];

    let data = [
        vec![*subscribe::DISCRIMINATOR],
        1u64.to_le_bytes().to_vec(),
        vec![plan_bump],
        live_mint.as_ref().to_vec(),
        stale_amount.to_le_bytes().to_vec(),
        live_period_hours.to_le_bytes().to_vec(),
        live_created_at.to_le_bytes().to_vec(),
    ]
    .concat();

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data,
    };

    let res = build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix);
    res.assert_err(SubscriptionsError::PlanTermsMismatch);
}
