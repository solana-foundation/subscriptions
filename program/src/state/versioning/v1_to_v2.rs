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

#[cfg(test)]
mod tests {
    use crate::{state::header::VERSION_OFFSET, SubscriptionsError};

    /// Simulates the full migration chain: v1 account is lazily migrated
    /// to v2 with version byte stamped at the end.
    /// When implementing the real v1->v2, adapt this test accordingly.
    #[test]
    fn simulated_lazy_migration_v1_to_v2() {
        const TARGET_VERSION: u8 = 2;
        let mut data = vec![0u8; VERSION_OFFSET + 16];
        data[VERSION_OFFSET] = 1;

        fn simulated_try_lazy_update(
            data: &mut [u8],
            from: u8,
            target: u8,
        ) -> Result<(), pinocchio::error::ProgramError> {
            let mut v = from;
            while v < target {
                match v {
                    1 => {
                        v = 2;
                    }
                    _ => return Err(SubscriptionsError::MigrationRequired.into()),
                }
            }
            data[VERSION_OFFSET] = target;
            Ok(())
        }

        assert_eq!(data[VERSION_OFFSET], 1);
        simulated_try_lazy_update(&mut data, 1, TARGET_VERSION).unwrap();
        assert_eq!(data[VERSION_OFFSET], TARGET_VERSION);
    }
}
