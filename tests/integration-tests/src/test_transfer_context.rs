//! Transfer-hook screening of the pulling delegate through the ephemeral
//! `TransferContext` account.
//!
//! The hook resolves the context as an external PDA of the subscriptions program
//! (`[Literal("TransferContext"), AccountKey(3)]`), then seeds its own allowlist
//! PDA from the initiator bytes inside it, or dereferences the `delegation`
//! pubkey it records. The token program itself only ever sees the subscription
//! authority as the transfer authority.

use crate::{
    state::{plan::Plan, TransferContext},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
        pda::get_subscription_authority_pda,
        utils::{
            current_ts, days, get_ata_balance, hours, init_ata, init_mint, initialize_subscription_authority_action,
            load_transfer_hook_example, set_transfer_hook_config, setup, CreateDelegation, CreatePlan,
            CreateSubscription, TransferDelegation, TransferSubscription, TRANSFER_HOOK_EXAMPLE_PROGRAM_ID,
        },
    },
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, pubkey_data::PubkeyData, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_token_2022_interface::extension::ExtensionType;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

const ALLOWED_INITIATOR_SEED: &[u8] = b"allow";

/// `spl_tlv_account_resolution::error::AccountResolutionError::IncorrectAccount`.
const RESOLUTION_INCORRECT_ACCOUNT: InstructionError = InstructionError::Custom(2_724_315_840);

const EXECUTE_AUTHORITY_INDEX: u8 = 3;
const EXECUTE_SUBSCRIPTIONS_PROGRAM_INDEX: u8 = 6;
const EXECUTE_TRANSFER_CONTEXT_INDEX: u8 = 7;

const EXECUTE_DELEGATION_INDEX: u8 = 9;

const TRANSFER_CONTEXT_INITIATOR_OFFSET: u8 = 2;
const TRANSFER_CONTEXT_DELEGATION_OFFSET: u8 = 34;
const DELEGATION_DELEGATOR_OFFSET: u8 = 3;
const ADDRESS_LEN: u8 = 32;

fn transfer_context_pda(subscription_authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TransferContext::SEED, subscription_authority.as_ref()], &PROGRAM_ID).0
}

fn validation_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &TRANSFER_HOOK_EXAMPLE_PROGRAM_ID).0
}

fn allowed_initiator_pda(initiator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ALLOWED_INITIATOR_SEED, initiator.as_ref()], &TRANSFER_HOOK_EXAMPLE_PROGRAM_ID).0
}

/// Installs a validation list whose last meta is the hook's allowlist PDA, seeded
/// from the initiator recorded in the subscriptions transfer context.
fn install_initiator_screening_metas(litesvm: &mut LiteSVM, mint: Pubkey) -> Pubkey {
    let program_id = TRANSFER_HOOK_EXAMPLE_PROGRAM_ID;
    let counter = Pubkey::new_unique();

    let metas = [
        ExtraAccountMeta::new_with_pubkey(&counter, false, true).unwrap(),
        ExtraAccountMeta::new_with_pubkey(&PROGRAM_ID, false, false).unwrap(),
        ExtraAccountMeta::new_external_pda_with_seeds(
            EXECUTE_SUBSCRIPTIONS_PROGRAM_INDEX,
            &[
                Seed::Literal { bytes: TransferContext::SEED.to_vec() },
                Seed::AccountKey { index: EXECUTE_AUTHORITY_INDEX },
            ],
            false,
            false,
        )
        .unwrap(),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: ALLOWED_INITIATOR_SEED.to_vec() },
                Seed::AccountData {
                    account_index: EXECUTE_TRANSFER_CONTEXT_INDEX,
                    data_index: TRANSFER_CONTEXT_INITIATOR_OFFSET,
                    length: ADDRESS_LEN,
                },
            ],
            false,
            false,
        )
        .unwrap(),
    ];

    let mut validation_data = vec![0u8; ExtraAccountMetaList::size_of(metas.len()).unwrap()];
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut validation_data, &metas).unwrap();

    let lamports = litesvm.minimum_balance_for_rent_exemption(validation_data.len());
    litesvm
        .set_account(
            validation_pda(mint),
            Account { lamports, data: validation_data, owner: program_id, executable: false, rent_epoch: 0 },
        )
        .unwrap();

    let counter_lamports = litesvm.minimum_balance_for_rent_exemption(1);
    litesvm
        .set_account(
            counter,
            Account {
                lamports: counter_lamports,
                data: vec![0u8; 1],
                owner: program_id,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    counter
}

/// Replaces the fixture's validation list with one that dereferences the
/// `delegation` pubkey out of the context, then seeds an allowlist PDA from the
/// delegator recorded inside that delegation account.
fn install_delegation_deref_metas(litesvm: &mut LiteSVM, mint: Pubkey, counter: Pubkey) {
    let program_id = TRANSFER_HOOK_EXAMPLE_PROGRAM_ID;

    let metas = [
        ExtraAccountMeta::new_with_pubkey(&counter, false, true).unwrap(),
        ExtraAccountMeta::new_with_pubkey(&PROGRAM_ID, false, false).unwrap(),
        ExtraAccountMeta::new_external_pda_with_seeds(
            EXECUTE_SUBSCRIPTIONS_PROGRAM_INDEX,
            &[
                Seed::Literal { bytes: TransferContext::SEED.to_vec() },
                Seed::AccountKey { index: EXECUTE_AUTHORITY_INDEX },
            ],
            false,
            false,
        )
        .unwrap(),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: ALLOWED_INITIATOR_SEED.to_vec() },
                Seed::AccountData {
                    account_index: EXECUTE_TRANSFER_CONTEXT_INDEX,
                    data_index: TRANSFER_CONTEXT_INITIATOR_OFFSET,
                    length: ADDRESS_LEN,
                },
            ],
            false,
            false,
        )
        .unwrap(),
        ExtraAccountMeta::new_with_pubkey_data(
            &PubkeyData::AccountData {
                account_index: EXECUTE_TRANSFER_CONTEXT_INDEX,
                data_index: TRANSFER_CONTEXT_DELEGATION_OFFSET,
            },
            false,
            false,
        )
        .unwrap(),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: ALLOWED_INITIATOR_SEED.to_vec() },
                Seed::AccountData {
                    account_index: EXECUTE_DELEGATION_INDEX,
                    data_index: DELEGATION_DELEGATOR_OFFSET,
                    length: ADDRESS_LEN,
                },
            ],
            false,
            false,
        )
        .unwrap(),
    ];

    let mut validation_data = vec![0u8; ExtraAccountMetaList::size_of(metas.len()).unwrap()];
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut validation_data, &metas).unwrap();

    let lamports = litesvm.minimum_balance_for_rent_exemption(validation_data.len());
    litesvm
        .set_account(
            validation_pda(mint),
            Account { lamports, data: validation_data, owner: program_id, executable: false, rent_epoch: 0 },
        )
        .unwrap();
}

fn allow_initiator(litesvm: &mut LiteSVM, initiator: &Pubkey) {
    let lamports = litesvm.minimum_balance_for_rent_exemption(1);
    litesvm
        .set_account(
            allowed_initiator_pda(initiator),
            Account {
                lamports,
                data: vec![1u8],
                owner: TRANSFER_HOOK_EXAMPLE_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

#[allow(clippy::type_complexity)]
fn setup_screened_delegation() -> (LiteSVM, Keypair, Keypair, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey) {
    let (mut litesvm, alice) = setup();
    load_transfer_hook_example(&mut litesvm);
    let bob = Keypair::new();
    litesvm.airdrop(&bob.pubkey(), 100_000_000).unwrap();

    let mint = init_mint(
        &mut litesvm,
        TOKEN_2022_PROGRAM_ID,
        MINT_DECIMALS,
        1_000_000_000,
        Some(alice.pubkey()),
        &[ExtensionType::TransferHook],
    );
    set_transfer_hook_config(&mut litesvm, mint, Some(alice.pubkey()), Some(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID));
    let counter = install_initiator_screening_metas(&mut litesvm, mint);

    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    let context_pda = transfer_context_pda(&get_subscription_authority_pda(&alice.pubkey(), &mint).0);

    (litesvm, alice, bob, mint, alice_ata, bob_ata, delegation_pda, counter, context_pda)
}

fn hook_accounts(mint: Pubkey, counter: Pubkey, context_pda: Pubkey, initiator: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID, false),
        AccountMeta::new_readonly(validation_pda(mint), false),
        AccountMeta::new(counter, false),
        AccountMeta::new_readonly(PROGRAM_ID, false),
        AccountMeta::new(context_pda, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(allowed_initiator_pda(initiator), false),
    ]
}

#[test]
fn allowlisted_initiator_can_pull() {
    let (mut litesvm, alice, bob, mint, alice_ata, bob_ata, delegation_pda, counter, context_pda) =
        setup_screened_delegation();
    allow_initiator(&mut litesvm, &bob.pubkey());
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
    assert_eq!(litesvm.get_account(&counter).unwrap().data[0], 1, "hook should have run once");
}

#[test]
fn initiator_without_allowlist_entry_cannot_pull() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_err_instruction(InstructionError::InvalidAccountOwner);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn transfer_context_does_not_survive_the_transfer() {
    let (mut litesvm, alice, bob, mint, _, _, delegation_pda, counter, context_pda) = setup_screened_delegation();
    allow_initiator(&mut litesvm, &bob.pubkey());
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());
    let rent_before = litesvm.get_balance(&bob.pubkey()).unwrap();

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert!(
        litesvm.get_account(&context_pda).map(|account| account.lamports == 0).unwrap_or(true),
        "context must be closed once the transfer completes"
    );
    let rent_after = litesvm.get_balance(&bob.pubkey()).unwrap();
    assert!(rent_before - rent_after < 10_000, "initiator should get the context rent back, minus fees");
}

#[test]
fn transfer_without_the_context_account_fails_closed() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    allow_initiator(&mut litesvm, &bob.pubkey());
    let mut remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());
    remaining.retain(|meta| meta.pubkey != context_pda);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_err_instruction(RESOLUTION_INCORRECT_ACCOUNT);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn prefunded_context_address_does_not_block_a_pull() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    allow_initiator(&mut litesvm, &bob.pubkey());
    litesvm
        .set_account(
            context_pda,
            Account { lamports: 1, data: vec![], owner: SYSTEM_PROGRAM_ID, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
}

#[test]
fn recurring_pull_records_the_delegatee_as_initiator() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, _, counter, context_pda) = setup_screened_delegation();
    allow_initiator(&mut litesvm, &bob.pubkey());
    let (res, recurring_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).nonce(1).recurring(
        20_000_000,
        hours(1),
        current_ts(),
        current_ts() + days(1) as i64,
    );
    res.assert_ok();
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, recurring_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .recurring()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
}

#[test]
fn recurring_pull_by_a_blocked_delegatee_is_rejected() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, _, counter, context_pda) = setup_screened_delegation();
    let (res, recurring_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).nonce(1).recurring(
        20_000_000,
        hours(1),
        current_ts(),
        current_ts() + days(1) as i64,
    );
    res.assert_ok();
    let remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, recurring_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .recurring()
        .assert_err_instruction(InstructionError::InvalidAccountOwner);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn subscription_pull_is_screened_on_the_calling_merchant() {
    let (mut litesvm, alice, _, mint, _, _, _, counter, context_pda) = setup_screened_delegation();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();
    let merchant_ata = init_ata(&mut litesvm, mint, merchant.pubkey(), 0);

    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(current_ts() + days(30) as i64)
        .execute();
    res.assert_ok();

    let svm_ts = litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    let plan_terms = {
        let plan_account = litesvm.get_account(&plan_pda).unwrap();
        Plan::load(&plan_account.data).unwrap().data.terms
    };
    let subscription_pda =
        CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts).terms(plan_terms).execute();

    let merchant_hook_accounts = hook_accounts(mint, counter, context_pda, &merchant.pubkey());
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .remaining(merchant_hook_accounts.clone())
        .execute()
        .assert_err_instruction(InstructionError::InvalidAccountOwner);
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);

    allow_initiator(&mut litesvm, &merchant.pubkey());
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .remaining(merchant_hook_accounts)
        .execute()
        .assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);
}

#[test]
fn hook_reads_the_delegation_the_context_points_at() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    install_delegation_deref_metas(&mut litesvm, mint, counter);
    allow_initiator(&mut litesvm, &bob.pubkey());
    allow_initiator(&mut litesvm, &alice.pubkey());

    let mut remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());
    remaining.push(AccountMeta::new_readonly(delegation_pda, false));
    remaining.push(AccountMeta::new_readonly(allowed_initiator_pda(&alice.pubkey()), false));

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 10_000_000);
    assert_eq!(litesvm.get_account(&counter).unwrap().data[0], 1, "hook should have run once");
}

#[test]
fn delegation_deref_rejects_a_substituted_delegation_account() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    install_delegation_deref_metas(&mut litesvm, mint, counter);
    allow_initiator(&mut litesvm, &bob.pubkey());
    allow_initiator(&mut litesvm, &alice.pubkey());

    let (res, decoy_pda) =
        CreateDelegation::new(&mut litesvm, &alice, mint, Pubkey::new_unique()).fixed(1, current_ts() + days(1) as i64);
    res.assert_ok();

    let mut remaining = hook_accounts(mint, counter, context_pda, &bob.pubkey());
    remaining.push(AccountMeta::new_readonly(decoy_pda, false));
    remaining.push(AccountMeta::new_readonly(allowed_initiator_pda(&alice.pubkey()), false));

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_err_instruction(RESOLUTION_INCORRECT_ACCOUNT);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}
