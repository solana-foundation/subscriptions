//! Event types emitted by the subscriptions program via self-CPI.
//!
//! Each event struct implements [`EventDiscriminator`](crate::event_engine::EventDiscriminator)
//! and [`EventSerialize`](crate::event_engine::EventSerialize). Events are
//! serialized with an 8-byte tag prefix followed by a 1-byte discriminator and
//! the event-specific payload.

pub mod fixed_transfer;
pub mod recurring_transfer;
pub mod subscription_cancelled;
pub mod subscription_created;
pub mod subscription_transfer;

pub use fixed_transfer::*;
pub use recurring_transfer::*;
pub use subscription_cancelled::*;
pub use subscription_created::*;
pub use subscription_transfer::*;

/// Typed reference to one of the program's events, used for decoding.
pub enum Event<'a> {
    /// See [`SubscriptionCreatedEvent`].
    SubscriptionCreated(&'a SubscriptionCreatedEvent),
    /// See [`SubscriptionCancelledEvent`].
    SubscriptionCancelled(&'a SubscriptionCancelledEvent),
    /// See [`SubscriptionTransferEvent`].
    SubscriptionTransfer(&'a SubscriptionTransferEvent),
    /// See [`FixedTransferEvent`].
    FixedTransfer(&'a FixedTransferEvent),
    /// See [`RecurringTransferEvent`].
    RecurringTransfer(&'a RecurringTransferEvent),
}
