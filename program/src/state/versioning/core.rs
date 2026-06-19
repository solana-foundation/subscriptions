use pinocchio::error::ProgramError;

use crate::{
    state::common::AccountDiscriminator,
    state::header::{DISCRIMINATOR_OFFSET, VERSION_OFFSET},
    SubscriptionsError,
};

pub const CURRENT_VERSION: u8 = 1;

/// Checks account version and attempts lazy migration if needed.
///
/// Returns `Ok` if the account is at CURRENT_VERSION (fast path) or was
/// successfully migrated in-place. Returns an error otherwise:
/// - `DelegationVersionMismatch`: version > CURRENT (program downgrade)
/// - `MigrationRequired`: version < CURRENT and no lazy path exists
/// - `InvalidAccountData`: data too short for version byte
///
/// Must be called on raw bytes **before** typed struct loading, since a
/// migration may change the struct layout. The account kind is validated against
/// `expected` up front so no migration step mutates a wrong-kind account.
/// See `docs/003-versioning-migration-architecture.md` for full details.
pub fn check_and_update_version(data: &mut [u8], expected: AccountDiscriminator) -> Result<(), ProgramError> {
    if data.len() <= VERSION_OFFSET {
        return Err(SubscriptionsError::InvalidAccountData.into());
    }

    if data[DISCRIMINATOR_OFFSET] != expected as u8 {
        return Err(SubscriptionsError::InvalidAccountDiscriminator.into());
    }

    let version = data[VERSION_OFFSET];

    if version == CURRENT_VERSION {
        return Ok(());
    }

    if version > CURRENT_VERSION {
        return Err(SubscriptionsError::DelegationVersionMismatch.into());
    }

    try_lazy_update(data, version)
}

/// Attempts to walk the account from its current version to CURRENT_VERSION
/// via successive lazy (in-place) migrations.
///
/// Each step calls `vN_to_vN1::lazy_update`, which either transforms the
/// bytes in-place (Ok) or signals that an explicit migration instruction is
/// needed (Err(MigrationRequired)).
///
/// When adding version 2, uncomment the first match arm:
/// ```ignore
/// 1 => { v1_to_v2::lazy_update(data)?; v = 2; }
/// ```
#[allow(clippy::while_immutable_condition, clippy::match_single_binding, clippy::never_loop, unused_mut)]
fn try_lazy_update(data: &mut [u8], from_version: u8) -> Result<(), ProgramError> {
    let mut v = from_version;
    while v < CURRENT_VERSION {
        match v {
            // 1 => { super::v1_to_v2::lazy_update(data)?; v = 2; }
            _ => return Err(SubscriptionsError::MigrationRequired.into()),
        }
    }
    data[VERSION_OFFSET] = CURRENT_VERSION;
    Ok(())
}

/// Safe version-aware size check for account loading.
///
/// Uses minimum-size (`<`) instead of exact-match (`!=`) because:
/// - After a program upgrade, Self::LEN may grow with new fields
/// - Old on-chain accounts retain their original (smaller) size until migrated
/// - transmute reads exactly Self::LEN bytes, safely ignoring any trailing bytes
/// - Combined with check_and_update_version (called before load), ensures
///   accounts are migrated to current schema before typed access
pub fn check_min_account_size(data_len: usize, expected_len: usize) -> Result<(), ProgramError> {
    if data_len < expected_len {
        return Err(SubscriptionsError::InvalidAccountData.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::vec::Vec;

    use pinocchio::error::ProgramError;

    use super::*;

    fn assert_custom_error(err: ProgramError, expected: SubscriptionsError) {
        match err {
            ProgramError::Custom(code) => assert_eq!(code, expected as u32),
            other => panic!("expected Custom error, got {:?}", other),
        }
    }

    fn make_data(version: u8) -> Vec<u8> {
        let mut data = vec![0u8; VERSION_OFFSET + 8];
        data[DISCRIMINATOR_OFFSET] = AccountDiscriminator::FixedDelegation as u8;
        data[VERSION_OFFSET] = version;
        data
    }

    #[test]
    fn test_version_current_ok() {
        let mut data = make_data(CURRENT_VERSION);
        let original = data.clone();
        assert!(check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).is_ok());
        assert_eq!(data, original);
    }

    #[test]
    fn test_version_future_rejects() {
        let mut data = make_data(CURRENT_VERSION + 1);
        let err = check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::DelegationVersionMismatch);
    }

    #[test]
    fn test_version_zero_needs_migration() {
        let mut data = make_data(0);
        let err = check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::MigrationRequired);
    }

    #[test]
    fn test_version_data_too_short() {
        let mut data = vec![0u8; VERSION_OFFSET];
        let err = check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::InvalidAccountData);
    }

    #[test]
    fn test_version_u8_max_rejects() {
        let mut data = make_data(u8::MAX);
        let err = check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::DelegationVersionMismatch);
    }

    #[test]
    fn test_version_minimum_valid_data_length() {
        let mut data = vec![0u8; VERSION_OFFSET + 1];
        data[DISCRIMINATOR_OFFSET] = AccountDiscriminator::FixedDelegation as u8;
        data[VERSION_OFFSET] = CURRENT_VERSION;
        assert!(check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).is_ok());
    }

    #[test]
    fn test_version_wrong_discriminator_rejects() {
        let mut data = make_data(CURRENT_VERSION);
        let err = check_and_update_version(&mut data, AccountDiscriminator::RecurringDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::InvalidAccountDiscriminator);
    }

    #[test]
    fn test_version_empty_data() {
        let mut data: Vec<u8> = vec![];
        let err = check_and_update_version(&mut data, AccountDiscriminator::FixedDelegation).unwrap_err();
        assert_custom_error(err, SubscriptionsError::InvalidAccountData);
    }

    #[test]
    fn test_min_size_both_zero_ok() {
        assert!(check_min_account_size(0, 0).is_ok());
    }

    #[test]
    fn test_min_size_exact_ok() {
        assert!(check_min_account_size(100, 100).is_ok());
    }

    #[test]
    fn test_min_size_larger_ok() {
        assert!(check_min_account_size(120, 100).is_ok());
    }

    #[test]
    fn test_min_size_smaller_err() {
        let err = check_min_account_size(80, 100).unwrap_err();
        assert_custom_error(err, SubscriptionsError::InvalidAccountData);
    }

    #[test]
    fn test_min_size_zero_len_err() {
        let err = check_min_account_size(0, 100).unwrap_err();
        assert_custom_error(err, SubscriptionsError::InvalidAccountData);
    }
}
