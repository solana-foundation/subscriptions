//! Minimal Token-2022 transfer-hook program (Execute only) used as a CPI target in tests.
#![no_std]

use pinocchio::{
    account::AccountView, default_allocator, error::ProgramError, nostd_panic_handler, program_entrypoint, Address,
    ProgramResult,
};

const EXECUTE_DISCRIMINATOR: [u8; 8] = [0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a]; // sha256("spl-transfer-hook-interface:execute")[..8]

// Execute accounts: [source, mint, destination, authority, validation, counter]
const COUNTER_ACCOUNT_INDEX: usize = 5;

program_entrypoint!(process_instruction);
default_allocator!();
nostd_panic_handler!();

pub fn process_instruction(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < EXECUTE_DISCRIMINATOR.len()
        || instruction_data[..EXECUTE_DISCRIMINATOR.len()] != EXECUTE_DISCRIMINATOR
    {
        return Err(ProgramError::InvalidInstructionData);
    }

    let counter = accounts.get_mut(COUNTER_ACCOUNT_INDEX).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let mut data = counter.try_borrow_mut()?;
    let byte = data.first_mut().ok_or(ProgramError::AccountDataTooSmall)?;
    *byte = byte.wrapping_add(1);

    Ok(())
}
