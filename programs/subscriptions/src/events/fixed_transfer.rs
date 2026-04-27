use core::mem::size_of;

use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a transfer is executed against a fixed delegation.
#[repr(C, packed)]
pub struct FixedTransferEvent {
    /// The fixed delegation PDA.
    pub delegation: Address,
    /// The token owner whose ATA was debited.
    pub delegator: Address,
    /// The party that initiated the transfer.
    pub delegatee: Address,
    /// The SPL token mint.
    pub mint: Address,
    /// Token amount transferred.
    pub amount: u64,
    /// Remaining allowance after this transfer.
    pub remaining_amount: u64,
    /// The receiver wallet that received the tokens.
    pub receiver: Address,
}

impl FixedTransferEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        delegation: Address,
        delegator: Address,
        delegatee: Address,
        mint: Address,
        amount: u64,
        remaining_amount: u64,
        receiver: Address,
    ) -> Self {
        Self {
            delegation,
            delegator,
            delegatee,
            mint,
            amount,
            remaining_amount,
            receiver,
        }
    }
}

impl EventDiscriminator for FixedTransferEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::FixedTransfer as u8;
}

impl EventSerialize for FixedTransferEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.delegation.as_ref());
        writer.extend_from_slice(self.delegator.as_ref());
        writer.extend_from_slice(self.delegatee.as_ref());
        writer.extend_from_slice(self.mint.as_ref());
        writer.extend_from_slice(&{ self.amount }.to_le_bytes());
        writer.extend_from_slice(&{ self.remaining_amount }.to_le_bytes());
        writer.extend_from_slice(self.receiver.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Event;
    use crate::tests::events::decode_event;

    fn delegation() -> Address {
        Address::new_from_array([1u8; 32])
    }

    fn delegator() -> Address {
        Address::new_from_array([2u8; 32])
    }

    fn delegatee() -> Address {
        Address::new_from_array([3u8; 32])
    }

    fn mint() -> Address {
        Address::new_from_array([4u8; 32])
    }

    fn receiver() -> Address {
        Address::new_from_array([5u8; 32])
    }

    fn amount() -> u64 {
        1_000_000
    }

    fn remaining_amount() -> u64 {
        500_000
    }

    #[test]
    fn roundtrip() {
        let event = FixedTransferEvent::new(
            delegation(),
            delegator(),
            delegatee(),
            mint(),
            amount(),
            remaining_amount(),
            receiver(),
        );
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::FixedTransfer(e) => {
                assert_eq!(e.delegation, delegation());
                assert_eq!(e.delegator, delegator());
                assert_eq!(e.delegatee, delegatee());
                assert_eq!(e.mint, mint());
                assert_eq!({ e.amount }, amount());
                assert_eq!({ e.remaining_amount }, remaining_amount());
                assert_eq!(e.receiver, receiver());
            }
            _ => panic!("expected FixedTransfer event"),
        }
    }
}
