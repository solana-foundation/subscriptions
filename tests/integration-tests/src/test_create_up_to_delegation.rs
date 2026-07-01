use crate::{
    state::UpToDelegation,
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            current_ts, days, init_ata, init_mint, initialize_subscription_authority_action, setup, CreateDelegation,
        },
    },
    SubscriptionsError,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn test_create_up_to_success() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    let charlie = Keypair::new();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let max_amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let (res, delegation_pda) =
        CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).up_to(max_amount, charlie.pubkey(), expiry_ts);
    res.assert_ok();

    let account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation = UpToDelegation::load(&account.data).unwrap();
    let stored_recipient = delegation.recipient;
    let stored_max = delegation.max_amount;
    let stored_expiry = delegation.expiry_ts;
    assert_eq!(stored_recipient.as_ref(), charlie.pubkey().to_bytes().as_ref());
    assert_eq!(stored_max, max_amount);
    assert_eq!(stored_expiry, expiry_ts);
}

#[test]
fn test_create_up_to_zero_max_amount_rejected() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    let charlie = Keypair::new();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, _) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).up_to(
        0,
        charlie.pubkey(),
        current_ts() + days(1) as i64,
    );
    res.assert_err(SubscriptionsError::UpToDelegationAmountZero);
}

#[test]
fn test_create_up_to_zero_recipient_rejected() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, _) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).up_to(
        50_000_000,
        solana_pubkey::Pubkey::default(),
        current_ts() + days(1) as i64,
    );
    res.assert_err(SubscriptionsError::InvalidAddress);
}

#[test]
fn test_create_up_to_expiry_in_past_rejected() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    let charlie = Keypair::new();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, _) =
        CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).up_to(50_000_000, charlie.pubkey(), 1);
    res.assert_err(SubscriptionsError::UpToDelegationExpiryInPast);
}
