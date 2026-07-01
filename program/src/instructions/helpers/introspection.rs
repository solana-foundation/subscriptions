use pinocchio::{error::ProgramError, sysvars::instructions::Instructions, AccountView, Address};

const INIT_AUTHORITY_DISCRIMINATOR: u8 = 0;
const INIT_OWNER_ACCOUNT_INDEX: usize = 0;
const INIT_AUTHORITY_ACCOUNT_INDEX: usize = 1;

/// Returns `true` when an `InitSubscriptionAuthority` instruction earlier in the
/// current transaction creates `authority_pda` for `expected_owner`.
///
/// Reads only top-level instructions: a call reached via CPI sees no sibling
/// init and the caller falls back to the stored-`init_id` check.
pub fn subscription_authority_inited_in_tx(
    instructions_sysvar: &AccountView,
    authority_pda: &Address,
    expected_owner: &Address,
) -> Result<bool, ProgramError> {
    let instructions = Instructions::try_from(instructions_sysvar)?;
    let current_index = instructions.load_current_index();

    for index in 0..current_index {
        let instruction = instructions.load_instruction_at(index as usize)?;

        if instruction.get_program_id() != &crate::ID {
            continue;
        }
        if instruction.get_instruction_data().first() != Some(&INIT_AUTHORITY_DISCRIMINATOR) {
            continue;
        }

        let authority = instruction.get_instruction_account_at(INIT_AUTHORITY_ACCOUNT_INDEX)?;
        let owner = instruction.get_instruction_account_at(INIT_OWNER_ACCOUNT_INDEX)?;

        if &authority.key == authority_pda && &owner.key == expected_owner {
            return Ok(true);
        }
    }

    Ok(false)
}
