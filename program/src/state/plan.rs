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
#[codama(seed(type = string(utf8), value = "plan"))]
#[codama(seed(name = "owner", type = public_key))]
#[codama(seed(name = "planId", type = number(u64)))]
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

pub const PLAN_LEN_V1: usize = 491;
const _: () = assert!(Plan::LEN == PLAN_LEN_V1);

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
        let zero = Address::default();
        if self.data.pullers.iter().any(|p| *p != zero && p == caller) {
            return Ok(());
        }
        Err(SubscriptionsError::Unauthorized.into())
    }

    /// Validates that `receiver_owner` is an allowed transfer destination.
    ///
    /// If no destinations are configured (all zero), any receiver is valid.
    /// Otherwise the receiver must appear in the `destinations` whitelist.
    /// Zero-padded slots are skipped so they cannot match a zero-owned receiver.
    pub fn check_destination(&self, receiver_owner: &Address) -> Result<(), ProgramError> {
        let zero = Address::default();
        let mut has_configured = false;
        for d in self.data.destinations.iter() {
            if *d == zero {
                continue;
            }
            if d == receiver_owner {
                return Ok(());
            }
            has_configured = true;
        }
        if has_configured {
            return Err(SubscriptionsError::UnauthorizedDestination.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::transmute;

    fn make_plan(destinations: [Address; 4], pullers: [Address; 4]) -> Plan {
        let mut bytes = vec![0u8; Plan::LEN];
        bytes[0] = AccountDiscriminator::Plan as u8;
        let plan = unsafe { &mut *transmute::<*mut u8, *mut Plan>(bytes.as_mut_ptr()) };
        plan.data.destinations = destinations;
        plan.data.pullers = pullers;
        unsafe { core::ptr::read(plan as *const Plan) }
    }

    fn addr(byte: u8) -> Address {
        let mut a = [0u8; 32];
        a[0] = byte;
        Address::from(a)
    }

    #[test]
    fn check_destination_rejects_zero_owned_receiver_with_partial_whitelist() {
        let merchant = addr(1);
        let plan =
            make_plan([merchant, Address::default(), Address::default(), Address::default()], [Address::default(); 4]);

        plan.check_destination(&merchant).unwrap();
        assert!(plan.check_destination(&Address::default()).is_err());
    }

    #[test]
    fn check_destination_open_when_all_zero() {
        let plan = make_plan([Address::default(); 4], [Address::default(); 4]);
        plan.check_destination(&addr(7)).unwrap();
        plan.check_destination(&Address::default()).unwrap();
    }

    #[test]
    fn can_pull_rejects_zero_caller_with_partial_whitelist() {
        let owner = addr(2);
        let puller = addr(3);
        let mut plan =
            make_plan([Address::default(); 4], [puller, Address::default(), Address::default(), Address::default()]);
        plan.owner = owner;

        plan.can_pull(&owner).unwrap();
        plan.can_pull(&puller).unwrap();
        assert!(plan.can_pull(&Address::default()).is_err());
    }
}
