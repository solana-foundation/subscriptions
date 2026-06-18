use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use pinocchio_token::instructions::Revoke as RevokeSpl;
use pinocchio_token_2022::instructions::Revoke as Revoke2022;

use crate::{
    check_token_account_mint, check_token_account_owner, constants::TOKEN_2022_PROGRAM_ID, get_token_account_delegate,
    AccountCheck, AssociatedTokenAccount, AssociatedTokenAccountCheck, MintInterface, SignerAccount,
    SubscriptionAuthority, SubscriptionsError, TokenAccountInterface, TokenProgramInterface, WritableAccount,
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
        MintInterface::check_with_program(token_mint, token_program)?;
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
///
/// Only the SubscriptionAuthority PDA approval is cleared: if the ATA's current
/// delegate is something else, the instruction rejects rather than clearing an
/// unrelated approval; if no delegate is set, it is a no-op.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeSubscriptionAuthorityAccounts::try_from(accounts)?;

    {
        let ata_data = accounts.user_ata.try_borrow()?;
        check_token_account_owner(&ata_data, accounts.user.address())?;
        check_token_account_mint(&ata_data, accounts.token_mint.address())?;

        let expected = SubscriptionAuthority::find_pda(accounts.user.address(), accounts.token_mint.address()).0;
        match get_token_account_delegate(&ata_data)? {
            None => return Ok(()),
            Some(delegate) if delegate != expected => return Err(SubscriptionsError::Unauthorized.into()),
            Some(_) => {}
        }
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
