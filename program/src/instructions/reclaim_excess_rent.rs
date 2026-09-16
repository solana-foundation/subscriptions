use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    reclaim_excess,
    state::{
        common::AccountDiscriminator, fixed_delegation::FixedDelegation, plan::Plan,
        recurring_delegation::RecurringDelegation, subscription_authority::SubscriptionAuthority,
        subscription_delegation::SubscriptionDelegation, versioning::check_and_update_version,
    },
    AccountCheck, ProgramAccount, SubscriptionsError, WritableAccount, DISCRIMINATOR_OFFSET,
};

/// Validated accounts for the [`ReclaimExcessRent`](crate::SubscriptionsInstruction::ReclaimExcessRent) instruction.
pub struct ReclaimExcessRentAccounts<'a> {
    pub target_account: &'a mut AccountView,
    /// Must match the address recorded on `target_account`.
    pub receiver: &'a AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for ReclaimExcessRentAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        let [target_account, receiver] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        WritableAccount::check(target_account)?;
        WritableAccount::check(receiver)?;
        ProgramAccount::check(target_account)?;

        Ok(Self { target_account, receiver })
    }
}

/// Instruction discriminator byte for `ReclaimExcessRent`.
pub const DISCRIMINATOR: &u8 = &18;

/// Returns lamports above the rent-exempt minimum to the address recorded on
/// the PDA, without closing it or touching its data. The floor is read from the
/// rent sysvar on every call.
///
/// Permissionless: the receiver is forced to the recorded address, the `payer`
/// for [`SubscriptionAuthority`] and the three delegation kinds and the `owner`
/// for [`Plan`], matching where rent goes on close.
pub fn process(accounts: &mut [AccountView]) -> ProgramResult {
    let accounts = ReclaimExcessRentAccounts::try_from(accounts)?;

    let original_funder = {
        let mut data = accounts.target_account.try_borrow_mut()?;

        if data.is_empty() {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }

        let kind = AccountDiscriminator::try_from(data[DISCRIMINATOR_OFFSET])?;

        match kind {
            AccountDiscriminator::FixedDelegation => {
                check_and_update_version(&mut data, kind)?;
                FixedDelegation::load_for_revoke(&data)?.header.payer
            }
            AccountDiscriminator::RecurringDelegation => {
                check_and_update_version(&mut data, kind)?;
                RecurringDelegation::load_for_revoke(&data)?.header.payer
            }
            AccountDiscriminator::SubscriptionDelegation => {
                check_and_update_version(&mut data, kind)?;
                SubscriptionDelegation::load_for_revoke(&data)?.header.payer
            }
            AccountDiscriminator::SubscriptionAuthority => SubscriptionAuthority::load(&data)?.payer,
            AccountDiscriminator::Plan => Plan::load(&data)?.owner,
        }
    };

    if *accounts.receiver.address() != original_funder {
        return Err(SubscriptionsError::Unauthorized.into());
    }

    reclaim_excess(accounts.target_account, accounts.receiver)?;

    Ok(())
}
