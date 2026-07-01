use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            current_ts, days, get_ata_balance, get_up_to_max_amount, init_ata, init_mint,
            initialize_subscription_authority_action, move_clock_forward, setup, CreateDelegation, TransferDelegation,
        },
    },
    SubscriptionsError,
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

fn setup_up_to(
    max_amount: u64,
    expiry_ts: i64,
    nonce: u64,
) -> (LiteSVM, Keypair, Keypair, Keypair, Pubkey, Pubkey, Pubkey, Pubkey) {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    let charlie = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).nonce(nonce).up_to(
        max_amount,
        charlie.pubkey(),
        expiry_ts,
    );
    res.assert_ok();

    (litesvm, alice, bob, charlie, delegation_pda, mint, alice_ata, charlie_ata)
}

#[test]
fn test_up_to_partial_draw_consumes() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 0);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(30_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 30_000_000);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 70_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), 0);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_err(SubscriptionsError::UpToDelegationConsumed);
    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 30_000_000);
}

#[test]
fn test_up_to_full_draw_consumes() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, _alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 1);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(max_amount)
        .to(charlie_ata)
        .up_to()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 50_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), 0);
}

#[test]
fn test_up_to_zero_draw_is_valid_and_consumes() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 2);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(0)
        .to(charlie_ata)
        .up_to()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 0);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), 0);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(0)
        .to(charlie_ata)
        .up_to()
        .assert_err(SubscriptionsError::UpToDelegationConsumed);
}

#[test]
fn test_up_to_exceeds_ceiling_rejected() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 3);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(60_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_err(SubscriptionsError::AmountExceedsLimit);

    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 0);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), max_amount);
}

#[test]
fn test_up_to_wrong_recipient_rejected_and_not_consumed() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 4);

    let bob_ata = crate::tests::utils::init_ata(&mut litesvm, mint, bob.pubkey(), 0);
    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .to(bob_ata)
        .up_to()
        .assert_err(SubscriptionsError::UpToRecipientMismatch);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), max_amount);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 10_000_000);
    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), 0);
}

#[test]
fn test_up_to_zero_draw_wrong_mint_receiver_rejected() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, bob, charlie, delegation_pda, mint, _alice_ata, _charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 7);

    let other_mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let charlie_other_ata = init_ata(&mut litesvm, other_mint, charlie.pubkey(), 0);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(0)
        .to(charlie_other_ata)
        .up_to()
        .assert_err(SubscriptionsError::MintMismatch);

    assert_eq!(get_up_to_max_amount(&litesvm, &delegation_pda), max_amount);
}

#[test]
fn test_up_to_expired_rejected() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + 100;
    let (mut litesvm, alice, bob, _charlie, delegation_pda, mint, alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 5);

    move_clock_forward(&mut litesvm, 221);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_err(SubscriptionsError::DelegationExpired);
    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 0);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
}

#[test]
fn test_up_to_wrong_signer_rejected() {
    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (mut litesvm, alice, _bob, _charlie, delegation_pda, mint, _alice_ata, charlie_ata) =
        setup_up_to(max_amount, expiry_ts, 6);

    let eve = Keypair::new();
    litesvm.airdrop(&eve.pubkey(), 1_000_000).unwrap();

    TransferDelegation::new(&mut litesvm, &eve, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .to(charlie_ata)
        .up_to()
        .assert_err(SubscriptionsError::Unauthorized);
}
