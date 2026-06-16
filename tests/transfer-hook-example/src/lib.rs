//! Minimal Token-2022 transfer-hook program for tests and devnet fixtures.
//! - `Execute`: increments a per-mint counter account (CPI target proof).
//! - `InitializeExtraAccountMetaList`: creates the validation PDA (one
//!   seed-derived counter meta) and the counter PDA so a hooked
//!   `TransferChecked` resolves and runs on-chain.
#![no_std]

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    default_allocator,
    error::ProgramError,
    nostd_panic_handler, program_entrypoint,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

// sha256("spl-transfer-hook-interface:execute")[..8]
const EXECUTE_DISCRIMINATOR: [u8; 8] = [0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a];
// sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[..8]
const INIT_DISCRIMINATOR: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];

// Execute accounts: [source, mint, destination, authority, validation, counter]
const COUNTER_ACCOUNT_INDEX: usize = 5;

const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
const COUNTER_SEED: &[u8] = b"counter";
// ExtraAccountMetaList with one seed-derived counter meta: 8-byte execute
// discriminator, u32 value length (4 + 35), u32 entry count (1), one 35-byte meta.
const VALIDATION_LEN: usize = 51;
const COUNTER_LEN: usize = 1;

program_entrypoint!(process_instruction);
default_allocator!();
nostd_panic_handler!();

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if instruction_data[..8] == INIT_DISCRIMINATOR {
        return initialize_extra_account_metas(program_id, accounts);
    }
    if instruction_data[..8] == EXECUTE_DISCRIMINATOR {
        return execute(accounts);
    }
    Err(ProgramError::InvalidInstructionData)
}

fn execute(accounts: &mut [AccountView]) -> ProgramResult {
    let counter = accounts.get_mut(COUNTER_ACCOUNT_INDEX).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let mut data = counter.try_borrow_mut()?;
    let byte = data.first_mut().ok_or(ProgramError::AccountDataTooSmall)?;
    *byte = byte.wrapping_add(1);
    Ok(())
}

// Accounts: [payer, validation PDA, counter PDA, mint, system program]
fn initialize_extra_account_metas(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let mut mint_key = [0u8; 32];
    mint_key.copy_from_slice(accounts[3].address().as_ref());

    create_pda(accounts, 1, EXTRA_ACCOUNT_METAS_SEED, &mint_key, program_id, VALIDATION_LEN)?;
    write_validation_list(accounts)?;
    create_pda(accounts, 2, COUNTER_SEED, &mint_key, program_id, COUNTER_LEN)?;

    Ok(())
}

fn create_pda(
    accounts: &mut [AccountView],
    account_index: usize,
    prefix: &[u8],
    mint_key: &[u8; 32],
    program_id: &Address,
    space: usize,
) -> ProgramResult {
    let (expected_pda, bump) = Address::find_program_address(&[prefix, mint_key.as_ref()], program_id);
    if expected_pda != *accounts[account_index].address() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let lamports = Rent::get()?.try_minimum_balance(space)?;
    let bump_binding = [bump];
    let seeds = [Seed::from(prefix), Seed::from(mint_key.as_ref()), Seed::from(&bump_binding)];
    let signer = [Signer::from(&seeds)];

    CreateAccount { from: &accounts[0], to: &accounts[account_index], lamports, space: space as u64, owner: program_id }
        .invoke_signed(&signer)
}

// Writes an ExtraAccountMetaList with one PDA meta: counter = PDA of the hook
// program from seeds [Literal("counter"), AccountKey(mint)], writable.
fn write_validation_list(accounts: &mut [AccountView]) -> ProgramResult {
    let mut data = accounts[1].try_borrow_mut()?;
    data[..8].copy_from_slice(&EXECUTE_DISCRIMINATOR);
    data[8..12].copy_from_slice(&((4 + 35) as u32).to_le_bytes());
    data[12..16].copy_from_slice(&1u32.to_le_bytes());
    data[16] = 1; // ExtraAccountMeta discriminator: PDA of the hook program
    data[17] = 1; // seed 0: Literal
    data[18] = COUNTER_SEED.len() as u8;
    data[19..19 + COUNTER_SEED.len()].copy_from_slice(COUNTER_SEED);
    data[26] = 3; // seed 1: AccountKey
    data[27] = 1; // account index 1 = mint
    data[49] = 0; // is_signer
    data[50] = 1; // is_writable
    Ok(())
}
