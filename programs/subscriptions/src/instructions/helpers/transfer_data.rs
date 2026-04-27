use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{error::ProgramError, Address};

use crate::SubscriptionsError;

/// Instruction data payload shared by all transfer instructions (fixed, recurring, subscription).
#[repr(C, packed)]
#[derive(CodamaType, Debug, Clone)]
pub struct TransferData {
    /// Token amount to transfer.
    pub amount: u64,
    /// The delegator (token owner) whose ATA to debit.
    pub delegator: Address,
    /// The token mint (used to locate the correct SubscriptionAuthority PDA and ATA).
    pub mint: Address,
}

impl TransferData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<TransferData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}
