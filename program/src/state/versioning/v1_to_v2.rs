use pinocchio::error::ProgramError;

use crate::SubscriptionsError;

/// Lazy in-place migration from v1 to v2.
///
/// Called by check_and_update_version when an account has version=1 and
/// CURRENT_VERSION=2. Transforms raw bytes in-place without realloc.
///
/// Pattern A: field value transform (e.g. scale amount by 10x)
///   data[OFFSET..OFFSET+8].copy_from_slice(&new_value.to_le_bytes());
///
/// Pattern B: new field in existing padding
///   data[NEW_FIELD_OFFSET..NEW_FIELD_OFFSET+N].copy_from_slice(&default);
///
/// Pattern C: needs realloc (larger account)
///   return Err(MigrationRequired) to force explicit migration instruction
#[allow(dead_code)]
pub fn lazy_update(_data: &mut [u8]) -> Result<(), ProgramError> {
    Err(SubscriptionsError::MigrationRequired.into())
}

/// Explicit migration from v1 to v2.
///
/// Called by a dedicated migrate instruction when lazy_update returns
/// MigrationRequired. Has access to additional accounts for realloc.
#[allow(dead_code)]
pub fn migrate(_data: &mut [u8]) -> Result<(), ProgramError> {
    Err(SubscriptionsError::MigrationRequired.into())
}
