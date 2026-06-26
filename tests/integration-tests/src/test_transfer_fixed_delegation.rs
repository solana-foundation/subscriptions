use crate::{
    event_engine::event_authority_pda,
    instructions::transfer_fixed_delegation,
    state::{header::VERSION_OFFSET, FixedDelegation},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
        idl,
        pda::get_subscription_authority_pda,
        utils::{
            build_and_send_transaction, current_ts, days, get_ata_balance, init_ata, init_aux_token_account, init_mint,
            init_wallet, initialize_subscription_authority_action, install_transfer_hook_extra_metas,
            load_transfer_hook_example, move_clock_forward, set_transfer_hook_config, setup,
            CloseSubscriptionAuthority, CreateDelegation, RevokeDelegation, TransferDelegation,
            TRANSFER_HOOK_EXAMPLE_PROGRAM_ID,
        },
    },
    SubscriptionsError,
};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_interface::instruction::TokenInstruction::Approve;

fn setup_fixed_delegation(
    amount: u64,
    expiry_ts: i64,
    nonce: u64,
) -> (LiteSVM, Keypair, Keypair, Pubkey, Pubkey, Pubkey, Pubkey) {
    let (mut lite_svm, alice) = setup();
    let bob = Keypair::new();
    lite_svm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(&mut lite_svm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut lite_svm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut lite_svm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut lite_svm, &alice, mint).0.assert_ok();

    let (res, delegation_pda) =
        CreateDelegation::new(&mut lite_svm, &alice, mint, bob.pubkey()).nonce(nonce).fixed(amount, expiry_ts);
    res.assert_ok();

    (lite_svm, alice, bob, delegation_pda, mint, alice_ata, bob_ata)
}

#[test]
fn test_fixed_transfer_success() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    let (mut litesvm, alice, bob, delegation_pda, mint, _alice_ata, bob_ata) =
        setup_fixed_delegation(amount, expiry_ts, nonce);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let transfer_amount: u64 = 30_000_000;
    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation = FixedDelegation::load(&delegation_account.data).unwrap();
    let del_amount = delegation.amount;
    let del_expiry_s = delegation.expiry_ts;
    assert_eq!(del_amount, 20_000_000);
    assert_eq!(del_expiry_s, expiry_ts);
}

#[test]
fn test_fixed_transfer_token_2022_transfer_fee() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::TransferFeeConfig],
    );
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 9_900_000);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation = FixedDelegation::load(&delegation_account.data).unwrap();
    let remaining_amount = delegation.amount;
    assert_eq!(remaining_amount, 40_000_000);
}

#[test]
fn test_fixed_transfer_token_2022_confidential_transfer_public_balance() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::ConfidentialTransferMint],
    );
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
}

#[test]
fn test_fixed_transfer_token_2022_unconfigured_transfer_hook() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::TransferHook],
    );
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
}

#[test]
fn test_fixed_transfer_token_2022_active_transfer_hook() {
    let (mut litesvm, alice) = setup();
    load_transfer_hook_example(&mut litesvm);
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::TransferHook],
    );
    set_transfer_hook_config(&mut litesvm, mint, Some(alice.pubkey()), Some(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID));
    let (validation_pda, counter) = install_transfer_hook_extra_metas(&mut litesvm, mint);

    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    let missing_accounts =
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda).amount(10_000_000).fixed();
    assert!(missing_accounts.is_err(), "transfer without hook accounts should fail");
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let remaining = vec![
        AccountMeta::new_readonly(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID, false),
        AccountMeta::new_readonly(validation_pda, false),
        AccountMeta::new(counter, false),
    ];
    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
    assert_eq!(litesvm.get_account(&counter).unwrap().data[0], 1, "transfer hook should have run once");
}

#[test]
fn active_hook_transfer_without_hook_accounts_fails() {
    let (mut litesvm, alice) = setup();
    load_transfer_hook_example(&mut litesvm);
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::TransferHook],
    );
    set_transfer_hook_config(&mut litesvm, mint, Some(alice.pubkey()), Some(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID));
    install_transfer_hook_extra_metas(&mut litesvm, mint);

    let _alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let _bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(vec![AccountMeta::new_readonly(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID, false)])
        .fixed();
    assert!(result.is_err(), "transfer with incomplete hook accounts must fail via the hook");
}

#[test]
fn test_fixed_transfer_multiple_times() {
    let amount: u64 = 50_000_000;
    let expiry_s: i64 = current_ts() + days(1) as i64;
    let nonce = 1;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata) = setup_fixed_delegation(amount, expiry_s, nonce);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let transfer_amount: u64 = 30_000_000;
    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let del_amount = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(del_amount, 20_000_000);

    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed();

    result.assert_err(SubscriptionsError::AmountExceedsLimit);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let del_amount = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(del_amount, 20_000_000);
}

#[test]
fn test_fixed_transfer_exceeds_amount() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 1;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata) = setup_fixed_delegation(amount, expiry_ts, nonce);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let transfer_amount: u64 = 60_000_000;
    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed();

    // Check that the error matches AmountExceedsLimit
    result.assert_err(SubscriptionsError::AmountExceedsLimit);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let del_amount = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(del_amount, 50_000_000);
}

#[test]
fn test_fixed_transfer_expired() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 1;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata) = setup_fixed_delegation(amount, expiry_ts, nonce);

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let transfer_amount: u64 = 30_000_000;
    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed();

    result.assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

    // Now let's move the clock and try to transfer again
    move_clock_forward(&mut litesvm, (current_ts() + (days(2) as i64)) as u64);

    let transfer_amount: u64 = 30_000_000;
    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed();

    result.assert_err(SubscriptionsError::DelegationExpired);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 30_000_000);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let delegation_amount = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(delegation_amount, 20_000_000);
}

#[test]
fn test_fixed_transfer_wrong_signer() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 10;

    let (mut litesvm, alice, _bob, delegation_pda, mint, _, bob_ata) = setup_fixed_delegation(amount, expiry_ts, nonce);

    // Eve is the attacker
    let eve = Keypair::new();
    litesvm.airdrop(&eve.pubkey(), 1_000_000).unwrap();

    let transfer_amount: u64 = 10_000_000;

    // Use the new helper
    let result = TransferDelegation::new(&mut litesvm, &eve, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .to(bob_ata)
        .fixed();

    // Expect Unauthorized error
    result.assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn test_fixed_transfer_to_third_party() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    // Alice delegates to Bob
    let (mut litesvm, alice, bob, delegation_pda, mint, _, _) = setup_fixed_delegation(amount, expiry_ts, nonce);

    // Charlie is a third party
    let charlie = Keypair::new();
    let charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 0);

    let transfer_amount: u64 = 10_000_000;

    // Bob transfers from Alice -> Charlie
    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .to(charlie_ata)
        .fixed()
        .assert_ok();

    // Verify Charlie received funds
    assert_eq!(get_ata_balance(&litesvm, &charlie_ata), 10_000_000);
}

#[test]
fn fixed_delegation_rejects_transfer_with_different_mint_authority() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let low_value_mint =
        init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let high_value_mint =
        init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);

    let _alice_low_ata = init_ata(&mut litesvm, low_value_mint, alice.pubkey(), 100_000_000);
    let alice_high_ata = init_ata(&mut litesvm, high_value_mint, alice.pubkey(), 100_000_000);
    let _bob_low_ata = init_ata(&mut litesvm, low_value_mint, bob.pubkey(), 0);
    let bob_high_ata = init_ata(&mut litesvm, high_value_mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, low_value_mint).0.assert_ok();
    initialize_subscription_authority_action(&mut litesvm, &alice, high_value_mint).0.assert_ok();

    let fixed_allowance = 50_000_000;
    let (res, low_value_delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, low_value_mint, bob.pubkey())
        .nonce(89)
        .fixed(fixed_allowance, current_ts() + days(1) as i64);
    res.assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), high_value_mint, low_value_delegation_pda)
        .amount(20_000_000)
        .fixed()
        .assert_err(SubscriptionsError::InvalidDelegatePda);

    assert_eq!(get_ata_balance(&litesvm, &alice_high_ata), 100_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_high_ata), 0);

    let delegation_account = litesvm.get_account(&low_value_delegation_pda).unwrap();
    let remaining_allowance = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(remaining_allowance, fixed_allowance);
}

#[test]
fn fixed_transfer_rejects_approved_non_canonical_source() {
    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 5_000_000);
    let alice_aux = init_aux_token_account(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    let (res, subscription_authority_pda, _) = initialize_subscription_authority_action(&mut litesvm, &alice, mint);
    res.assert_ok();

    let fixed_allowance = 60_000_000;
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .nonce(87)
        .fixed(fixed_allowance, current_ts() + days(1) as i64);
    res.assert_ok();

    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(alice_aux, false),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new(alice.pubkey(), true),
        ],
        data: Approve { amount: u64::MAX }.pack(),
    };
    build_and_send_transaction(&mut litesvm, &[&alice], &alice.pubkey(), &ix).assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .from(alice_aux)
        .amount(10_000_000)
        .fixed()
        .assert_err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress);

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 5_000_000);
    assert_eq!(get_ata_balance(&litesvm, &alice_aux), 100_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    let delegation_account = litesvm.get_account(&delegation_pda).unwrap();
    let remaining_allowance = FixedDelegation::load(&delegation_account.data).unwrap().amount;
    assert_eq!(remaining_allowance, fixed_allowance);
}

#[test]
fn writable_accounts_must_be_writable() {
    let writable = idl::writable_account_indices("transferFixed");

    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, _) = setup_fixed_delegation(amount, expiry_ts, nonce);
    let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

    let (subscription_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegator_ata = get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let receiver_ata = get_associated_token_address_with_program_id(&bob.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

    for (idx, _name, is_signer) in &writable {
        let mut accounts = vec![
            AccountMeta::new(delegation_pda, false),
            AccountMeta::new_readonly(subscription_authority_pda, false),
            AccountMeta::new(delegator_ata, false),
            AccountMeta::new(receiver_ata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(bob.pubkey(), true),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        // Flip writable account to readonly, preserving signer flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

        let transfer_amount: u64 = 10_000_000;
        let data = [
            vec![*transfer_fixed_delegation::DISCRIMINATOR],
            transfer_amount.to_le_bytes().to_vec(),
            alice.pubkey().to_bytes().to_vec(),
            mint.to_bytes().to_vec(),
        ]
        .concat();

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        let res = build_and_send_transaction(&mut litesvm, &[&fee_payer, &bob], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::AccountNotWritable);
    }
}

#[test]
fn signer_accounts_must_be_signers() {
    let signers = idl::signer_account_indices("transferFixed");

    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, _) = setup_fixed_delegation(amount, expiry_ts, nonce);
    let fee_payer = init_wallet(&mut litesvm, 10_000_000_000);

    let (subscription_authority_pda, _) = get_subscription_authority_pda(&alice.pubkey(), &mint);
    let delegator_ata = get_associated_token_address_with_program_id(&alice.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let receiver_ata = get_associated_token_address_with_program_id(&bob.pubkey(), &mint, &TOKEN_PROGRAM_ID);
    let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

    for (idx, _name, is_writable) in &signers {
        let mut accounts = vec![
            AccountMeta::new(delegation_pda, false),
            AccountMeta::new_readonly(subscription_authority_pda, false),
            AccountMeta::new(delegator_ata, false),
            AccountMeta::new(receiver_ata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(bob.pubkey(), true),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        // Flip signer to non-signer, preserving writable flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] =
            if *is_writable { AccountMeta::new(pubkey, false) } else { AccountMeta::new_readonly(pubkey, false) };

        let transfer_amount: u64 = 10_000_000;
        let data = [
            vec![*transfer_fixed_delegation::DISCRIMINATOR],
            transfer_amount.to_le_bytes().to_vec(),
            alice.pubkey().to_bytes().to_vec(),
            mint.to_bytes().to_vec(),
        ]
        .concat();

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        let res = build_and_send_transaction(&mut litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::NotSigner);
    }
}

#[test]
fn test_fixed_transfer_delegator_mismatch_exploit() {
    // This test demonstrates the access control vulnerability where an attacker
    // can use their own delegation to transfer funds from another user's account

    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    // Setup: Alice (victim) with funds and Bob (attacker)
    let (mut litesvm, alice, bob, _alice_delegation_pda, mint, alice_ata, bob_ata) =
        setup_fixed_delegation(amount, expiry_ts, nonce);

    initialize_subscription_authority_action(&mut litesvm, &bob, mint).0.assert_ok();

    // Attacker (Bob) creates a self-delegation (Bob -> Bob) with a large allowance
    let (_res, bob_delegation_pda) =
        CreateDelegation::new(&mut litesvm, &bob, mint, bob.pubkey()).nonce(nonce).fixed(1_000_000_000, expiry_ts);
    _res.assert_ok();

    let transfer_amount: u64 = 30_000_000;

    // Exploit: Attacker tries to transfer from Alice's ATA using their own delegation
    // by passing Alice's delegator_pubkey in the instruction data
    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, bob_delegation_pda)
        .amount(transfer_amount)
        .to(bob_ata)
        .fixed();

    // After the fix, this should fail with Unauthorized error
    result.assert_err(SubscriptionsError::Unauthorized);

    // Verify Alice's funds are untouched
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
    // Verify Bob received no funds
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn test_fixed_transfer_version_mismatch() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, bob_ata) = setup_fixed_delegation(amount, expiry_ts, nonce);

    let mut account = litesvm.get_account(&delegation_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(delegation_pda, account).unwrap();

    let result =
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda).amount(10_000_000).fixed();

    result.assert_err(SubscriptionsError::MigrationRequired);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn test_fixed_transfer_stale_subscription_authority() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;
    let nonce = 0;

    let (mut litesvm, alice, bob, delegation_pda, mint, alice_ata, bob_ata) =
        setup_fixed_delegation(amount, expiry_ts, nonce);

    CloseSubscriptionAuthority::new(&mut litesvm, &alice, mint).execute().assert_ok();

    move_clock_forward(&mut litesvm, 2);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let result =
        TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda).amount(10_000_000).fixed();

    result.assert_err(SubscriptionsError::StaleSubscriptionAuthority);
    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);

    RevokeDelegation::new(&mut litesvm, &alice, mint, bob.pubkey(), nonce).execute().assert_ok();
}

#[test]
fn test_close_subscription_authority_blocks_all_transfers() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + days(1) as i64;

    let (mut litesvm, alice) = setup();
    let bob = Keypair::new();
    let charlie = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 10_000_000).unwrap();
    litesvm.airdrop(&charlie.pubkey(), 10_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let _bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);
    let _charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (_, del_bob) =
        CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).nonce(0).fixed(amount, expiry_ts);

    let (_, del_charlie) =
        CreateDelegation::new(&mut litesvm, &alice, mint, charlie.pubkey()).nonce(0).fixed(amount, expiry_ts);

    CloseSubscriptionAuthority::new(&mut litesvm, &alice, mint).execute().assert_ok();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, del_bob)
        .amount(10_000_000)
        .fixed()
        .assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);

    TransferDelegation::new(&mut litesvm, &charlie, alice.pubkey(), mint, del_charlie)
        .amount(10_000_000)
        .fixed()
        .assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 100_000_000);

    RevokeDelegation::new(&mut litesvm, &alice, mint, bob.pubkey(), 0).execute().assert_ok();
    RevokeDelegation::new(&mut litesvm, &alice, mint, charlie.pubkey(), 0).execute().assert_ok();
}

#[test]
fn test_fixed_transfer_just_after_expiry_rejected() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + 100;
    let nonce = 0;
    let transfer_amount = 10_000_000;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, _) = setup_fixed_delegation(amount, expiry_ts, nonce);

    move_clock_forward(&mut litesvm, 110);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed()
        .assert_err(SubscriptionsError::DelegationExpired);
}

#[test]
fn test_fixed_transfer_past_drift_window() {
    let amount: u64 = 50_000_000;
    let expiry_ts: i64 = current_ts() + 100;
    let nonce = 0;
    let transfer_amount = 10_000_000;

    let (mut litesvm, alice, bob, delegation_pda, mint, _, _) = setup_fixed_delegation(amount, expiry_ts, nonce);

    move_clock_forward(&mut litesvm, 221);

    let result = TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(transfer_amount)
        .fixed();
    result.assert_err(SubscriptionsError::DelegationExpired);
}
