use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    create_plan_account,
    state::{
        common::{validate_plan_end_ts, AccountDiscriminator, PlanStatus},
        plan::{self, Plan},
    },
    CreatePlanAccounts, SubscriptionsError,
};

/// Maximum allowed period length for plans (365 days in hours).
pub const MAX_PLAN_PERIOD_HOURS: u64 = 8760;

/// Maximum number of destination wallets a plan can whitelist.
pub const MAX_DESTINATIONS: usize = 4;

/// Maximum number of puller addresses a plan can authorize.
pub const MAX_PULLERS: usize = 4;

/// Immutable billing terms snapshotted into each [`SubscriptionDelegation`] at subscribe time.
#[repr(C, packed)]
#[derive(Debug, Clone, Copy, CodamaType)]
pub struct PlanTerms {
    /// Maximum token amount that can be pulled per billing period.
    pub amount: u64,
    /// Billing period length in hours (must be > 0 and <= [`MAX_PLAN_PERIOD_HOURS`]).
    pub period_hours: u64,
    /// Unix timestamp when the plan was created on-chain. Set by the program at plan creation time.
    pub created_at: i64,
}

impl PlanTerms {
    /// Returns the period length in seconds.
    ///
    /// Overflow is impossible because `period_hours` is bounded by [`MAX_PLAN_PERIOD_HOURS`]
    /// (validated at plan creation in [`PlanData::validate`]); the maximum result is well below `u64::MAX`.
    pub fn period_length_secs(&self) -> u64 {
        self.period_hours * crate::constants::SECS_PER_HOUR
    }
}

/// Configuration data embedded in a [`Plan`] account and supplied when creating one.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct PlanData {
    /// Merchant-chosen identifier for the plan (unique per owner).
    pub plan_id: u64,
    /// SPL token mint that subscriptions under this plan operate on.
    pub mint: Address,
    /// Immutable plan terms
    pub terms: PlanTerms,
    /// Optional unix timestamp after which the plan expires. `0` means no end.
    pub end_ts: i64,
    /// Whitelisted destination wallets for transfers. All-zero entries are ignored.
    pub destinations: [Address; 4],
    /// Addresses authorized to pull subscription transfers (in addition to the owner).
    pub pullers: [Address; 4],
    /// UTF-8 metadata URI (e.g., pointing to off-chain plan details). Padded with zeros.
    #[codama(type = fixed_size(string(utf8), 128))]
    pub metadata_uri: [u8; 128],
}

pub const PLAN_DATA_LEN_V1: usize = 456;
const _: () = assert!(PlanData::LEN == PLAN_DATA_LEN_V1);

impl PlanData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<PlanData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }

    /// Validates plan data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.terms.amount == 0 {
            return Err(SubscriptionsError::InvalidAmount);
        }
        if self.terms.period_hours == 0 || self.terms.period_hours > MAX_PLAN_PERIOD_HOURS {
            return Err(SubscriptionsError::InvalidPeriodLength);
        }

        // Destinations are not validated here; empty destinations means any destination is valid at transfer time.
        // Pullers are not validated here; empty pullers defaults to owner-only authorization in transfer.
        validate_plan_end_ts(self.end_ts, self.terms.period_hours, current_time)?;

        Ok(())
    }
}

/// Instruction discriminator byte for `CreatePlan`.
pub const DISCRIMINATOR: &u8 = &7;

/// Creates a new subscription [`Plan`] PDA.
///
/// Validates the plan data, creates the plan account via CPI, and initializes
/// its fields including owner, status, and the embedded [`PlanData`].
pub fn process(accounts: &[AccountView], data: &PlanData) -> ProgramResult {
    let current_ts = Clock::get()?.unix_timestamp;
    data.validate(current_ts)?;

    let accounts = CreatePlanAccounts::try_from(accounts)?;

    if accounts.token_mint.address() != &data.mint {
        return Err(SubscriptionsError::MintMismatch.into());
    }

    let bump = create_plan_account(&accounts, data.plan_id)?;

    let account_data = &mut accounts.plan_pda.try_borrow_mut()?;
    account_data[plan::PLAN_DISCRIMINATOR_OFFSET] = AccountDiscriminator::Plan as u8;
    let plan = Plan::load_mut(account_data)?;

    plan.owner = *accounts.merchant.address();
    plan.bump = bump;
    plan.status = PlanStatus::Active as u8;
    unsafe {
        core::ptr::copy_nonoverlapping(
            data as *const PlanData as *const u8,
            core::ptr::addr_of_mut!(plan.data) as *mut u8,
            PlanData::LEN,
        );
    }
    plan.data.terms.created_at = current_ts;

    Ok(())
}
