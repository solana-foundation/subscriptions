use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    event_engine::{self, EventSerialize},
    events::PlanUpdatedEvent,
    state::{
        common::{validate_plan_end_ts, PlanStatus},
        plan::Plan,
    },
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction data payload for updating a plan's mutable fields.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct UpdatePlanData {
    /// New plan status (see [`PlanStatus`]). Setting to
    /// `Sunset` prevents new subscriptions and requires a non-zero `end_ts`.
    pub status: u8,
    /// New end timestamp. `0` means no end (only valid for active plans).
    pub end_ts: i64,
    /// Updated puller whitelist.
    pub pullers: [Address; 4],
    /// Updated metadata URI.
    #[codama(type = fixed_size(string(utf8), 128))]
    pub metadata_uri: [u8; 128],
}

impl UpdatePlanData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }

    /// Validates the update's status byte is a known [`PlanStatus`].
    pub fn validate(&self) -> Result<(), SubscriptionsError> {
        PlanStatus::try_from(self.status).map_err(|_| SubscriptionsError::InvalidPlanStatus)?;
        Ok(())
    }
}

/// Validated accounts for the [`UpdatePlan`](crate::SubscriptionsInstruction::UpdatePlan) instruction.
pub struct UpdatePlanAccounts<'a> {
    pub owner: &'a AccountView,
    pub plan_pda: &'a mut AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for UpdatePlanAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        let [owner, plan_pda, event_authority, self_program] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(owner)?;
        WritableAccount::check(plan_pda)?;
        ProgramAccount::check(plan_pda)?;

        Ok(Self { owner, plan_pda, event_authority, self_program })
    }
}

/// Instruction discriminator byte for `UpdatePlan`.
pub const DISCRIMINATOR: &u8 = &8;

/// Validates a post-sunset update: everything but the puller list must be
/// unchanged, and the new pullers must be a subset of the current ones (removals
/// only — no reactivation, additions, substitutions, or term changes).
fn assert_sunset_puller_reduction(plan: &Plan, data: &UpdatePlanData) -> Result<(), ProgramError> {
    if data.status != PlanStatus::Sunset as u8 || data.end_ts != plan.data.end_ts {
        return Err(SubscriptionsError::PlanImmutableAfterSunset.into());
    }

    let new_metadata = data.metadata_uri;
    let current_metadata = plan.data.metadata_uri;
    if new_metadata != current_metadata {
        return Err(SubscriptionsError::PlanImmutableAfterSunset.into());
    }

    let zero = Address::default();
    let current_pullers = plan.data.pullers;
    let new_pullers = data.pullers;
    for new_puller in new_pullers.iter() {
        if *new_puller != zero && !current_pullers.iter().any(|p| p == new_puller) {
            return Err(SubscriptionsError::PlanImmutableAfterSunset.into());
        }
    }

    Ok(())
}

/// Updates the mutable fields of an existing [`Plan`].
///
/// Only the plan owner may call this. A `Sunset` plan is immutable except for
/// removing pullers (see [`assert_sunset_puller_reduction`]).
pub fn process(accounts: &mut [AccountView], data: &UpdatePlanData) -> ProgramResult {
    let accounts = UpdatePlanAccounts::try_from(accounts)?;

    let owner = {
        let account_data = &mut accounts.plan_pda.try_borrow_mut()?;
        let plan = Plan::load_mut(account_data)?;

        if &plan.owner != accounts.owner.address() {
            return Err(SubscriptionsError::NotPlanOwner.into());
        }

        if plan.status == PlanStatus::Sunset as u8 {
            // Sunset plans are otherwise immutable, but the owner may still remove
            // pullers as incident response against a compromised one.
            assert_sunset_puller_reduction(plan, data)?;
            plan.data.pullers = data.pullers;
            plan.owner
        } else {
            if data.status == PlanStatus::Sunset as u8 && data.end_ts == 0 {
                return Err(SubscriptionsError::SunsetRequiresEndTs.into());
            }

            let current_ts = Clock::get()?.unix_timestamp;
            data.validate()?;

            if plan.data.end_ts != 0 && current_ts > plan.data.end_ts {
                return Err(SubscriptionsError::PlanExpired.into());
            }

            // A finite end_ts may only be shortened, never removed or extended.
            let old_end_ts = plan.data.end_ts;
            if old_end_ts != 0 && (data.end_ts == 0 || data.end_ts > old_end_ts) {
                return Err(SubscriptionsError::PlanEndTsCannotExtend.into());
            }

            // Only a new or shortened end is range-checked (future + one period out); an unchanged
            // end stays editable through its final instant, since PlanExpired's strict `>` already
            // rejected a past end.
            if data.end_ts != old_end_ts {
                validate_plan_end_ts(data.end_ts, plan.data.terms.period_hours, current_ts)?;
            }

            plan.status = data.status;
            plan.data.end_ts = data.end_ts;
            plan.data.pullers = data.pullers;
            plan.data.metadata_uri = data.metadata_uri;

            plan.owner
        }
    };

    let event = PlanUpdatedEvent::new(*accounts.plan_pda.address(), owner, data.status, data.end_ts, data.pullers);
    let event_data = event.to_bytes();
    event_engine::emit_event(&crate::ID, accounts.event_authority, accounts.self_program, &event_data)?;

    Ok(())
}
