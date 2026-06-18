use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::state::Account as TokenAccount;
use spl_token_interface::instruction::TokenInstruction::Approve;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
        utils::{
            build_and_send_transaction, fetch_account, init_ata, init_mint, initialize_subscription_authority_action,
            setup, CloseSubscriptionAuthority, RevokeSubscriptionAuthority,
        },
    },
    SubscriptionsError,
};

#[test]
fn revoke_subscription_authority_clears_delegate() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let before = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(before.delegate.is_some());
    assert_eq!(before.delegated_amount, u64::MAX);

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_none(), "delegate should be cleared after revoke");
    assert_eq!(after.delegated_amount, 0, "delegated amount should be zeroed after revoke");
}

#[test]
fn revoke_subscription_authority_clears_delegate_token_2022() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_2022_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let before = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(before.delegate.is_some());
    assert_eq!(before.delegated_amount, u64::MAX);

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_none(), "delegate should be cleared after revoke");
    assert_eq!(after.delegated_amount, 0, "delegated amount should be zeroed after revoke");
}

#[test]
fn revoke_subscription_authority_works_after_close() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();
    CloseSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let dangling = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(dangling.delegate.is_some());
    assert_eq!(dangling.delegated_amount, u64::MAX);

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_none(), "revoke should clear the dangling delegate even after the authority is closed");
    assert_eq!(after.delegated_amount, 0);
}

#[test]
fn revoke_subscription_authority_rejects_unrelated_delegate() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let other_delegate = Pubkey::new_unique();
    let approve = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user_ata, false),
            AccountMeta::new(other_delegate, false),
            AccountMeta::new(user.pubkey(), true),
        ],
        data: Approve { amount: 500 }.pack(),
    };
    build_and_send_transaction(litesvm, &[&*user], &user.pubkey(), &approve).assert_ok();

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_err(SubscriptionsError::Unauthorized);

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_some(), "unrelated delegate must not be cleared");
    assert_eq!(after.delegated_amount, 500, "unrelated delegate's amount must be left untouched");
}

#[test]
fn revoke_subscription_authority_noop_when_no_delegate() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_none(), "no delegate to clear; revoke is a no-op");
}

#[test]
fn revoke_subscription_authority_rejects_ata_mint_mismatch() {
    let (litesvm, user) = &mut setup();

    let mint_a = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let ata_a = init_ata(litesvm, mint_a, user.pubkey(), 1_000_000);
    let mint_b = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);

    initialize_subscription_authority_action(litesvm, user, mint_a).0.assert_ok();

    RevokeSubscriptionAuthority::new(litesvm, user, mint_b)
        .ata(ata_a)
        .execute()
        .assert_err(SubscriptionsError::MintMismatch);
}
