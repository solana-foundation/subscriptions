//! Subscription plan account.

use codama::CodamaAccount;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::{state::common::AccountDiscriminator, SubscriptionsError};

pub use crate::instructions::create_plan::PlanData;

/// Byte offset of the discriminator within a [`Plan`] account.
pub const PLAN_DISCRIMINATOR_OFFSET: usize = 0;

/// A merchant-defined subscription plan.
///
/// Plans specify the token mint, amount per period, period length, optional end
/// timestamp, whitelisted destination wallets, and authorized puller addresses.
/// Subscribers create [`SubscriptionDelegation`](super::subscription_delegation::SubscriptionDelegation)
/// accounts that reference this plan.
///
/// **PDA seeds:** `["plan", owner, plan_id]`
#[repr(C, packed)]
#[derive(CodamaAccount)]
pub struct Plan {
    /// Account type discriminator ([`AccountDiscriminator::Plan`]).
    pub discriminator: u8,
    /// The merchant wallet that owns and administers this plan.
    pub owner: Address,
    /// PDA bump seed.
    pub bump: u8,
    /// Plan lifecycle status (see [`PlanStatus`](crate::PlanStatus)).
    pub status: u8,
    /// The plan's configuration data (amount, period, destinations, etc.).
    pub data: PlanData,
}

impl Plan {
    /// Total serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"plan";

    /// Deserializes an immutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[PLAN_DISCRIMINATOR_OFFSET] != AccountDiscriminator::Plan as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(bytes.as_ptr()) })
    }

    /// Deserializes a mutable reference from raw account data.
    ///
    /// Returns an error if the data length or discriminator does not match.
    pub fn load_mut(bytes: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if bytes.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidAccountData.into());
        }
        if bytes[PLAN_DISCRIMINATOR_OFFSET] != AccountDiscriminator::Plan as u8 {
            return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
        }
        Ok(unsafe { &mut *transmute::<*mut u8, *mut Self>(bytes.as_mut_ptr()) })
    }

    /// Checks that `caller` is authorized to pull transfers for this plan.
    ///
    /// The caller must be the plan owner or listed in the `pullers` array.
    pub fn can_pull(&self, caller: &Address) -> Result<(), ProgramError> {
        if *caller == self.owner {
            return Ok(());
        }
        if self.data.pullers.contains(caller) {
            return Ok(());
        }
        Err(SubscriptionsError::Unauthorized.into())
    }

    /// Validates that `receiver_owner` is an allowed transfer destination.
    ///
    /// If no destinations are configured (all zero), any receiver is valid.
    /// Otherwise the receiver must appear in the `destinations` whitelist.
    pub fn check_destination(&self, receiver_owner: &Address) -> Result<(), ProgramError> {
        let zero = Address::default();
        let has_destinations = self.data.destinations.iter().any(|d| *d != zero);
        if has_destinations && !self.data.destinations.contains(receiver_owner) {
            return Err(SubscriptionsError::UnauthorizedDestination.into());
        }
        Ok(())
    }
}
