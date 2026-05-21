use core::mem::size_of;

use alloc::vec::Vec;
use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a subscriber resumes a previously cancelled subscription.
#[repr(C, packed)]
pub struct SubscriptionResumedEvent {
    /// The plan PDA the subscription belongs to.
    pub plan: Address,
    /// The subscriber's wallet address.
    pub subscriber: Address,
    /// Unix timestamp when the subscription was resumed.
    pub resumed_ts: i64,
}

impl SubscriptionResumedEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    pub fn new(plan: Address, subscriber: Address, resumed_ts: i64) -> Self {
        Self { plan, subscriber, resumed_ts }
    }
}

impl EventDiscriminator for SubscriptionResumedEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::SubscriptionResumed as u8;
}

impl EventSerialize for SubscriptionResumedEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.plan.as_ref());
        writer.extend_from_slice(self.subscriber.as_ref());
        writer.extend_from_slice(&{ self.resumed_ts }.to_le_bytes());
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
        let event = SubscriptionResumedEvent::new(plan(), subscriber(), 1_700_000_000);
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::SubscriptionResumed(e) => {
                assert_eq!(e.plan, plan());
                assert_eq!(e.subscriber, subscriber());
                assert_eq!({ e.resumed_ts }, 1_700_000_000);
            }
            _ => panic!("expected Resumed event"),
        }
    }

    #[test]
    fn wire_format() {
        let event = SubscriptionResumedEvent::new(plan(), subscriber(), 99);
        let bytes = event.to_bytes();

        assert_eq!(&bytes[..8], &EVENT_IX_TAG_LE);
        assert_eq!(bytes[8], SubscriptionResumedEvent::DISCRIMINATOR);
        assert_eq!(&bytes[9..41], plan().as_ref());
        assert_eq!(&bytes[41..73], subscriber().as_ref());
        assert_eq!(&bytes[73..81], &99i64.to_le_bytes());
    }
}
