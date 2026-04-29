use core::mem::size_of;

use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a user subscribes to a plan.
#[repr(C, packed)]
pub struct SubscriptionCreatedEvent {
    /// The plan PDA the subscription was created against.
    pub plan: Address,
    /// The subscriber's wallet address.
    pub subscriber: Address,
    /// The SPL token mint for this subscription.
    pub mint: Address,
    /// Unix timestamp when the subscription was created.
    pub created_ts: i64,
}

impl SubscriptionCreatedEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    pub fn new(plan: Address, subscriber: Address, mint: Address, created_ts: i64) -> Self {
        Self {
            plan,
            subscriber,
            mint,
            created_ts,
        }
    }
}

impl EventDiscriminator for SubscriptionCreatedEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::SubscriptionCreated as u8;
}

impl EventSerialize for SubscriptionCreatedEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.plan.as_ref());
        writer.extend_from_slice(self.subscriber.as_ref());
        writer.extend_from_slice(self.mint.as_ref());
        writer.extend_from_slice(&{ self.created_ts }.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_engine::EVENT_IX_TAG_LE;
    use crate::events::Event;
    use crate::tests::events::decode_event;

    fn plan() -> Address {
        Address::new_from_array([1u8; 32])
    }

    fn subscriber() -> Address {
        Address::new_from_array([2u8; 32])
    }

    fn mint() -> Address {
        Address::new_from_array([3u8; 32])
    }

    #[test]
    fn roundtrip() {
        let event = SubscriptionCreatedEvent::new(plan(), subscriber(), mint(), 1_700_000_000);
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::SubscriptionCreated(e) => {
                assert_eq!(e.plan, plan());
                assert_eq!(e.subscriber, subscriber());
                assert_eq!(e.mint, mint());
                assert_eq!({ e.created_ts }, 1_700_000_000);
            }
            _ => panic!("expected Created event"),
        }
    }

    #[test]
    fn wire_format() {
        let event = SubscriptionCreatedEvent::new(plan(), subscriber(), mint(), 42);
        let bytes = event.to_bytes();

        assert_eq!(&bytes[..8], &EVENT_IX_TAG_LE);
        assert_eq!(bytes[8], SubscriptionCreatedEvent::DISCRIMINATOR);
        assert_eq!(&bytes[9..41], plan().as_ref());
        assert_eq!(&bytes[41..73], subscriber().as_ref());
        assert_eq!(&bytes[73..105], mint().as_ref());
        assert_eq!(&bytes[105..113], &42i64.to_le_bytes());
    }

    #[test]
    fn zero_timestamp() {
        let event = SubscriptionCreatedEvent::new(plan(), subscriber(), mint(), 0);
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();
        match decoded {
            Event::SubscriptionCreated(e) => assert_eq!({ e.created_ts }, 0),
            _ => panic!("expected Created"),
        }
    }
}
