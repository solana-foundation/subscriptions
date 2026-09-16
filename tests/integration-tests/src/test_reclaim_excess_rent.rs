use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            current_ts, days, init_ata, init_mint, init_wallet, initialize_subscription_authority_action,
            overfund_account, setup, CreateDelegation, CreatePlan, ReclaimExcessRent,
        },
    },
    SubscriptionsError,
};

const NO_EXPIRY: i64 = 0;
const EXCESS: u64 = 1_000_000;

fn fund(litesvm: &mut LiteSVM) -> Keypair {
    let sponsor = Keypair::new();
    litesvm.airdrop(&sponsor.pubkey(), LAMPORTS_PER_SOL * 10).unwrap();
    sponsor
}

fn overfunded_delegation(litesvm: &mut LiteSVM, user: &Keypair, sponsor: &Keypair) -> Pubkey {
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
fn reclaims_excess_to_recorded_payer() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegation_pda = overfunded_delegation(litesvm, user, &sponsor);

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
fn rejects_receiver_that_is_not_the_recorded_payer() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegation_pda = overfunded_delegation(litesvm, user, &sponsor);

    let attacker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    let pda_before = litesvm.get_account(&delegation_pda).unwrap().lamports;

    ReclaimExcessRent::new(litesvm, &attacker, delegation_pda, attacker.pubkey())
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);

    assert_eq!(litesvm.get_account(&delegation_pda).unwrap().lamports, pda_before);
}

#[test]
fn any_caller_may_crank_for_the_recorded_payer() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegation_pda = overfunded_delegation(litesvm, user, &sponsor);

    let cranker = init_wallet(litesvm, LAMPORTS_PER_SOL);
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    ReclaimExcessRent::new(litesvm, &cranker, delegation_pda, sponsor.pubkey()).execute().assert_ok();

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert_eq!(sponsor_after, sponsor_before + EXCESS);
}

#[test]
fn rejects_account_at_the_rent_floor() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
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

/// A plan records no payer; the owner receives rent, as in `delete_plan`.
#[test]
fn reclaims_plan_excess_to_owner() {
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

    let owner_after = litesvm.get_account(&owner.pubkey()).unwrap().lamports;
    assert_eq!(owner_after, owner_before + EXCESS);
}

#[test]
fn rejects_account_not_owned_by_the_program() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);

    let res = ReclaimExcessRent::new(litesvm, &sponsor, user.pubkey(), sponsor.pubkey()).execute();
    assert!(res.is_err());
}
