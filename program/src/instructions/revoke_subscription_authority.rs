use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use pinocchio_token::instructions::Revoke as RevokeSpl;
use pinocchio_token_2022::instructions::Revoke as Revoke2022;

use crate::{
    check_token_account_mint, check_token_account_owner, close_authority, constants::TOKEN_2022_PROGRAM_ID,
    get_token_account_delegate, AccountCheck, AssociatedTokenAccount, AssociatedTokenAccountCheck, MintInterface,
    SignerAccount, SubscriptionAuthority, SubscriptionsError, TokenAccountInterface, TokenProgramInterface,
    WritableAccount,
};

/// Validated accounts for the [`RevokeSubscriptionAuthority`](crate::SubscriptionsInstruction::RevokeSubscriptionAuthority) instruction.
pub struct RevokeSubscriptionAuthorityAccounts<'a> {
    pub user: &'a AccountView,
    pub user_ata: &'a AccountView,
    pub token_mint: &'a AccountView,
    pub token_program: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    /// Optional rent destination required when the SubscriptionAuthority is still
    /// open and its recorded payer differs from the user. Must match that payer.
    pub receiver: Option<&'a AccountView>,
}

impl<'a> TryFrom<&'a [AccountView]> for RevokeSubscriptionAuthorityAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, user_ata, token_mint, token_program, subscription_authority, rem @ ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user)?;
        WritableAccount::check(user_ata)?;
        TokenProgramInterface::check(token_program)?;
        MintInterface::check_with_program(token_mint, token_program)?;
        TokenAccountInterface::check_with_program(user_ata, token_program)?;
        WritableAccount::check(subscription_authority)?;

        Ok(Self { user, user_ata, token_mint, token_program, subscription_authority, receiver: rem.first() })
    }
}

/// Instruction discriminator byte for `RevokeSubscriptionAuthority`.
pub const DISCRIMINATOR: &u8 = &14;

/// Closes the SubscriptionAuthority PDA when open. A foreign or absent delegate
/// is left untouched.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeSubscriptionAuthorityAccounts::try_from(accounts)?;

    let (expected_delegate, current_delegate) = {
        let ata_data = accounts.user_ata.try_borrow()?;
        check_token_account_owner(&ata_data, accounts.user.address())?;
        check_token_account_mint(&ata_data, accounts.token_mint.address())?;

        let expected = SubscriptionAuthority::find_pda(accounts.user.address(), accounts.token_mint.address()).0;
        (expected, get_token_account_delegate(&ata_data)?)
    };

    AssociatedTokenAccount::check(accounts.user_ata, accounts.user, accounts.token_mint, accounts.token_program)?;

    // Revoke before close so the account-closing lamport move is the last mutation.
    if current_delegate == Some(expected_delegate) {
        if accounts.token_program.address().eq(&TOKEN_2022_PROGRAM_ID) {
            Revoke2022 {
                source: accounts.user_ata,
                authority: accounts.user,
                token_program: accounts.token_program.address(),
            }
            .invoke()?;
        } else {
            RevokeSpl::new(accounts.user_ata, accounts.user).invoke()?;
        }
    }

    let authority = accounts.subscription_authority;
    if authority.owned_by(&crate::ID) && authority.data_len() > 0 {
        if expected_delegate != *authority.address() {
            return Err(SubscriptionsError::InvalidSubscriptionAuthorityPda.into());
        }
        close_authority(accounts.user, authority, accounts.receiver)?;
    }

    Ok(())
}
