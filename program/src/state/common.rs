//! Shared account types, PDA derivation helpers, and enums used across all state modules.

use codama::CodamaType;
use pinocchio::error::ProgramError;
use pinocchio::Address;

use crate::{constants::SECS_PER_HOUR, SubscriptionsError};

/// PDA seed prefix used for delegation accounts (fixed, recurring).
pub const DELEGATE_BASE_SEED: &[u8] = b"delegation";

/// Verifies a delegation PDA by re-deriving with the given bump.
///
/// Returns the derived address on success, or [`SubscriptionsError::InvalidDelegatePda`]
/// if the bump is invalid.
pub fn verify_delegation_pda(
    subscription_authority: &Address,
    delegator: &Address,
    delegatee: &Address,
    nonce: u64,
    bump: u8,
) -> Result<Address, ProgramError> {
    Address::create_program_address(
        &[
            DELEGATE_BASE_SEED,
            subscription_authority.as_ref(),
            delegator.as_ref(),
            delegatee.as_ref(),
            &nonce.to_le_bytes(),
            &[bump],
        ],
        &crate::ID,
    )
    .map_err(|_| SubscriptionsError::InvalidDelegatePda.into())
}

/// Finds the canonical delegation PDA and bump for the given seeds.
pub fn find_delegation_pda(
    subscription_authority: &Address,
    delegator: &Address,
    delegatee: &Address,
    nonce: u64,
) -> (Address, u8) {
    Address::find_program_address(
        &[
            DELEGATE_BASE_SEED,
            subscription_authority.as_ref(),
            delegator.as_ref(),
            delegatee.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &crate::ID,
    )
}

/// One-byte discriminator identifying the type of a program-owned account.
///
/// Stored at byte offset 0 of every account created by this program.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Debug, CodamaType)]
pub enum AccountDiscriminator {
    /// [`SubscriptionAuthority`](super::subscription_authority::SubscriptionAuthority) account.
    SubscriptionAuthority = 0,
    /// [`Plan`](super::plan::Plan) account.
    Plan = 1,
    /// [`FixedDelegation`](super::fixed_delegation::FixedDelegation) account.
    FixedDelegation = 2,
    /// [`RecurringDelegation`](super::recurring_delegation::RecurringDelegation) account.
    RecurringDelegation = 3,
    /// [`SubscriptionDelegation`](super::subscription_delegation::SubscriptionDelegation) account.
    SubscriptionDelegation = 4,
    /// [`UpToDelegation`](super::up_to_delegation::UpToDelegation) account.
    UpToDelegation = 5,
}

impl TryFrom<u8> for AccountDiscriminator {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::SubscriptionAuthority),
            1 => Ok(Self::Plan),
            2 => Ok(Self::FixedDelegation),
            3 => Ok(Self::RecurringDelegation),
            4 => Ok(Self::SubscriptionDelegation),
            5 => Ok(Self::UpToDelegation),
            _ => Err(SubscriptionsError::InvalidAccountDiscriminator.into()),
        }
    }
}

impl From<AccountDiscriminator> for u8 {
    fn from(val: AccountDiscriminator) -> Self {
        match val {
            AccountDiscriminator::SubscriptionAuthority => 0,
            AccountDiscriminator::Plan => 1,
            AccountDiscriminator::FixedDelegation => 2,
            AccountDiscriminator::RecurringDelegation => 3,
            AccountDiscriminator::SubscriptionDelegation => 4,
            AccountDiscriminator::UpToDelegation => 5,
        }
    }
}

/// Lifecycle status of a subscription [`Plan`](super::plan::Plan).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Debug, CodamaType)]
pub enum PlanStatus {
    /// The plan is in sunset mode -- no new subscriptions are accepted, but
    /// existing subscriptions remain active until their end timestamp.
    Sunset = 0,
    /// The plan is active and accepting new subscriptions.
    Active = 1,
}

impl TryFrom<u8> for PlanStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Sunset),
            1 => Ok(Self::Active),
            _ => Err(SubscriptionsError::InvalidAccountData.into()),
        }
    }
}

/// Verifies a plan PDA by re-deriving with the given bump.
///
/// Returns the derived address on success, or [`SubscriptionsError::InvalidPlanPda`]
/// if the bump is invalid.
pub fn verify_plan_pda(owner: &Address, plan_id: u64, bump: u8) -> Result<Address, ProgramError> {
    Address::create_program_address(
        &[crate::state::plan::Plan::SEED, owner.as_ref(), &plan_id.to_le_bytes(), &[bump]],
        &crate::ID,
    )
    .map_err(|_| SubscriptionsError::InvalidPlanPda.into())
}

/// Finds the canonical plan PDA and bump for the given owner and plan id.
pub fn find_plan_pda(owner: &Address, plan_id: u64) -> (Address, u8) {
    Address::find_program_address(&[crate::state::plan::Plan::SEED, owner.as_ref(), &plan_id.to_le_bytes()], &crate::ID)
}

/// Rejects non-zero `end_ts` that falls within one billing period of `current_time`.
pub fn validate_plan_end_ts(end_ts: i64, period_hours: u64, current_time: i64) -> Result<(), SubscriptionsError> {
    if end_ts != 0 {
        let period_secs = (period_hours * SECS_PER_HOUR) as i64;
        if current_time + period_secs > end_ts {
            return Err(SubscriptionsError::InvalidEndTs);
        }
    }
    Ok(())
}

/// Finds the canonical subscription PDA and bump for a given plan and subscriber.
pub fn find_subscription_pda(plan_pda: &Address, subscriber: &Address) -> (Address, u8) {
    Address::find_program_address(
        &[crate::state::subscription_delegation::SubscriptionDelegation::SEED, plan_pda.as_ref(), subscriber.as_ref()],
        &crate::ID,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_ts_zero_always_valid() {
        assert!(validate_plan_end_ts(0, 720, 1_000_000).is_ok());
        assert!(validate_plan_end_ts(0, 1, 0).is_ok());
    }

    #[test]
    fn end_ts_exactly_one_period_ahead() {
        let current = 1_000_000i64;
        let period_hours = 720u64;
        let end_ts = current + (period_hours * SECS_PER_HOUR) as i64;
        assert!(validate_plan_end_ts(end_ts, period_hours, current).is_ok());
    }

    #[test]
    fn end_ts_less_than_one_period_ahead() {
        let current = 1_000_000i64;
        let period_hours = 720u64;
        let end_ts = current + (period_hours * SECS_PER_HOUR) as i64 - 1;
        assert!(validate_plan_end_ts(end_ts, period_hours, current).is_err());
    }

    #[test]
    fn end_ts_well_beyond_period() {
        let current = 1_000_000i64;
        let period_hours = 720u64;
        let end_ts = current + (period_hours * SECS_PER_HOUR * 2) as i64;
        assert!(validate_plan_end_ts(end_ts, period_hours, current).is_ok());
    }

    #[test]
    fn end_ts_near_immediate() {
        let current = 1_000_000i64;
        assert!(validate_plan_end_ts(current + 1, 720, current).is_err());
    }
}
