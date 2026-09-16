use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction_error::TransactionError::InstructionError;

use crate::{
    instructions::reclaim_excess_rent,
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, TOKEN_PROGRAM_ID},
        idl,
        pda::{get_plan_pda, get_subscription_pda},
        utils::{
            build_and_send_transaction, current_ts, days, hours, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, initialize_subscription_authority_action_with_sponsor,
            overfund_account, setup, CreateDelegation, CreatePlan, ReclaimExcessRent, Subscribe,
        },
    },
    SubscriptionsError,
};

const NO_EXPIRY: i64 = 0;
const EXCESS: u64 = 1_000_000;
const SPONSOR_FUNDING: u64 = LAMPORTS_PER_SOL * 10;

fn overfunded_fixed_delegation(litesvm: &mut LiteSVM, user: &Keypair, sponsor: &Keypair) -> Pubkey {
    let delegatee = Pubkey::new_unique();
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    overfund_account(litesvm, delegation_pda, EXCESS);
    delegation_pda
}

#[test]
fn reclaim_excess_rent_happy_path() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegation_pda = overfunded_fixed_delegation(litesvm, user, &sponsor);

    let pda_before = litesvm.get_account(&delegation_pda).unwrap().lamports;
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    ReclaimExcessRent::new(litesvm, &sponsor, delegation_pda, sponsor.pubkey()).execute().assert_ok();

    let pda_after = litesvm.get_account(&delegation_pda).unwrap();
    assert_eq!(pda_after.lamports, pda_before - EXCESS);
    assert!(!pda_after.data.is_empty());
    assert_eq!(pda_after.lamports, litesvm.minimum_balance_for_rent_exemption(pda_after.data.len()));

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_after >= sponsor_before + EXCESS - 10_000);
}

#[test]
fn reclaim_excess_rent_wrong_receiver_unauthorized() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegation_pda = overfunded_fixed_delegation(litesvm, user, &sponsor);

    let attacker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    let pda_before = litesvm.get_account(&delegation_pda).unwrap().lamports;

    ReclaimExcessRent::new(litesvm, &attacker, delegation_pda, attacker.pubkey())
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);

    assert_eq!(litesvm.get_account(&delegation_pda).unwrap().lamports, pda_before);
}

#[test]
fn reclaim_excess_rent_is_permissionless() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegation_pda = overfunded_fixed_delegation(litesvm, user, &sponsor);

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    ReclaimExcessRent::new(litesvm, &cranker, delegation_pda, sponsor.pubkey()).execute().assert_ok();

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert_eq!(sponsor_after, sponsor_before + EXCESS);
}

#[test]
fn reclaim_excess_rent_at_floor_rejected() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    ReclaimExcessRent::new(litesvm, &sponsor, delegation_pda, sponsor.pubkey())
        .execute()
        .assert_err(SubscriptionsError::NoExcessLamports);
}

#[test]
fn reclaim_excess_rent_recurring_delegation() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let start_ts = current_ts() + 100;
    let (res, delegation_pda) = CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).recurring(
        100,
        hours(24),
        start_ts,
        NO_EXPIRY,
    );
    res.assert_ok();

    overfund_account(litesvm, delegation_pda, EXCESS);
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    ReclaimExcessRent::new(litesvm, &cranker, delegation_pda, sponsor.pubkey()).execute().assert_ok();

    assert_eq!(litesvm.get_account(&sponsor.pubkey()).unwrap().lamports, sponsor_before + EXCESS);
}

#[test]
fn reclaim_excess_rent_subscription_delegation() {
    let (litesvm, subscriber) = &mut setup();
    let merchant = init_wallet(litesvm, SPONSOR_FUNDING);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(subscriber.pubkey()), &[]);
    let _subscriber_ata = init_ata(litesvm, mint, subscriber.pubkey(), 100_000_000);
    initialize_subscription_authority_action(litesvm, subscriber, mint).0.assert_ok();

    let end_ts = current_ts() + days(30) as i64;
    let (res, plan_pda) =
        CreatePlan::new(litesvm, &merchant, mint).plan_id(1).amount(1_000).period_hours(24).end_ts(end_ts).execute();
    res.assert_ok();
    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);

    Subscribe::new(litesvm, subscriber, merchant.pubkey(), plan_pda, 1, plan_bump, mint).execute().assert_ok();
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &subscriber.pubkey());

    overfund_account(litesvm, subscription_pda, EXCESS);
    let subscriber_before = litesvm.get_account(&subscriber.pubkey()).unwrap().lamports;

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    ReclaimExcessRent::new(litesvm, &cranker, subscription_pda, subscriber.pubkey()).execute().assert_ok();

    assert_eq!(litesvm.get_account(&subscriber.pubkey()).unwrap().lamports, subscriber_before + EXCESS);
}

#[test]
fn reclaim_excess_rent_subscription_authority_returns_to_sponsor() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (res, authority_pda, _) =
        initialize_subscription_authority_action_with_sponsor(litesvm, user, mint, Some(&sponsor));
    res.assert_ok();

    overfund_account(litesvm, authority_pda, EXCESS);
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    ReclaimExcessRent::new(litesvm, &cranker, authority_pda, sponsor.pubkey()).execute().assert_ok();

    assert_eq!(litesvm.get_account(&sponsor.pubkey()).unwrap().lamports, sponsor_before + EXCESS);
}

/// A plan records no payer; the owner receives rent, as in `delete_plan`.
#[test]
fn reclaim_excess_rent_plan_returns_to_owner() {
    let (litesvm, owner) = &mut setup();
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);

    let end_ts = current_ts() + days(2) as i64;
    let (res, plan_pda) =
        CreatePlan::new(litesvm, owner, mint).plan_id(1).amount(1_000).period_hours(24).end_ts(end_ts).execute();
    res.assert_ok();

    overfund_account(litesvm, plan_pda, EXCESS);
    let owner_before = litesvm.get_account(&owner.pubkey()).unwrap().lamports;

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    ReclaimExcessRent::new(litesvm, &cranker, plan_pda, owner.pubkey()).execute().assert_ok();

    assert_eq!(litesvm.get_account(&owner.pubkey()).unwrap().lamports, owner_before + EXCESS);
}

#[test]
fn reclaim_excess_rent_foreign_account_rejected() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);

    let res = ReclaimExcessRent::new(litesvm, &sponsor, user.pubkey(), sponsor.pubkey()).execute();

    assert_eq!(
        res.unwrap_err().err,
        InstructionError(0, solana_instruction::error::InstructionError::InvalidAccountOwner)
    );
}

#[test]
fn writable_accounts_must_be_writable() {
    let writable = idl::writable_account_indices("reclaimExcessRent");
    assert!(!writable.is_empty());

    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, SPONSOR_FUNDING);
    let fee_payer = init_wallet(litesvm, SPONSOR_FUNDING);
    let delegation_pda = overfunded_fixed_delegation(litesvm, user, &sponsor);

    for (idx, _name, is_signer) in &writable {
        let mut accounts = vec![AccountMeta::new(delegation_pda, false), AccountMeta::new(sponsor.pubkey(), false)];

        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*reclaim_excess_rent::DISCRIMINATOR] };

        build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix)
            .assert_err(SubscriptionsError::AccountNotWritable);
    }
}
