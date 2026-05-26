use rstest::rstest;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::ExtensionType;

use crate::{
    instructions::initialize_subscription_authority,
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
        idl,
        pda::get_subscription_authority_pda,
        utils::{
            build_and_send_transaction, fetch_account, init_ata, init_aux_token_account, init_mint, init_wallet,
            initialize_subscription_authority_action, initialize_subscription_authority_action_with_sponsor,
            set_transfer_hook_config, setup,
        },
    },
    AccountDiscriminator, SubscriptionAuthority, SubscriptionsError,
};

#[test]
fn initialize_subscription_authority() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (res, subscription_authority_pda, bump) = initialize_subscription_authority_action(litesvm, user, mint);
    res.assert_ok();

    let account = litesvm.get_account(&subscription_authority_pda).unwrap();
    let subscription_authority = SubscriptionAuthority::load(&account.data).unwrap();

    assert_eq!(subscription_authority.discriminator, AccountDiscriminator::SubscriptionAuthority as u8);
    assert_eq!(subscription_authority.user.to_bytes(), user.pubkey().to_bytes());
    assert_eq!(subscription_authority.token_mint.to_bytes(), mint.to_bytes());
    // Default payer is the user when no sponsor is supplied.
    assert_eq!(subscription_authority.payer.to_bytes(), user.pubkey().to_bytes());
    assert_eq!(subscription_authority.bump, bump);
    assert!(subscription_authority.init_id >= 0);

    // Verify delegation
    let ata_account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, &user_ata);
    assert!(ata_account.delegate.is_some());
    assert_eq!(ata_account.delegate.unwrap(), subscription_authority_pda);
    assert_eq!(ata_account.delegated_amount, u64::MAX);
}

#[test]
fn initialize_subscription_authority_rejects_non_canonical_token_account() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let aux_token_account = init_aux_token_account(litesvm, mint, user.pubkey(), 1_000_000);
    let (subscription_authority_pda, _) = get_subscription_authority_pda(&user.pubkey(), &mint);

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(aux_token_account, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![*initialize_subscription_authority::DISCRIMINATOR],
    };

    build_and_send_transaction(litesvm, &[user], &user.pubkey(), &ix)
        .assert_err(SubscriptionsError::InvalidAssociatedTokenAccountDerivedAddress);
}

#[test]
fn initialize_subscription_authority_with_sponsor() {
    let (litesvm, user) = &mut setup();
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let user_balance_before = litesvm.get_account(&user.pubkey()).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    let (res, subscription_authority_pda, _bump) =
        initialize_subscription_authority_action_with_sponsor(litesvm, user, mint, Some(&sponsor));
    res.assert_ok();

    let account = litesvm.get_account(&subscription_authority_pda).unwrap();
    let md = SubscriptionAuthority::load(&account.data).unwrap();
    assert_eq!(md.user.to_bytes(), user.pubkey().to_bytes());
    assert_eq!(md.payer.to_bytes(), sponsor.pubkey().to_bytes());

    // Sponsor pays both rent and the transaction fee. User must not be charged.
    let user_balance_after = litesvm.get_account(&user.pubkey()).unwrap().lamports;
    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert_eq!(user_balance_after, user_balance_before);
    assert!(sponsor_balance_after < sponsor_balance_before);

    // Verify Approve still went through with user as the ATA authority.
    let ata_account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, &user_ata);
    assert_eq!(ata_account.delegate.unwrap(), subscription_authority_pda);
    assert_eq!(ata_account.delegated_amount, u64::MAX);
}

#[rstest]
#[case::no_extensions(&[], None)]
#[case::confidential_transfer(
        &[ExtensionType::ConfidentialTransferMint],
        None
    )]
#[case::non_transferable(
        &[ExtensionType::NonTransferable],
        None
    )]
#[case::permanent_delegate(
        &[ExtensionType::PermanentDelegate],
        None
    )]
#[case::transfer_fee(
        &[ExtensionType::TransferFeeConfig],
        None
    )]
#[case::transfer_hook_unconfigured(
        &[ExtensionType::TransferHook],
        None
    )]
#[case::pausable(
        &[ExtensionType::Pausable],
        None
    )]
#[case::close_authority(
        &[ExtensionType::MintCloseAuthority],
        None
    )]
#[case::mixed_allowed(
        &[ExtensionType::TransferFeeConfig, ExtensionType::TransferHook],
        None
    )]
#[case::mixed_allowed_confidential(
        &[ExtensionType::MintCloseAuthority, ExtensionType::ConfidentialTransferMint],
        None
    )]
fn initialize_subscription_authority_token_2022(
    #[case] extensions: &[ExtensionType],
    #[case] expected_error: Option<SubscriptionsError>,
) {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_2022_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), extensions);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (res, subscription_authority_pda, bump) = initialize_subscription_authority_action(litesvm, user, mint);

    match expected_error {
        Some(err) => res.assert_err(err),
        None => {
            res.assert_ok();

            let account = litesvm.get_account(&subscription_authority_pda).unwrap();
            let subscription_authority = SubscriptionAuthority::load(&account.data).unwrap();

            assert_eq!(subscription_authority.discriminator, AccountDiscriminator::SubscriptionAuthority as u8);
            assert_eq!(subscription_authority.user.to_bytes(), user.pubkey().to_bytes());
            assert_eq!(subscription_authority.token_mint.to_bytes(), mint.to_bytes());
            assert_eq!(subscription_authority.bump, bump);
            assert!(subscription_authority.init_id >= 0);

            // Verify delegation
            let ata_account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, &user_ata);
            assert!(ata_account.delegate.is_some());
            assert_eq!(ata_account.delegate.unwrap(), subscription_authority_pda);
            assert_eq!(ata_account.delegated_amount, u64::MAX);
        }
    }
}

#[test]
fn initialize_subscription_authority_rejects_transfer_hook_with_program_id() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(
        litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(user.pubkey()),
        &[ExtensionType::TransferHook],
    );
    set_transfer_hook_config(litesvm, mint, None, Some(Pubkey::new_unique()));
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_err(SubscriptionsError::MintHasTransferHook);
}

#[test]
fn initialize_subscription_authority_rejects_mutable_transfer_hook() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(
        litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(user.pubkey()),
        &[ExtensionType::TransferHook],
    );
    set_transfer_hook_config(litesvm, mint, Some(user.pubkey()), None);
    init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_err(SubscriptionsError::MintHasTransferHook);
}

#[test]
fn wrong_token_program_returns_error() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (subscription_authority_pda, _bump) = get_subscription_authority_pda(&user.pubkey(), &mint);

    let fake_token_program = user.pubkey();

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(fake_token_program, false),
        ],
        data: vec![*initialize_subscription_authority::DISCRIMINATOR],
    };

    let res = build_and_send_transaction(litesvm, &[user], &user.pubkey(), &ix);
    assert!(res.is_err());
}

/// Verify that pre-funding a SubscriptionAuthority PDA with lamports (DOS attack)
/// does not prevent the legitimate user from creating the account.
#[test]
fn initialize_subscription_authority_with_prefunded_pda() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    // Simulate an attacker pre-funding the PDA address with lamports
    let (subscription_authority_pda, _) = crate::tests::pda::get_subscription_authority_pda(&user.pubkey(), &mint);
    litesvm
        .set_account(
            subscription_authority_pda,
            Account {
                lamports: 1_000,
                data: vec![],
                owner: solana_pubkey::Pubkey::default(), // system program
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    // The user should still be able to initialize the subscription_authority PDA
    let (res, _, bump) = initialize_subscription_authority_action(litesvm, user, mint);
    res.assert_ok();

    let account = litesvm.get_account(&subscription_authority_pda).unwrap();
    let subscription_authority = SubscriptionAuthority::load(&account.data).unwrap();

    assert_eq!(subscription_authority.discriminator, AccountDiscriminator::SubscriptionAuthority as u8);
    assert_eq!(subscription_authority.user.to_bytes(), user.pubkey().to_bytes());
    assert_eq!(subscription_authority.token_mint.to_bytes(), mint.to_bytes());
    assert_eq!(subscription_authority.bump, bump);
    assert!(subscription_authority.init_id >= 0);

    // Verify delegation
    let ata_account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, &user_ata);
    assert!(ata_account.delegate.is_some());
    assert_eq!(ata_account.delegate.unwrap(), subscription_authority_pda);
    assert_eq!(ata_account.delegated_amount, u64::MAX);
}

#[test]
fn initialize_subscription_authority_with_overfunded_pda() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (subscription_authority_pda, _) = crate::tests::pda::get_subscription_authority_pda(&user.pubkey(), &mint);

    litesvm
        .set_account(
            subscription_authority_pda,
            Account {
                lamports: 10_000_000,
                data: vec![],
                owner: solana_pubkey::Pubkey::default(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let (res, _, bump) = initialize_subscription_authority_action(litesvm, user, mint);
    res.assert_ok();

    let account = litesvm.get_account(&subscription_authority_pda).unwrap();
    let subscription_authority = SubscriptionAuthority::load(&account.data).unwrap();

    assert_eq!(subscription_authority.discriminator, AccountDiscriminator::SubscriptionAuthority as u8);
    assert_eq!(subscription_authority.user.to_bytes(), user.pubkey().to_bytes());
    assert_eq!(subscription_authority.token_mint.to_bytes(), mint.to_bytes());
    assert_eq!(subscription_authority.bump, bump);

    let ata_account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, &user_ata);
    assert!(ata_account.delegate.is_some());
    assert_eq!(ata_account.delegate.unwrap(), subscription_authority_pda);
    assert_eq!(ata_account.delegated_amount, u64::MAX);
}

#[test]
fn writable_accounts_must_be_writable() {
    let writable = idl::writable_account_indices("initSubscriptionAuthority");

    let (litesvm, user) = &mut setup();
    let fee_payer = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    let (subscription_authority_pda, _) = get_subscription_authority_pda(&user.pubkey(), &mint);

    for (idx, _name, is_signer) in &writable {
        let mut accounts = vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];

        // Flip writable account to readonly, preserving signer flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: vec![*initialize_subscription_authority::DISCRIMINATOR],
        };

        let res = build_and_send_transaction(litesvm, &[&fee_payer, user], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::AccountNotWritable);
    }
}

#[test]
fn signer_accounts_must_be_signers() {
    let signers = idl::signer_account_indices("initSubscriptionAuthority");

    let (litesvm, user) = &mut setup();
    let fee_payer = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
    let (subscription_authority_pda, _) = get_subscription_authority_pda(&user.pubkey(), &mint);

    for (idx, _name, is_writable) in &signers {
        let mut accounts = vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];

        // Flip signer to non-signer, preserving writable flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] =
            if *is_writable { AccountMeta::new(pubkey, false) } else { AccountMeta::new_readonly(pubkey, false) };

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: vec![*initialize_subscription_authority::DISCRIMINATOR],
        };

        let res = build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::NotSigner);
    }
}

/// A trailing account is interpreted as the optional sponsor payer.
/// A non-signer extra must be rejected because the payer slot requires a
/// signer.
#[test]
fn non_signer_payer_rejected() {
    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    let (subscription_authority_pda, _bump) = get_subscription_authority_pda(&user.pubkey(), &mint);

    // Random pubkey that is NOT a signer in this transaction.
    let extra_account = Pubkey::new_unique();

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(extra_account, false),
        ],
        data: vec![*initialize_subscription_authority::DISCRIMINATOR],
    };

    let res = build_and_send_transaction(litesvm, &[user], &user.pubkey(), &ix);
    res.assert_err(SubscriptionsError::NotSigner);
}
