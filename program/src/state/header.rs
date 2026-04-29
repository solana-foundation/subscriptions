//! Shared header layout for delegation accounts.
//!
//! [`FixedDelegation`](super::fixed_delegation::FixedDelegation),
//! [`RecurringDelegation`](super::recurring_delegation::RecurringDelegation), and
//! [`SubscriptionDelegation`](super::subscription_delegation::SubscriptionDelegation)
//! all begin with a [`Header`] that contains common metadata.

use codama::CodamaType;
use pinocchio::Address;

use super::common::AccountDiscriminator;
use super::versioning::CURRENT_VERSION;

/// Byte offset of the discriminator within the header (and the account data).
pub const DISCRIMINATOR_OFFSET: usize = 0;

/// Byte offset of the version field.
pub const VERSION_OFFSET: usize = 1;

/// Byte offset of the PDA bump seed.
pub const BUMP_OFFSET: usize = 2;

/// Byte offset of the delegator pubkey.
pub const DELEGATOR_OFFSET: usize = 3;

/// Byte offset of the delegatee pubkey.
pub const DELEGATEE_OFFSET: usize = 35;

/// Byte offset of the payer pubkey (who funded the account creation).
pub const PAYER_OFFSET: usize = 67;

/// Byte offset of the init_id field.
pub const INIT_ID_OFFSET: usize = 99;

/// Common header shared by all delegation account types.
///
/// Occupies the first 107 bytes of every delegation PDA. The discriminator byte
/// at offset 0 identifies the concrete delegation type. The `init_id` field
/// is copied from the parent [`SubscriptionAuthority`](super::subscription_authority::SubscriptionAuthority)
/// at creation time and validated on every transfer to detect stale delegations.
#[repr(C, packed)]
#[derive(Debug, Clone, Copy, CodamaType)]
pub struct Header {
    /// Account type discriminator (see [`AccountDiscriminator`](super::common::AccountDiscriminator)).
    pub discriminator: u8,
    /// Schema version, currently always [`CURRENT_VERSION`].
    pub version: u8,
    /// PDA bump seed used to derive this account's address.
    pub bump: u8,
    /// The user who created the delegation (token owner).
    pub delegator: Address,
    /// The party authorized to execute transfers under this delegation.
    pub delegatee: Address,
    /// The account that funded the PDA creation (receives rent on close).
    pub payer: Address,
    /// Initialization identifier copied from the parent SubscriptionAuthority's `init_id`.
    pub init_id: i64,
}

impl Header {
    /// Total serialized size in bytes.
    pub const LEN: usize = core::mem::size_of::<Header>();

    pub fn init(
        &mut self,
        discriminator: AccountDiscriminator,
        bump: u8,
        delegator: &Address,
        delegatee: &Address,
        payer: &Address,
        init_id: i64,
    ) {
        self.version = CURRENT_VERSION;
        self.discriminator = discriminator.into();
        self.bump = bump;
        self.delegator = *delegator;
        self.delegatee = *delegatee;
        self.payer = *payer;
        self.init_id = init_id;
    }
}

pub const HEADER_LEN_V1: usize = 107;
const _: () = assert!(Header::LEN == HEADER_LEN_V1);
const _: () = assert!(INIT_ID_OFFSET == 99);
const _: () = assert!(DELEGATOR_OFFSET == 3);
const _: () = assert!(DELEGATEE_OFFSET == 35);
const _: () = assert!(PAYER_OFFSET == 67);
