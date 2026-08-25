//! Transfer-hook screening of the pulling delegate through the ephemeral
//! `TransferContext` account.
//!
//! The hook resolves the context as an external PDA of the subscriptions program
//! (`[Literal("TransferContext"), AccountKey(3)]`), then resolves its own allowlist
//! PDA from the initiator bytes inside that context. An initiator without an
//! allowlist entry cannot pull, even though the token program only ever sees the
//! subscription authority as the transfer authority.

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
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022_interface::extension::ExtensionType;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

const ALLOWED_INITIATOR_SEED: &[u8] = b"allow";

const EXECUTE_AUTHORITY_INDEX: u8 = 3;
const EXECUTE_SUBSCRIPTIONS_PROGRAM_INDEX: u8 = 6;
const EXECUTE_TRANSFER_CONTEXT_INDEX: u8 = 7;

const TRANSFER_CONTEXT_INITIATOR_OFFSET: u8 = 3;
const ADDRESS_LEN: u8 = 32;

fn transfer_context_pda(subscription_authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TransferContext::SEED, subscription_authority.as_ref()], &PROGRAM_ID).0
}

fn allowed_initiator_pda(initiator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ALLOWED_INITIATOR_SEED, initiator.as_ref()], &TRANSFER_HOOK_EXAMPLE_PROGRAM_ID).0
}

/// Installs a validation list whose last meta is the hook's allowlist PDA, seeded
/// from the initiator recorded in the subscriptions transfer context.
fn install_initiator_screening_metas(litesvm: &mut LiteSVM, mint: Pubkey) -> (Pubkey, Pubkey) {
    let program_id = TRANSFER_HOOK_EXAMPLE_PROGRAM_ID;
    let (validation_pda, _) = Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &program_id);
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
            validation_pda,
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

    (validation_pda, counter)
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

struct Fixture {
    litesvm: LiteSVM,
    alice: Keypair,
    bob: Keypair,
    mint: Pubkey,
    alice_ata: Pubkey,
    bob_ata: Pubkey,
    delegation_pda: Pubkey,
    validation_pda: Pubkey,
    counter: Pubkey,
    context_pda: Pubkey,
}

fn fixture() -> Fixture {
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
    let (validation_pda, counter) = install_initiator_screening_metas(&mut litesvm, mint);

    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    let context_pda = transfer_context_pda(&get_subscription_authority_pda(&alice.pubkey(), &mint).0);

    Fixture { litesvm, alice, bob, mint, alice_ata, bob_ata, delegation_pda, validation_pda, counter, context_pda }
}

fn hook_accounts(f: &Fixture, initiator: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID, false),
        AccountMeta::new_readonly(f.validation_pda, false),
        AccountMeta::new(f.counter, false),
        AccountMeta::new_readonly(PROGRAM_ID, false),
        AccountMeta::new(f.context_pda, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(allowed_initiator_pda(initiator), false),
    ]
}

#[test]
fn allowlisted_initiator_can_pull() {
    let mut f = fixture();
    allow_initiator(&mut f.litesvm, &f.bob.pubkey());
    let remaining = hook_accounts(&f, &f.bob.pubkey());

    TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, f.delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&f.litesvm, &f.alice_ata), 90_000_000);
    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 10_000_000);
    assert_eq!(f.litesvm.get_account(&f.counter).unwrap().data[0], 1, "hook should have run once");
}

#[test]
fn initiator_without_allowlist_entry_cannot_pull() {
    let mut f = fixture();
    let remaining = hook_accounts(&f, &f.bob.pubkey());

    let res = TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, f.delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed();

    assert!(res.is_err(), "hook must reject an initiator it has not allowlisted");
    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 0);
}

#[test]
fn transfer_context_does_not_survive_the_transfer() {
    let mut f = fixture();
    allow_initiator(&mut f.litesvm, &f.bob.pubkey());
    let remaining = hook_accounts(&f, &f.bob.pubkey());
    let rent_before = f.litesvm.get_balance(&f.bob.pubkey()).unwrap();

    TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, f.delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert!(
        f.litesvm.get_account(&f.context_pda).map(|account| account.lamports == 0).unwrap_or(true),
        "context must be closed once the transfer completes"
    );
    let rent_after = f.litesvm.get_balance(&f.bob.pubkey()).unwrap();
    assert!(rent_before - rent_after < 10_000, "initiator should get the context rent back, minus fees");
}

#[test]
fn transfer_without_the_context_account_fails_closed() {
    let mut f = fixture();
    allow_initiator(&mut f.litesvm, &f.bob.pubkey());
    let mut remaining = hook_accounts(&f, &f.bob.pubkey());
    remaining.retain(|meta| meta.pubkey != f.context_pda);

    let res = TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, f.delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed();

    assert!(res.is_err(), "resolution must fail when the context the hook requires is missing");
    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 0);
}

#[test]
fn prefunded_context_address_does_not_block_a_pull() {
    let mut f = fixture();
    allow_initiator(&mut f.litesvm, &f.bob.pubkey());
    f.litesvm
        .set_account(
            f.context_pda,
            Account { lamports: 1, data: vec![], owner: SYSTEM_PROGRAM_ID, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    let remaining = hook_accounts(&f, &f.bob.pubkey());

    TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, f.delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_ok();

    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 10_000_000);
}

#[test]
fn recurring_pull_records_the_delegatee_as_initiator() {
    let mut f = fixture();
    allow_initiator(&mut f.litesvm, &f.bob.pubkey());
    let (res, recurring_pda) = CreateDelegation::new(&mut f.litesvm, &f.alice, f.mint, f.bob.pubkey())
        .nonce(1)
        .recurring(20_000_000, hours(1), current_ts(), current_ts() + days(1) as i64);
    res.assert_ok();
    let remaining = hook_accounts(&f, &f.bob.pubkey());

    TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, recurring_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .recurring()
        .assert_ok();

    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 10_000_000);
}

#[test]
fn recurring_pull_by_a_blocked_delegatee_is_rejected() {
    let mut f = fixture();
    let (res, recurring_pda) = CreateDelegation::new(&mut f.litesvm, &f.alice, f.mint, f.bob.pubkey())
        .nonce(1)
        .recurring(20_000_000, hours(1), current_ts(), current_ts() + days(1) as i64);
    res.assert_ok();
    let remaining = hook_accounts(&f, &f.bob.pubkey());

    let res = TransferDelegation::new(&mut f.litesvm, &f.bob, f.alice.pubkey(), f.mint, recurring_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .recurring();

    assert!(res.is_err(), "hook must screen recurring pulls on the same initiator");
    assert_eq!(get_ata_balance(&f.litesvm, &f.bob_ata), 0);
}

#[test]
fn subscription_pull_is_screened_on_the_calling_merchant() {
    let mut f = fixture();
    let merchant = Keypair::new();
    f.litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();
    let merchant_ata = init_ata(&mut f.litesvm, f.mint, merchant.pubkey(), 0);

    let (res, plan_pda) = CreatePlan::new(&mut f.litesvm, &merchant, f.mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(current_ts() + days(30) as i64)
        .execute();
    res.assert_ok();

    let svm_ts = f.litesvm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    let plan_terms = {
        let plan_account = f.litesvm.get_account(&plan_pda).unwrap();
        Plan::load(&plan_account.data).unwrap().data.terms
    };
    let subscription_pda =
        CreateSubscription::new(&mut f.litesvm, plan_pda, f.alice.pubkey(), f.mint, svm_ts).terms(plan_terms).execute();

    let merchant_hook_accounts = hook_accounts(&f, &merchant.pubkey());
    let blocked =
        TransferSubscription::new(&mut f.litesvm, &merchant, f.alice.pubkey(), f.mint, subscription_pda, plan_pda)
            .amount(10_000_000)
            .to(merchant_ata)
            .remaining(merchant_hook_accounts.clone())
            .execute();
    assert!(blocked.is_err(), "an unscreened merchant must not be able to pull");
    assert_eq!(get_ata_balance(&f.litesvm, &merchant_ata), 0);

    allow_initiator(&mut f.litesvm, &merchant.pubkey());
    TransferSubscription::new(&mut f.litesvm, &merchant, f.alice.pubkey(), f.mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .remaining(merchant_hook_accounts)
        .execute()
        .assert_ok();
    assert_eq!(get_ata_balance(&f.litesvm, &merchant_ata), 10_000_000);
}
