use core::mem::size_of;

use alloc::vec::Vec;
use codama::CodamaEvent;
use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a single-use up-to delegation is drawn (and thereby consumed).
#[repr(C, packed)]
#[derive(CodamaEvent)]
// EVENT_IX_TAG_LE @0, EventDiscriminators::UpToTransfer @8
#[codama(discriminator(bytes = [228, 69, 165, 46, 81, 203, 154, 29], offset = 0))]
#[codama(discriminator(bytes = [7], offset = 8))]
pub struct UpToTransferEvent {
    /// The up-to delegation PDA (consumed by this draw).
    pub delegation: Address,
    /// The token owner whose ATA was debited.
    pub delegator: Address,
    /// The party that initiated the transfer.
    pub delegatee: Address,
    /// The SPL token mint.
    pub mint: Address,
    /// Gross token amount debited from the delegator (`0` when the draw settles nothing).
    /// For transfer-fee mints derive the net received from balances off-chain.
    pub amount: u64,
    /// The bound recipient wallet; equals the owner of `receiver_token_account`.
    pub recipient: Address,
    /// The token account credited by the transfer; its owner is `recipient`.
    pub receiver_token_account: Address,
}

impl UpToTransferEvent {
    /// Wire-format payload size (excluding tag and discriminator).
    pub const DATA_LEN: usize = size_of::<Self>();

    /// Constructs a new event.
    pub fn new(
        delegation: Address,
        delegator: Address,
        delegatee: Address,
        mint: Address,
        amount: u64,
        recipient: Address,
        receiver_token_account: Address,
    ) -> Self {
        Self { delegation, delegator, delegatee, mint, amount, recipient, receiver_token_account }
    }
}

impl EventDiscriminator for UpToTransferEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::UpToTransfer as u8;
}

impl EventSerialize for UpToTransferEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.delegation.as_ref());
        writer.extend_from_slice(self.delegator.as_ref());
        writer.extend_from_slice(self.delegatee.as_ref());
        writer.extend_from_slice(self.mint.as_ref());
        writer.extend_from_slice(&{ self.amount }.to_le_bytes());
        writer.extend_from_slice(self.recipient.as_ref());
        writer.extend_from_slice(self.receiver_token_account.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Event;
    use crate::tests::events::decode_event;

    fn addr(b: u8) -> Address {
        Address::new_from_array([b; 32])
    }

    #[test]
    fn roundtrip() {
        let event = UpToTransferEvent::new(addr(1), addr(2), addr(3), addr(4), 1_000_000, addr(5), addr(6));
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::UpToTransfer(e) => {
                assert_eq!(e.delegation, addr(1));
                assert_eq!(e.delegator, addr(2));
                assert_eq!(e.delegatee, addr(3));
                assert_eq!(e.mint, addr(4));
                assert_eq!({ e.amount }, 1_000_000);
                assert_eq!(e.recipient, addr(5));
                assert_eq!(e.receiver_token_account, addr(6));
            }
            _ => panic!("expected UpToTransfer event"),
        }
    }

    #[test]
    fn zero_amount_roundtrip() {
        let event = UpToTransferEvent::new(addr(1), addr(2), addr(3), addr(4), 0, addr(5), addr(6));
        let bytes = event.to_bytes();
        match decode_event(&bytes).unwrap() {
            Event::UpToTransfer(e) => assert_eq!({ e.amount }, 0),
            _ => panic!("expected UpToTransfer event"),
        }
    }
}
