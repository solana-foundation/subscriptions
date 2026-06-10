use crate::{
    create_delegation_account, AccountDiscriminator, CreateDelegationAccounts, RecurringDelegation, SubscriptionsError,
    DISCRIMINATOR_OFFSET,
};
use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::Sysvar;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::constants::TIME_DRIFT_ALLOWED_SECS;

/// Maximum allowed period length for recurring delegations (365 days in seconds).
pub const MAX_DELEGATION_PERIOD_SECS: u64 = 31_536_000;

/// Instruction data payload for creating a recurring delegation.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct CreateRecurringDelegationData {
    /// Client-chosen nonce that disambiguates multiple delegations between the
    /// same delegator/delegatee pair.
    pub nonce: u64,
    /// Maximum token amount the delegatee may transfer per period.
    pub amount_per_period: u64,
    /// Length of each period in seconds (must be > 0 and <= [`MAX_DELEGATION_PERIOD_SECS`]).
    pub period_length_s: u64,
    /// Unix timestamp when the first period begins, or 0 to start when the
    /// transaction lands (requires a non-zero `expiry_ts`).
    pub start_ts: i64,
    /// Unix timestamp after which the delegation expires (0 = never).
    pub expiry_ts: i64,
    /// SubscriptionAuthority generation the delegator approved.
    pub expected_subscription_authority_init_id: i64,
}

impl CreateRecurringDelegationData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<CreateRecurringDelegationData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }

    /// Validates the instruction data against the current clock time.
    ///
    /// A `start_ts` of 0 means the delegation starts at `current_time`; that
    /// form requires a non-zero `expiry_ts` so a held transaction (e.g. signed
    /// with a durable nonce) cannot activate the delegation unboundedly late.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.start_ts == 0 {
            if self.expiry_ts == 0 {
                return Err(SubscriptionsError::RecurringDelegationStartOnLandingRequiresExpiry);
            }
            if current_time >= self.expiry_ts {
                return Err(SubscriptionsError::RecurringDelegationStartTimeGreaterThanExpiry);
            }
        } else {
            if self.start_ts < current_time.saturating_sub(TIME_DRIFT_ALLOWED_SECS) {
                return Err(SubscriptionsError::RecurringDelegationStartTimeInPast);
            }
            if self.expiry_ts != 0 && self.start_ts >= self.expiry_ts {
                return Err(SubscriptionsError::RecurringDelegationStartTimeGreaterThanExpiry);
            }
        }

        if self.period_length_s == 0 || self.period_length_s > MAX_DELEGATION_PERIOD_SECS {
            return Err(SubscriptionsError::InvalidPeriodLength);
        }

        if self.amount_per_period == 0 {
            return Err(SubscriptionsError::RecurringDelegationAmountZero);
        }

        Ok(())
    }
}

/// Instruction discriminator byte for `CreateRecurringDelegation`.
pub const DISCRIMINATOR: &u8 = &2;

/// Creates a new [`RecurringDelegation`] PDA.
///
/// Validates the instruction data, creates the delegation account via CPI,
/// and initializes its header and period-tracking fields.
pub fn process(accounts: &mut [AccountView], call_data: &CreateRecurringDelegationData) -> ProgramResult {
    let current_time = Clock::get()?.unix_timestamp;
    call_data.validate(current_time)?;

    let accounts = CreateDelegationAccounts::try_from(accounts)?;

    let (bump, init_id, mint) = create_delegation_account(
        &accounts,
        call_data.nonce,
        RecurringDelegation::LEN,
        call_data.expected_subscription_authority_init_id,
    )?;

    let binding = &mut accounts.delegation_account.try_borrow_mut()?;
    // Set discriminator before load_mut so validation passes on freshly created account
    binding[DISCRIMINATOR_OFFSET] = AccountDiscriminator::RecurringDelegation as u8;
    let delegation = RecurringDelegation::load_mut(binding)?;

    delegation.header.init(
        AccountDiscriminator::RecurringDelegation,
        bump,
        accounts.delegator.address(),
        accounts.delegatee.address(),
        accounts.payer.address(),
        init_id,
    );
    delegation.subscription_authority = *accounts.subscription_authority.address();
    delegation.mint = mint;
    delegation.current_period_start_ts = if call_data.start_ts == 0 { current_time } else { call_data.start_ts };
    delegation.period_length_s = call_data.period_length_s;
    delegation.expiry_ts = call_data.expiry_ts;
    delegation.amount_per_period = call_data.amount_per_period;
    delegation.amount_pulled_in_period = 0;

    Ok(())
}
