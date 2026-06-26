use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::state::Account as TokenAccount;
use spl_token_interface::instruction::TokenInstruction::Approve;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
        pda::get_subscription_authority_pda,
        utils::{
            build_and_send_transaction, fetch_account, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, initialize_subscription_authority_action_with_sponsor, setup,
            CloseSubscriptionAuthority, RevokeSubscriptionAuthority,
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
fn revoke_subscription_authority_leaves_unrelated_delegate_untouched() {
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

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(after.delegate.is_some(), "unrelated delegate must not be cleared");
    assert_eq!(after.delegated_amount, 500, "unrelated delegate's amount must be left untouched");
}

#[test]
fn revoke_subscription_authority_closes_open_authority() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();
    let authority_pda = get_subscription_authority_pda(&user.pubkey(), &mint).0;
    assert!(litesvm.get_account(&authority_pda).is_some_and(|a| a.lamports > 0));

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after = litesvm.get_account(&authority_pda);
    assert!(
        after.is_none() || after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0,
        "revoke must close the open SubscriptionAuthority PDA (the spend kill switch)"
    );
}

#[test]
fn revoke_subscription_authority_rejects_spoofed_authority_account() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();
    let authority_pda = get_subscription_authority_pda(&user.pubkey(), &mint).0;

    let spoofed = Pubkey::new_unique();
    RevokeSubscriptionAuthority::new(litesvm, user, mint)
        .authority(spoofed)
        .execute()
        .assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);

    let authority = litesvm.get_account(&authority_pda);
    assert!(
        authority.is_some_and(|a| a.lamports > 0),
        "a non-canonical authority account must error, not silently leave the real PDA open"
    );
}

#[test]
fn revoke_subscription_authority_closes_authority_but_keeps_foreign_delegate() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();
    let authority_pda = get_subscription_authority_pda(&user.pubkey(), &mint).0;

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

    RevokeSubscriptionAuthority::new(litesvm, user, mint).execute().assert_ok();

    let after_authority = litesvm.get_account(&authority_pda);
    assert!(
        after_authority.is_none() || after_authority.as_ref().map(|a| a.lamports).unwrap_or(0) == 0,
        "open authority must be closed even when the ATA delegate is foreign"
    );
    let ata = fetch_account::<TokenAccount>(litesvm, &user_ata);
    assert!(ata.delegate.is_some(), "foreign delegate must be left untouched");
    assert_eq!(ata.delegated_amount, 500);
}

#[test]
fn revoke_subscription_authority_closes_sponsor_funded_authority_with_receiver() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action_with_sponsor(litesvm, user, mint, Some(&sponsor)).0.assert_ok();
    let authority_pda = get_subscription_authority_pda(&user.pubkey(), &mint).0;
    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeSubscriptionAuthority::new(litesvm, user, mint).receiver(sponsor.pubkey()).execute().assert_ok();

    let after = litesvm.get_account(&authority_pda);
    assert!(after.is_none() || after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);
    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_after > sponsor_before, "rent must return to the recorded sponsor payer");
}

#[test]
fn revoke_subscription_authority_sponsor_funded_requires_receiver() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action_with_sponsor(litesvm, user, mint, Some(&sponsor)).0.assert_ok();

    RevokeSubscriptionAuthority::new(litesvm, user, mint)
        .execute()
        .assert_err(SubscriptionsError::NotEnoughAccountKeys);
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

#[test]
fn revoke_subscription_authority_rejects_short_token_2022_ata() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_2022_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);

    let short_ata = Pubkey::new_unique();
    litesvm
        .set_account(
            short_ata,
            Account {
                lamports: 1_000_000_000,
                data: vec![0u8; 100],
                owner: TOKEN_2022_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    RevokeSubscriptionAuthority::new(litesvm, user, mint)
        .ata(short_ata)
        .execute()
        .assert_err(SubscriptionsError::InvalidToken2022TokenAccountData);
}
