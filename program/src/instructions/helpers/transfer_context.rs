//! Creation and teardown of the ephemeral [`TransferContext`] account.

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

use super::traits::{AccountCheck, AccountClose, ProgramAccountInit};
use crate::{
    state::common::AccountDiscriminator, ProgramAccount, SubscriptionsError, TransferContext, WritableAccount,
};

/// Who and what a transfer hook needs to see about the in-flight pull.
pub struct TransferContextInput<'a> {
    /// The delegate that initiated the pull; also funds the context account.
    pub initiator: &'a AccountView,
    /// The delegation account authorizing the pull.
    pub delegation: &'a Address,
    /// Discriminator of the account type at `delegation`.
    pub delegation_kind: AccountDiscriminator,
}

/// Creates and populates the [`TransferContext`] for `subscription_authority` when the
/// caller passed its PDA in `remaining`, otherwise does nothing.
///
/// Returns the account so the caller can [`close`] it once the transfer CPI is done.
pub fn open<'a>(
    remaining: &'a [AccountView],
    subscription_authority: &Address,
    input: &TransferContextInput,
) -> Result<Option<&'a AccountView>, ProgramError> {
    let (expected, bump) =
        Address::find_program_address(&[TransferContext::SEED, subscription_authority.as_ref()], &crate::ID);

    let mut found = None;
    let mut has_system_program = false;
    for account in remaining {
        if *account.address() == expected {
            found = Some(account);
        } else if *account.address() == pinocchio_system::ID {
            has_system_program = true;
        }
        if found.is_some() && has_system_program {
            break;
        }
    }

    let Some(context) = found else {
        return Ok(None);
    };
    if !has_system_program {
        return Err(SubscriptionsError::NotSystemProgram.into());
    }

    WritableAccount::check(context)?;
    WritableAccount::check(input.initiator)?;

    let bump_bytes = [bump];
    let seeds =
        [Seed::from(TransferContext::SEED), Seed::from(subscription_authority.as_ref()), Seed::from(&bump_bytes)];
    ProgramAccount::init::<TransferContext>(input.initiator, context, &seeds, TransferContext::LEN)?;

    let mut writable = *context;
    let mut data = writable.try_borrow_mut()?;
    TransferContext::init(&mut data, input.initiator.address(), input.delegation, input.delegation_kind)?;

    Ok(Some(context))
}

/// Closes the context account, refunding rent to the initiator that funded it.
pub fn close(context: &AccountView, initiator: &AccountView) -> ProgramResult {
    ProgramAccount::close(context, initiator)
}
