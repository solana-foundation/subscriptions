use core::mem::size_of;

use pinocchio::Address;

use crate::event_engine::{EventDiscriminator, EventDiscriminators, EventSerialize};

/// Emitted when a transfer is executed against a recurring delegation.
#[repr(C, packed)]
pub struct RecurringTransferEvent {
    /// The recurring delegation PDA.
    pub delegation: Address,
    /// The token owner whose ATA was debited.
    pub delegator: Address,
    /// The party that initiated the transfer.
    pub delegatee: Address,
    /// The SPL token mint.
    pub mint: Address,
    /// Token amount transferred.
    pub amount: u64,
    /// Start of the period during which the transfer occurred.
    pub period_start_ts: i64,
    /// End of the period during which the transfer occurred.
    pub period_end_ts: i64,
    /// Cumulative amount pulled so far in this period (including this transfer).
    pub amount_pulled_in_period: u64,
    /// The receiver wallet that received the tokens.
    pub receiver: Address,
}

impl RecurringTransferEvent {
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
        period_start_ts: i64,
        period_end_ts: i64,
        amount_pulled_in_period: u64,
        receiver: Address,
    ) -> Self {
        Self {
            delegation,
            delegator,
            delegatee,
            mint,
            amount,
            period_start_ts,
            period_end_ts,
            amount_pulled_in_period,
            receiver,
        }
    }
}

impl EventDiscriminator for RecurringTransferEvent {
    const DISCRIMINATOR: u8 = EventDiscriminators::RecurringTransfer as u8;
}

impl EventSerialize for RecurringTransferEvent {
    const DATA_LEN: usize = Self::DATA_LEN;

    fn write_inner(&self, writer: &mut Vec<u8>) {
        writer.extend_from_slice(self.delegation.as_ref());
        writer.extend_from_slice(self.delegator.as_ref());
        writer.extend_from_slice(self.delegatee.as_ref());
        writer.extend_from_slice(self.mint.as_ref());
        writer.extend_from_slice(&{ self.amount }.to_le_bytes());
        writer.extend_from_slice(&{ self.period_start_ts }.to_le_bytes());
        writer.extend_from_slice(&{ self.period_end_ts }.to_le_bytes());
        writer.extend_from_slice(&{ self.amount_pulled_in_period }.to_le_bytes());
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

    fn period_start_ts() -> i64 {
        1_700_000_000
    }

    fn period_end_ts() -> i64 {
        1_700_003_600
    }

    fn amount_pulled_in_period() -> u64 {
        1_000_000
    }

    #[test]
    fn roundtrip() {
        let event = RecurringTransferEvent::new(
            delegation(),
            delegator(),
            delegatee(),
            mint(),
            amount(),
            period_start_ts(),
            period_end_ts(),
            amount_pulled_in_period(),
            receiver(),
        );
        let bytes = event.to_bytes();
        let decoded = decode_event(&bytes).unwrap();

        match decoded {
            Event::RecurringTransfer(e) => {
                assert_eq!(e.delegation, delegation());
                assert_eq!(e.delegator, delegator());
                assert_eq!(e.delegatee, delegatee());
                assert_eq!(e.mint, mint());
                assert_eq!({ e.amount }, amount());
                assert_eq!({ e.period_start_ts }, period_start_ts());
                assert_eq!({ e.period_end_ts }, period_end_ts());
                assert_eq!({ e.amount_pulled_in_period }, amount_pulled_in_period());
                assert_eq!(e.receiver, receiver());
            }
            _ => panic!("expected RecurringTransfer event"),
        }
    }
}
