use pinocchio::{AccountView, ProgramResult};

use crate::{AccountCheck, AccountClose, ProgramAccount, SubscriptionAuthority, SubscriptionsError, WritableAccount};

/// Closes a program-owned SubscriptionAuthority PDA, returning rent to the
/// recorded payer. Caller must ensure the account is program-owned.
///
/// When the recorded payer differs from the user, `receiver` is required and
/// must match that payer.
pub fn close_authority(
    user: &AccountView,
    subscription_authority: &AccountView,
    receiver: Option<&AccountView>,
) -> ProgramResult {
    let (stored_payer, payer_is_user) = {
        let data = subscription_authority.try_borrow()?;
        let authority = SubscriptionAuthority::load(&data)?;

        authority.check_owner(user.address())?;

        let expected_pda = SubscriptionAuthority::verify_pda(&authority.user, &authority.token_mint, authority.bump)?;
        if expected_pda.as_ref() != subscription_authority.address().as_ref() {
            return Err(SubscriptionsError::InvalidSubscriptionAuthorityPda.into());
        }

        let stored_payer = authority.payer;
        (stored_payer, stored_payer == *user.address())
    };

    if payer_is_user {
        ProgramAccount::close(subscription_authority, user)
    } else {
        let receiver = receiver.ok_or(SubscriptionsError::NotEnoughAccountKeys)?;
        WritableAccount::check(receiver)?;
        if *receiver.address() != stored_payer {
            return Err(SubscriptionsError::Unauthorized.into());
        }
        ProgramAccount::close(subscription_authority, receiver)
    }
}
