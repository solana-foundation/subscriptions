use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    state::{
        common::AccountDiscriminator, fixed_delegation::FixedDelegation, recurring_delegation::RecurringDelegation,
    },
    AccountCheck, AccountClose, Header, ProgramAccount, SignerAccount, SubscriptionAuthority, SubscriptionsError,
    WritableAccount, DISCRIMINATOR_OFFSET,
};

/// Validated accounts for the [`RevokeAbandonedDelegation`](crate::SubscriptionsInstruction::RevokeAbandonedDelegation) instruction.
pub struct RevokeAbandonedDelegationAccounts<'a> {
    /// The recorded payer reclaiming rent (signer + writable).
    pub payer: &'a AccountView,
    /// The fixed or recurring delegation PDA to close.
    pub delegation_account: &'a AccountView,
    /// The SubscriptionAuthority PDA recorded on the delegation; may be closed.
    pub subscription_authority: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for RevokeAbandonedDelegationAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [payer, delegation_account, subscription_authority, ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(payer)?;
        WritableAccount::check(payer)?;
        WritableAccount::check(delegation_account)?;
        ProgramAccount::check(delegation_account)?;

        Ok(Self { payer, delegation_account, subscription_authority })
    }
}

/// Instruction discriminator byte for `RevokeAbandonedDelegation`.
pub const DISCRIMINATOR: &u8 = &15;

/// Closes a fixed or recurring delegation back to its payer once the delegator
/// has rendered it permanently unusable — its SubscriptionAuthority PDA is
/// closed, or that PDA's `init_id` no longer matches the delegation header.
///
/// This is the payer's only recovery path for `expiry_ts == 0` delegations,
/// which [`RevokeDelegation`](crate::SubscriptionsInstruction::RevokeDelegation)
/// can never close. Both dead states are irreversible, so a live delegation can
/// never be closed here.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeAbandonedDelegationAccounts::try_from(accounts)?;

    {
        let data = accounts.delegation_account.try_borrow()?;
        if data.len() < Header::LEN {
            return Err(SubscriptionsError::InvalidHeaderData.into());
        }

        let (recorded_authority, recorded_init_id, payer) =
            match AccountDiscriminator::try_from(data[DISCRIMINATOR_OFFSET])? {
                AccountDiscriminator::FixedDelegation => {
                    let delegation = FixedDelegation::load_with_min_size(&data)?;
                    (delegation.subscription_authority, delegation.header.init_id, delegation.header.payer)
                }
                AccountDiscriminator::RecurringDelegation => {
                    let delegation = RecurringDelegation::load_with_min_size(&data)?;
                    (delegation.subscription_authority, delegation.header.init_id, delegation.header.payer)
                }
                _ => return Err(SubscriptionsError::InvalidAccountDiscriminator.into()),
            };

        if payer != *accounts.payer.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        if recorded_authority != *accounts.subscription_authority.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        let authority_is_dead = if !accounts.subscription_authority.owned_by(&crate::ID) {
            true
        } else {
            let authority_data = accounts.subscription_authority.try_borrow()?;
            match SubscriptionAuthority::load(&authority_data) {
                Ok(authority) => authority.init_id != recorded_init_id,
                Err(_) => true,
            }
        };

        if !authority_is_dead {
            return Err(SubscriptionsError::Unauthorized.into());
        }
    }

    ProgramAccount::close(accounts.delegation_account, accounts.payer)
}
