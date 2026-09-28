//! Transfer-hook screening of the pulling delegate through the ephemeral
//! `TransferContext` account.
//!
//! The hook resolves the context as an external PDA of the subscriptions program
//! (`[Literal("TransferContext"), AccountKey(3)]`) and compares the initiator it
//! records against its own policy account. Both resolve from fixed seeds, so
//! transfers of the mint that are not subscriptions pulls still resolve and run.
//! The token program itself only ever sees the subscription authority as the
//! transfer authority.

use crate::{
    state::{plan::Plan, TransferContext},
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
        pda::get_subscription_authority_pda,
        utils::{
            build_and_send_transaction, current_ts, days, get_ata_balance, hours, init_ata, init_mint,
            initialize_subscription_authority_action, load_transfer_hook_example, set_transfer_hook_config, setup,
            CreateDelegation, CreatePlan, CreateSubscription, TransferDelegation, TransferSubscription,
            TRANSFER_HOOK_EXAMPLE_PROGRAM_ID,
        },
    },
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022_interface::{extension::ExtensionType, instruction::transfer_checked};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

const INITIATOR_POLICY_SEED: &[u8] = b"policy";

/// `spl_tlv_account_resolution::error::AccountResolutionError::IncorrectAccount`.
const RESOLUTION_INCORRECT_ACCOUNT: InstructionError = InstructionError::Custom(2_724_315_840);
const EXECUTE_MINT_INDEX: u8 = 1;
const EXECUTE_AUTHORITY_INDEX: u8 = 3;
const EXECUTE_SUBSCRIPTIONS_PROGRAM_INDEX: u8 = 6;

fn transfer_context_pda(subscription_authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TransferContext::SEED, subscription_authority.as_ref()], &PROGRAM_ID).0
}

fn validation_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &TRANSFER_HOOK_EXAMPLE_PROGRAM_ID).0
}

fn initiator_policy_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[INITIATOR_POLICY_SEED, mint.as_ref()], &TRANSFER_HOOK_EXAMPLE_PROGRAM_ID).0
}

/// Installs a validation list whose metas are all derived from fixed seeds, so
/// every transfer of the mint resolves even when no context exists. The hook
/// compares the recorded initiator against the policy account in `Execute`.
fn install_screening_metas(litesvm: &mut LiteSVM, mint: Pubkey) -> Pubkey {
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
            &[Seed::Literal { bytes: INITIATOR_POLICY_SEED.to_vec() }, Seed::AccountKey { index: EXECUTE_MINT_INDEX }],
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

fn hook_accounts(mint: Pubkey, counter: Pubkey, context_pda: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(TRANSFER_HOOK_EXAMPLE_PROGRAM_ID, false),
        AccountMeta::new_readonly(validation_pda(mint), false),
        AccountMeta::new(counter, false),
        AccountMeta::new_readonly(PROGRAM_ID, false),
        AccountMeta::new(context_pda, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(initiator_policy_pda(mint), false),
    ]
}

/// A plain wallet-to-wallet `TransferChecked`, with the hook accounts the mint's
/// validation list resolves to. No subscriptions instruction is involved.
#[allow(clippy::result_large_err)]
fn wallet_transfer(
    litesvm: &mut LiteSVM,
    owner: &Keypair,
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    amount: u64,
    hook_metas: Vec<AccountMeta>,
) -> TransactionResult {
    let mut ix = transfer_checked(
        &TOKEN_2022_PROGRAM_ID,
        &source,
        &mint,
        &destination,
        &owner.pubkey(),
        &[],
        amount,
        MINT_DECIMALS,
    )
    .unwrap();
    ix.accounts.extend(hook_metas);
    build_and_send_transaction(litesvm, &[owner], &owner.pubkey(), &ix)
}

/// Names the one initiator the hook will let pull this mint.
fn set_policy(litesvm: &mut LiteSVM, mint: Pubkey, allowed: &Pubkey) {
    let lamports = litesvm.minimum_balance_for_rent_exemption(32);
    litesvm
        .set_account(
            initiator_policy_pda(mint),
            Account {
                lamports,
                data: allowed.to_bytes().to_vec(),
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
    let counter = install_screening_metas(&mut litesvm, mint);

    let alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
    let bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 0);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();
    let (res, delegation_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey())
        .fixed(50_000_000, current_ts() + days(1) as i64);
    res.assert_ok();

    let context_pda = transfer_context_pda(&get_subscription_authority_pda(&alice.pubkey(), &mint).0);

    (litesvm, alice, bob, mint, alice_ata, bob_ata, delegation_pda, counter, context_pda)
}

#[test]
fn allowed_initiator_can_pull() {
    let (mut litesvm, alice, bob, mint, alice_ata, bob_ata, delegation_pda, counter, context_pda) =
        setup_screened_delegation();
    set_policy(&mut litesvm, mint, &bob.pubkey());
    let remaining = hook_accounts(mint, counter, context_pda);

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
fn pull_without_a_policy_account_is_rejected() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    let remaining = hook_accounts(mint, counter, context_pda);

    TransferDelegation::new(&mut litesvm, &bob, alice.pubkey(), mint, delegation_pda)
        .amount(10_000_000)
        .remaining(remaining)
        .fixed()
        .assert_err_instruction(InstructionError::InvalidAccountOwner);
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 0);
}

#[test]
fn initiator_outside_the_policy_cannot_pull() {
    let (mut litesvm, alice, bob, mint, _, bob_ata, delegation_pda, counter, context_pda) = setup_screened_delegation();
    set_policy(&mut litesvm, mint, &Pubkey::new_unique());
    let remaining = hook_accounts(mint, counter, context_pda);

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
    set_policy(&mut litesvm, mint, &bob.pubkey());
    let remaining = hook_accounts(mint, counter, context_pda);
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
    set_policy(&mut litesvm, mint, &bob.pubkey());
    let mut remaining = hook_accounts(mint, counter, context_pda);
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
    set_policy(&mut litesvm, mint, &bob.pubkey());
    litesvm
        .set_account(
            context_pda,
            Account { lamports: 1, data: vec![], owner: SYSTEM_PROGRAM_ID, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    let remaining = hook_accounts(mint, counter, context_pda);

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
    set_policy(&mut litesvm, mint, &bob.pubkey());
    let (res, recurring_pda) = CreateDelegation::new(&mut litesvm, &alice, mint, bob.pubkey()).nonce(1).recurring(
        20_000_000,
        hours(1),
        current_ts(),
        current_ts() + days(1) as i64,
    );
    res.assert_ok();
    let remaining = hook_accounts(mint, counter, context_pda);

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
    let remaining = hook_accounts(mint, counter, context_pda);

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

    let merchant_hook_accounts = hook_accounts(mint, counter, context_pda);
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .remaining(merchant_hook_accounts.clone())
        .execute()
        .assert_err_instruction(InstructionError::InvalidAccountOwner);
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 0);

    set_policy(&mut litesvm, mint, &merchant.pubkey());
    TransferSubscription::new(&mut litesvm, &merchant, alice.pubkey(), mint, subscription_pda, plan_pda)
        .amount(10_000_000)
        .to(merchant_ata)
        .remaining(merchant_hook_accounts)
        .execute()
        .assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &merchant_ata), 10_000_000);
}

/// A context-shaped account at the right address but owned by someone else must
/// not be read as a pull: the policy names a different initiator, so honouring it
/// would reject this transfer.
#[test]
fn a_context_the_subscriptions_program_does_not_own_is_ignored() {
    let (mut litesvm, alice, _, mint, alice_ata, bob_ata, _, counter, _) = setup_screened_delegation();
    set_policy(&mut litesvm, mint, &Pubkey::new_unique());
    let wallet_context = transfer_context_pda(&alice.pubkey());

    let mut forged = vec![0u8; 67];
    forged[0] = 5;
    forged[2..34].copy_from_slice(&alice.pubkey().to_bytes());
    let lamports = litesvm.minimum_balance_for_rent_exemption(forged.len());
    litesvm
        .set_account(
            wallet_context,
            Account { lamports, data: forged, owner: Pubkey::new_unique(), executable: false, rent_epoch: 0 },
        )
        .unwrap();

    wallet_transfer(
        &mut litesvm,
        &alice,
        mint,
        alice_ata,
        bob_ata,
        1_000_000,
        hook_accounts(mint, counter, wallet_context),
    )
    .assert_ok();
    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 1_000_000);
}

#[test]
fn wallet_transfers_of_the_mint_still_work() {
    let (mut litesvm, alice, _, mint, alice_ata, bob_ata, _, counter, _) = setup_screened_delegation();
    let wallet_context = transfer_context_pda(&alice.pubkey());

    wallet_transfer(
        &mut litesvm,
        &alice,
        mint,
        alice_ata,
        bob_ata,
        1_000_000,
        hook_accounts(mint, counter, wallet_context),
    )
    .assert_ok();

    assert_eq!(get_ata_balance(&litesvm, &bob_ata), 1_000_000);
    assert_eq!(litesvm.get_account(&counter).unwrap().data[0], 1, "hook should have run and fallen through");
    assert!(litesvm.get_account(&wallet_context).map(|account| account.data.is_empty()).unwrap_or(true));
}
