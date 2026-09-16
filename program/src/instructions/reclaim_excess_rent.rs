use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    reclaim_excess,
    state::{
        common::AccountDiscriminator, plan::Plan, subscription_authority::SubscriptionAuthority,
        versioning::check_and_update_version,
    },
    AccountCheck, ProgramAccount, SubscriptionsError, WritableAccount, DISCRIMINATOR_OFFSET, PAYER_OFFSET,
};

/// Validated accounts for the [`ReclaimExcessRent`](crate::SubscriptionsInstruction::ReclaimExcessRent) instruction.
pub struct ReclaimExcessRentAccounts<'a> {
    /// The program-owned PDA holding lamports above the rent-exempt minimum.
    pub target_account: &'a mut AccountView,
    /// The account receiving the excess. Must match the address recorded on `target_account`.
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

/// Returns lamports held above the current rent-exempt minimum to the account
/// that funded the PDA, without closing it or touching its data.
///
/// Accounts created before a network-wide rent reduction hold more lamports
/// than the current minimum requires. The floor is recomputed from the rent
/// sysvar on every call, so one instruction covers every future reduction step.
///
/// Permissionless: the receiver is forced to the address recorded on the target
/// account, so the caller can only route funds back to whoever is owed them.
///
/// The recorded address is the original `payer` for
/// [`SubscriptionAuthority`] and the three delegation kinds, and the `owner`
/// for [`Plan`], matching where each account's rent goes on close.
pub fn process(accounts: &mut [AccountView]) -> ProgramResult {
    let accounts = ReclaimExcessRentAccounts::try_from(accounts)?;

    let recorded = {
        let mut data = accounts.target_account.try_borrow_mut()?;

        if data.is_empty() {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }

        let kind = AccountDiscriminator::try_from(data[DISCRIMINATOR_OFFSET])?;

        match kind {
            AccountDiscriminator::FixedDelegation
            | AccountDiscriminator::RecurringDelegation
            | AccountDiscriminator::SubscriptionDelegation => {
                check_and_update_version(&mut data, kind)?;
                read_address(&data, PAYER_OFFSET)?
            }
            AccountDiscriminator::SubscriptionAuthority => SubscriptionAuthority::load(&data)?.payer,
            AccountDiscriminator::Plan => Plan::load(&data)?.owner,
        }
    };

    if *accounts.receiver.address() != recorded {
        return Err(SubscriptionsError::Unauthorized.into());
    }

    reclaim_excess(accounts.target_account, accounts.receiver)?;

    Ok(())
}

fn read_address(data: &[u8], offset: usize) -> Result<Address, ProgramError> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(SubscriptionsError::InvalidPayerData)?;

    Ok(Address::from(bytes))
}
