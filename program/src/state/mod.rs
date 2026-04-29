//! On-chain account state types for the subscriptions program.
//!
//! Each account type is stored as a packed C struct in a Program Derived Account
//! (PDA). Accounts share a one-byte discriminator at offset 0 so that the program
//! can distinguish account types during deserialization.

pub mod common;
pub mod fixed_delegation;
pub mod header;
pub mod plan;
pub mod recurring_delegation;
pub mod subscription_authority;
pub mod subscription_delegation;
pub mod versioning;

pub use common::{
    find_plan_pda, find_subscription_pda, validate_plan_end_ts, verify_delegation_pda, verify_plan_pda,
    AccountDiscriminator, PlanStatus, DELEGATE_BASE_SEED,
};
pub use fixed_delegation::FixedDelegation;
pub use header::{Header, DISCRIMINATOR_OFFSET, VERSION_OFFSET};
pub use header::{BUMP_OFFSET, DELEGATEE_OFFSET, DELEGATOR_OFFSET, PAYER_OFFSET};
pub use plan::Plan;
pub use recurring_delegation::RecurringDelegation;
pub use subscription_authority::SubscriptionAuthority;
pub use subscription_delegation::SubscriptionDelegation;
pub use versioning::{check_and_update_version, check_min_account_size, CURRENT_VERSION};
