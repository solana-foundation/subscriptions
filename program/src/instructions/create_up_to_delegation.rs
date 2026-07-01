use crate::{
    constants::TIME_DRIFT_ALLOWED_SECS, create_delegation_account, state::UpToDelegation, AccountDiscriminator,
    CreateDelegationAccounts, SubscriptionsError, DISCRIMINATOR_OFFSET,
};
use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::Sysvar;
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

/// Instruction data payload for creating an up-to (single-use, recipient-bound) delegation.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct CreateUpToDelegationData {
    /// Client-chosen nonce that disambiguates multiple delegations between the
    /// same delegator/delegatee pair.
    pub nonce: u64,
    /// Ceiling for the single draw. The spender may settle any amount up to this.
    pub max_amount: u64,
    /// The bound recipient wallet. The receiver token account's owner must equal this at draw time.
    pub recipient: Address,
    /// Unix timestamp after which the delegation expires. Must be in the future
    /// (with [`TIME_DRIFT_ALLOWED_SECS`] tolerance). `0` means no expiry.
    pub expiry_ts: i64,
    /// SubscriptionAuthority generation the delegator approved.
    pub expected_subscription_authority_init_id: i64,
}

impl CreateUpToDelegationData {
    /// Validates the instruction data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.expiry_ts != 0 && self.expiry_ts < current_time.saturating_sub(TIME_DRIFT_ALLOWED_SECS) {
            return Err(SubscriptionsError::UpToDelegationExpiryInPast);
        }

        if self.max_amount == 0 {
            return Err(SubscriptionsError::UpToDelegationAmountZero);
        }

        if self.recipient == Address::default() {
            return Err(SubscriptionsError::InvalidAddress);
        }

        Ok(())
    }

    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<CreateUpToDelegationData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Instruction discriminator byte for `CreateUpToDelegation`.
pub const DISCRIMINATOR: &u8 = &17;

/// Creates a new [`UpToDelegation`] PDA.
///
/// Validates the instruction data, creates the delegation account via CPI,
/// and initializes its header and delegation-specific fields.
pub fn process(accounts: &mut [AccountView], call_data: &CreateUpToDelegationData) -> ProgramResult {
    call_data.validate(Clock::get()?.unix_timestamp)?;

    let accounts = CreateDelegationAccounts::try_from(accounts)?;

    let (bump, init_id, mint) = create_delegation_account(
        &accounts,
        call_data.nonce,
        UpToDelegation::LEN,
        call_data.expected_subscription_authority_init_id,
    )?;

    let binding = &mut accounts.delegation_account.try_borrow_mut()?;
    binding[DISCRIMINATOR_OFFSET] = AccountDiscriminator::UpToDelegation as u8;
    let delegation = UpToDelegation::load_mut(binding)?;

    delegation.header.init(
        AccountDiscriminator::UpToDelegation,
        bump,
        accounts.delegator.address(),
        accounts.delegatee.address(),
        accounts.payer.address(),
        init_id,
    );
    delegation.subscription_authority = *accounts.subscription_authority.address();
    delegation.mint = mint;
    delegation.recipient = call_data.recipient;
    delegation.max_amount = call_data.max_amount;
    delegation.expiry_ts = call_data.expiry_ts;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(max_amount: u64, recipient: Address, expiry_ts: i64) -> CreateUpToDelegationData {
        CreateUpToDelegationData {
            nonce: 0,
            max_amount,
            recipient,
            expiry_ts,
            expected_subscription_authority_init_id: 0,
        }
    }

    fn recipient() -> Address {
        Address::new_from_array([7u8; 32])
    }

    #[test]
    fn valid_passes() {
        assert!(data(100, recipient(), 0).validate(1_000).is_ok());
        assert!(data(100, recipient(), 2_000).validate(1_000).is_ok());
    }

    #[test]
    fn zero_max_amount_rejected() {
        assert!(matches!(data(0, recipient(), 0).validate(1_000), Err(SubscriptionsError::UpToDelegationAmountZero)));
    }

    #[test]
    fn zero_recipient_rejected() {
        assert!(matches!(data(100, Address::default(), 0).validate(1_000), Err(SubscriptionsError::InvalidAddress)));
    }

    #[test]
    fn expiry_in_past_rejected() {
        assert!(matches!(
            data(100, recipient(), 500).validate(1_000),
            Err(SubscriptionsError::UpToDelegationExpiryInPast)
        ));
    }

    #[test]
    fn expiry_within_drift_tolerance_passes() {
        assert!(data(100, recipient(), 1_000 - TIME_DRIFT_ALLOWED_SECS).validate(1_000).is_ok());
    }
}
