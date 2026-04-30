use super::traits::AccountCheck;
use crate::{state::common::AccountDiscriminator, SubscriptionAuthority, SubscriptionsError, DISCRIMINATOR_OFFSET};
use pinocchio::{error::ProgramError, AccountView};

/// Validates that an account is a transaction signer.
pub struct SignerAccount;

impl AccountCheck for SignerAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_signer() {
            return Err(SubscriptionsError::NotSigner.into());
        }
        Ok(())
    }
}

/// Validates that an account is marked writable in the transaction.
pub struct WritableAccount;

impl AccountCheck for WritableAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_writable() {
            return Err(SubscriptionsError::AccountNotWritable.into());
        }
        Ok(())
    }
}

/// Validates that the account is the System Program.
pub struct SystemAccount;

impl AccountCheck for SystemAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if account.address().ne(&pinocchio_system::ID) {
            return Err(SubscriptionsError::NotSystemProgram.into());
        }

        Ok(())
    }
}

/// Returns the optional sponsor (signer + writable) from the trailing remainder if present, else falls back to `primary`.
pub fn resolve_optional_payer<'a>(
    primary: &'a AccountView,
    rem: &'a [AccountView],
) -> Result<&'a AccountView, ProgramError> {
    if let Some(payer) = rem.first() {
        SignerAccount::check(payer)?;
        WritableAccount::check(payer)?;
        Ok(payer)
    } else {
        Ok(primary)
    }
}

/// Validates that the account is a program-owned [`SubscriptionAuthority`] PDA with the correct
/// discriminator and size.
pub struct SubscriptionAuthorityAccount;

impl AccountCheck for SubscriptionAuthorityAccount {
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&crate::ID) {
            return Err(SubscriptionsError::InvalidSubscriptionAuthorityPda.into());
        }
        let data = account.try_borrow()?;
        if data.len() != SubscriptionAuthority::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if data[DISCRIMINATOR_OFFSET] != AccountDiscriminator::SubscriptionAuthority as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(())
    }
}
