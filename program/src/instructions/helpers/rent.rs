//! Rent-exempt minimum balance for accounts created by the program.
//!
//! pinocchio's `Rent` does not read `exemption_threshold`, so its minimum balance
//! only matches the runtime on clusters where the threshold is 1.0.

use pinocchio::{
    error::ProgramError,
    sysvars::{get_sysvar, rent::RENT_ID},
};

use crate::SubscriptionsError;

const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

/// `lamports_per_byte_year: u64`, `exemption_threshold: f64`, `burn_percent: u8`.
pub(crate) const RENT_SYSVAR_LEN: usize = 17;

const MAX_PERMITTED_DATA_LENGTH: u64 = 10 * 1024 * 1024;

/// Minimum lamports for an account of `data_len` bytes to be rent exempt.
pub fn minimum_balance(data_len: usize) -> Result<u64, ProgramError> {
    let mut raw = [0u8; RENT_SYSVAR_LEN];
    get_sysvar(&mut raw, &RENT_ID, 0)?;
    minimum_balance_from_sysvar(&raw, data_len)
}

pub(crate) fn minimum_balance_from_sysvar(raw: &[u8; RENT_SYSVAR_LEN], data_len: usize) -> Result<u64, ProgramError> {
    if data_len as u64 > MAX_PERMITTED_DATA_LENGTH {
        return Err(ProgramError::InvalidArgument);
    }

    let mut lamports_per_byte = [0u8; 8];
    lamports_per_byte.copy_from_slice(&raw[0..8]);
    let mut threshold = [0u8; 8];
    threshold.copy_from_slice(&raw[8..16]);
    let lamports_per_byte = u64::from_le_bytes(lamports_per_byte);
    let threshold = f64::from_le_bytes(threshold);

    let base = (ACCOUNT_STORAGE_OVERHEAD + data_len as u64)
        .checked_mul(lamports_per_byte)
        .ok_or(SubscriptionsError::ArithmeticOverflow)?;

    if threshold == 1.0 {
        return Ok(base);
    }
    if !(threshold.is_finite() && threshold > 0.0) {
        return Err(ProgramError::InvalidArgument);
    }
    // Same expression and truncation as the runtime's `Rent::minimum_balance`.
    Ok((base as f64 * threshold) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sysvar(lamports_per_byte: u64, threshold: f64, burn_percent: u8) -> [u8; RENT_SYSVAR_LEN] {
        let mut raw = [0u8; RENT_SYSVAR_LEN];
        raw[0..8].copy_from_slice(&lamports_per_byte.to_le_bytes());
        raw[8..16].copy_from_slice(&threshold.to_le_bytes());
        raw[16] = burn_percent;
        raw
    }

    // Expected values are `getMinimumBalanceForRentExemption` results from each cluster.
    #[test]
    fn threshold_two() {
        let rent = sysvar(3480, 2.0, 100);
        assert_eq!(minimum_balance_from_sysvar(&rent, 0).unwrap(), 890_880);
        assert_eq!(minimum_balance_from_sysvar(&rent, 491).unwrap(), 4_308_240);
        assert_eq!(minimum_balance_from_sysvar(&rent, 127_640).unwrap(), 889_265_280);
    }

    #[test]
    fn threshold_one() {
        let rent = sysvar(5080, 1.0, 50);
        assert_eq!(minimum_balance_from_sysvar(&rent, 0).unwrap(), 650_240);
        assert_eq!(minimum_balance_from_sysvar(&rent, 491).unwrap(), 3_144_520);
        assert_eq!(minimum_balance_from_sysvar(&rent, 127_640).unwrap(), 649_061_440);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(minimum_balance_from_sysvar(&sysvar(3480, 2.0, 100), 10 * 1024 * 1024 + 1).is_err());
        assert!(minimum_balance_from_sysvar(&sysvar(3480, f64::NAN, 100), 1).is_err());
        assert!(minimum_balance_from_sysvar(&sysvar(3480, 0.0, 100), 1).is_err());
        assert!(minimum_balance_from_sysvar(&sysvar(u64::MAX, 1.0, 100), 1).is_err());
    }
}
