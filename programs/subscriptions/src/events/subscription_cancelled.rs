use core::mem::size_of;

use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a subscriber cancels their subscription.
#[repr(C, packed)]
pub struct SubscriptionCancelledEvent {
    /// The plan PDA the subscription belongs to.
    pub plan: Address,
    /// The subscriber's wallet address.
    pub subscriber: Address,
    /// Unix timestamp when the subscription will expire (end of current billing period).
    pub expires_at_ts: i64,
}

impl SubscriptionCancelledEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    pub fn new(plan: Address, subscriber: Address, expires_at_ts: i64) -> Self {
        Self {
            plan,
            subscriber,
            expires_at_ts,
        }
    }
}

impl EventDiscriminator for SubscriptionCancelledEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::SubscriptionCancelled as u8;
}

impl EventSerialize for SubscriptionCancelledEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.plan.as_ref());
        writer.extend_from_slice(self.subscriber.as_ref());
        writer.extend_from_slice(&{ self.expires_at_ts }.to_le_bytes());
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

    #[test]
    fn roundtrip() {
        let event = SubscriptionCancelledEvent::new(plan(), subscriber(), 1_700_000_000);
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::SubscriptionCancelled(e) => {
                assert_eq!(e.plan, plan());
                assert_eq!(e.subscriber, subscriber());
                assert_eq!({ e.expires_at_ts }, 1_700_000_000);
            }
            _ => panic!("expected Cancelled event"),
        }
    }

    #[test]
    fn wire_format() {
        let event = SubscriptionCancelledEvent::new(plan(), subscriber(), 99);
        let bytes = event.to_bytes();

        assert_eq!(&bytes[..8], &EVENT_IX_TAG_LE);
        assert_eq!(bytes[8], SubscriptionCancelledEvent::DISCRIMINATOR);
        assert_eq!(&bytes[9..41], plan().as_ref());
        assert_eq!(&bytes[41..73], subscriber().as_ref());
        assert_eq!(&bytes[73..81], &99i64.to_le_bytes());
    }

    #[test]
    fn negative_timestamp() {
        let event = SubscriptionCancelledEvent::new(plan(), subscriber(), -1);
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();
        match decoded {
            Event::SubscriptionCancelled(e) => assert_eq!({ e.expires_at_ts }, -1),
            _ => panic!("expected Cancelled"),
        }
    }
}
