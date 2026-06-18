use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{close_authority, AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount};

/// Validated accounts for the [`CloseSubscriptionAuthority`](crate::SubscriptionsInstruction::CloseSubscriptionAuthority) instruction.
pub struct CloseSubscriptionAuthorityAccounts<'a> {
    pub user: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    /// Optional rent destination required when the recorded payer differs from
    /// the user. Must match the stored `SubscriptionAuthority.payer`.
    pub receiver: Option<&'a AccountView>,
}

impl<'a> TryFrom<&'a [AccountView]> for CloseSubscriptionAuthorityAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, subscription_authority, rem @ ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user)?;
        WritableAccount::check(subscription_authority)?;
        ProgramAccount::check(subscription_authority)?;

        Ok(Self { user, subscription_authority, receiver: rem.first() })
    }
}

/// Instruction discriminator byte for `CloseSubscriptionAuthority`.
pub const DISCRIMINATOR: &u8 = &6;

/// Closes a SubscriptionAuthority PDA account, returning the lamports to the recorded
/// payer (which is the user when no sponsor funded creation, or the sponsor
/// otherwise).
///
/// Only the user who owns the SubscriptionAuthority can close it. When the recorded
/// payer differs from the user, an optional `receiver` account must be
/// provided that matches the stored payer.
///
/// A sponsor (recorded `payer != user`) receives the rent on close but cannot
/// initiate it: sponsoring a SubscriptionAuthority is a non-recoverable subsidy
/// unless the user closes the account. This is intentional — the authority is
/// the user's; letting a sponsor force-close a healthy one would rotate its
/// `init_id` and break the user's live subscriptions.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = CloseSubscriptionAuthorityAccounts::try_from(accounts)?;
    close_authority(accounts.user, accounts.subscription_authority, accounts.receiver)
}
