use core::mem::size_of;

use alloc::vec::Vec;
use codama::CodamaEvent;
use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a plan owner updates a plan's mutable fields.
#[repr(C, packed)]
#[derive(CodamaEvent)]
// EVENT_IX_TAG_LE @0, EventDiscriminators::PlanUpdated @8
#[codama(discriminator(bytes = [228, 69, 165, 46, 81, 203, 154, 29], offset = 0))]
#[codama(discriminator(bytes = [6], offset = 8))]
pub struct PlanUpdatedEvent {
    /// The plan PDA that was updated.
    pub plan: Address,
    /// The plan owner.
    pub owner: Address,
    /// The plan's new status (see [`PlanStatus`](crate::state::common::PlanStatus)).
    pub status: u8,
    /// The plan's new end timestamp. `0` means no end.
    pub end_ts: i64,
    /// The plan's updated puller whitelist. All-zero entries are unused.
    pub pullers: [Address; 4],
}

impl PlanUpdatedEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    pub fn new(plan: Address, owner: Address, status: u8, end_ts: i64, pullers: [Address; 4]) -> Self {
        Self { plan, owner, status, end_ts, pullers }
    }
}

impl EventDiscriminator for PlanUpdatedEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::PlanUpdated as u8;
}

impl EventSerialize for PlanUpdatedEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.plan.as_ref());
        writer.extend_from_slice(self.owner.as_ref());
        writer.push(self.status);
        writer.extend_from_slice(&{ self.end_ts }.to_le_bytes());
        let pullers = self.pullers;
        for puller in pullers.iter() {
            writer.extend_from_slice(puller.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Event;
    use crate::tests::events::decode_event;

    fn plan() -> Address {
        Address::new_from_array([1u8; 32])
    }

    fn owner() -> Address {
        Address::new_from_array([2u8; 32])
    }

    fn pullers() -> [Address; 4] {
        [
            Address::new_from_array([3u8; 32]),
            Address::new_from_array([4u8; 32]),
            Address::new_from_array([0u8; 32]),
            Address::new_from_array([0u8; 32]),
        ]
    }

    #[test]
    fn roundtrip() {
        let event = PlanUpdatedEvent::new(plan(), owner(), 1, 1_700_000_000, pullers());
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::PlanUpdated(e) => {
                assert_eq!(e.plan, plan());
                assert_eq!(e.owner, owner());
                assert_eq!(e.status, 1);
                assert_eq!({ e.end_ts }, 1_700_000_000);
                assert_eq!(e.pullers, pullers());
            }
            _ => panic!("expected PlanUpdated event"),
        }
    }
}
