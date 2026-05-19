use crate::{
    constants::TIME_DRIFT_ALLOWED_SECS, create_delegation_account, state::FixedDelegation, AccountDiscriminator,
    CreateDelegationAccounts, SubscriptionsError, DISCRIMINATOR_OFFSET,
};
use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::Sysvar;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

/// Instruction data payload for creating a fixed delegation.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct CreateFixedDelegationData {
    /// Client-chosen nonce that disambiguates multiple delegations between the
    /// same delegator/delegatee pair.
    pub nonce: u64,
    /// Total token amount the delegatee is authorized to transfer.
    pub amount: u64,
    /// Unix timestamp after which the delegation expires. Must be in the future
    /// (with [`TIME_DRIFT_ALLOWED_SECS`] tolerance).
    pub expiry_ts: i64,
}

impl CreateFixedDelegationData {
    /// Validates the instruction data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.expiry_ts != 0 && self.expiry_ts < current_time.saturating_sub(TIME_DRIFT_ALLOWED_SECS) {
            return Err(SubscriptionsError::FixedDelegationExpiryInPast);
        }

        if self.amount == 0 {
            return Err(SubscriptionsError::FixedDelegationAmountZero);
        }

        Ok(())
    }
}

impl CreateFixedDelegationData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<CreateFixedDelegationData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Instruction discriminator byte for `CreateFixedDelegation`.
pub const DISCRIMINATOR: &u8 = &1;

/// Creates a new [`FixedDelegation`] PDA.
///
/// Validates the instruction data, creates the delegation account via CPI,
/// and initializes its header and delegation-specific fields.
pub fn process(accounts: &mut [AccountView], call_data: &CreateFixedDelegationData) -> ProgramResult {
    call_data.validate(Clock::get()?.unix_timestamp)?;

    let accounts = CreateDelegationAccounts::try_from(accounts)?;

    let (bump, init_id, mint) = create_delegation_account(&accounts, call_data.nonce, FixedDelegation::LEN)?;

    let binding = &mut accounts.delegation_account.try_borrow_mut()?;
    // Set discriminator before load_mut so validation passes on freshly created account
    binding[DISCRIMINATOR_OFFSET] = AccountDiscriminator::FixedDelegation as u8;
    let delegation = FixedDelegation::load_mut(binding)?;

    delegation.header.init(
        AccountDiscriminator::FixedDelegation,
        bump,
        accounts.delegator.address(),
        accounts.delegatee.address(),
        accounts.payer.address(),
        init_id,
    );
    delegation.subscription_authority = *accounts.subscription_authority.address();
    delegation.mint = mint;
    delegation.amount = call_data.amount;
    delegation.expiry_ts = call_data.expiry_ts;

    Ok(())
}
