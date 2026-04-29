use super::traits::{AccountCheck, AccountClose, ProgramAccountInit};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

/// Account check and lifecycle operations for accounts owned by this program.
pub struct ProgramAccount;

impl AccountCheck for ProgramAccount {
    /// Verifies that the account is owned by the subscriptions program.
    fn check(account: &AccountView) -> Result<(), ProgramError> {
        if !account.owned_by(&crate::ID) {
            return Err(ProgramError::InvalidAccountOwner);
        }

        Ok(())
    }
}

/// Creates a PDA account idempotently, handling the case where an attacker
/// has pre-funded the PDA address with lamports to block creation.
impl ProgramAccountInit for ProgramAccount {
    fn init<'a, T: Sized>(
        payer: &AccountView,
        account: &AccountView,
        seeds: &[Seed<'a>],
        space: usize,
    ) -> ProgramResult {
        let lamports = Rent::get()?.try_minimum_balance(space)?;
        let signer = [Signer::from(seeds)];

        if account.lamports() == 0 {
            CreateAccount { from: payer, to: account, lamports, space: space as u64, owner: &crate::ID }
                .invoke_signed(&signer)?;
        } else {
            let required_lamports = lamports.saturating_sub(account.lamports());

            if required_lamports > 0 {
                Transfer { from: payer, to: account, lamports: required_lamports }.invoke()?;
            }

            Allocate { account, space: space as u64 }.invoke_signed(&signer)?;

            Assign { account, owner: &crate::ID }.invoke_signed(&signer)?;
        }

        Ok(())
    }
}

impl AccountClose for ProgramAccount {
    fn close(account: &AccountView, destination: &AccountView) -> ProgramResult {
        let lamports = account.lamports();
        let destination_lamports = destination.lamports();
        let new_balance =
            destination_lamports.checked_add(lamports).ok_or(crate::SubscriptionsError::ArithmeticOverflow)?;
        destination.set_lamports(new_balance);
        account.resize(0)?;
        account.close()
    }
}
