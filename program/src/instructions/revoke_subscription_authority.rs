use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use pinocchio_token::instructions::Revoke as RevokeSpl;
use pinocchio_token_2022::instructions::Revoke as Revoke2022;

use crate::{
    check_token_account_mint, check_token_account_owner, constants::TOKEN_2022_PROGRAM_ID, AccountCheck,
    AssociatedTokenAccount, AssociatedTokenAccountCheck, SignerAccount, SubscriptionsError, TokenAccountInterface,
    TokenProgramInterface, WritableAccount,
};

/// Validated accounts for the [`RevokeSubscriptionAuthority`](crate::SubscriptionsInstruction::RevokeSubscriptionAuthority) instruction.
pub struct RevokeSubscriptionAuthorityAccounts<'a> {
    pub user: &'a AccountView,
    pub user_ata: &'a AccountView,
    pub token_mint: &'a AccountView,
    pub token_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for RevokeSubscriptionAuthorityAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, user_ata, token_mint, token_program, ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user_ata)?;
        TokenProgramInterface::check(token_program)?;
        TokenAccountInterface::check_with_program(user_ata, token_program)?;

        Ok(Self { user, user_ata, token_mint, token_program })
    }
}

/// Instruction discriminator byte for `RevokeSubscriptionAuthority`.
pub const DISCRIMINATOR: &u8 = &14;

/// Revokes the delegate that `InitSubscriptionAuthority` granted on the user's
/// ATA. SPL Token `Revoke` is owner-signed, so this works whether or not the
/// SubscriptionAuthority PDA still exists — clearing the approval left behind
/// after `CloseSubscriptionAuthority`.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeSubscriptionAuthorityAccounts::try_from(accounts)?;

    {
        let ata_data = accounts.user_ata.try_borrow()?;
        check_token_account_owner(&ata_data, accounts.user.address())?;
        check_token_account_mint(&ata_data, accounts.token_mint.address())?;
    }
    AssociatedTokenAccount::check(accounts.user_ata, accounts.user, accounts.token_mint, accounts.token_program)?;

    if accounts.token_program.address().eq(&TOKEN_2022_PROGRAM_ID) {
        Revoke2022 {
            source: accounts.user_ata,
            authority: accounts.user,
            token_program: accounts.token_program.address(),
        }
        .invoke()
    } else {
        RevokeSpl::new(accounts.user_ata, accounts.user).invoke()
    }
}
