use solana_keypair::Keypair;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            init_ata, init_mint, initialize_subscription_authority_action, setup, CloseSubscriptionAuthority,
            CreateDelegation, RevokeAbandonedDelegation,
        },
    },
    SubscriptionsError,
};

const NO_EXPIRY: i64 = 0;

fn fund(litesvm: &mut litesvm::LiteSVM) -> Keypair {
    let sponsor = Keypair::new();
    litesvm.airdrop(&sponsor.pubkey(), LAMPORTS_PER_SOL * 10).unwrap();
    sponsor
}

#[test]
fn sponsor_recovers_no_expiry_fixed_delegation_after_authority_closed() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    let delegation_rent = litesvm.get_account(&delegation_pda).unwrap().lamports;

    CloseSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeAbandonedDelegation::new(litesvm, &sponsor, user.pubkey(), mint, delegatee).execute().assert_ok();

    let delegation_after = litesvm.get_account(&delegation_pda);
    assert!(delegation_after.is_none() || delegation_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_after >= sponsor_before + delegation_rent - 10_000);
}

#[test]
fn revoke_abandoned_rejects_live_delegation() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, _delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    RevokeAbandonedDelegation::new(litesvm, &sponsor, user.pubkey(), mint, delegatee)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn revoke_abandoned_rejects_non_sponsor_caller() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let stranger = fund(litesvm);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, _delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    CloseSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    RevokeAbandonedDelegation::new(litesvm, &stranger, user.pubkey(), mint, delegatee)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn revoke_abandoned_rejects_unbound_authority_account() {
    let (litesvm, user) = &mut setup();
    let sponsor = fund(litesvm);
    let delegatee = Pubkey::new_unique();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let (res, _delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).payer(&sponsor).fixed(100, NO_EXPIRY);
    res.assert_ok();

    CloseSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    RevokeAbandonedDelegation::new(litesvm, &sponsor, user.pubkey(), mint, delegatee)
        .authority(Pubkey::new_unique())
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}
