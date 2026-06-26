use pinocchio::error::ProgramError;

use crate::event_engine::{EventDiscriminators, EventSerialize, EVENT_DISCRIMINATOR_LEN, EVENT_IX_TAG_LE};
use crate::events::{
    Event, FixedTransferEvent, PlanUpdatedEvent, RecurringTransferEvent, SubscriptionCancelledEvent,
    SubscriptionCreatedEvent, SubscriptionResumedEvent, SubscriptionTransferEvent,
};
use crate::SubscriptionsError;

pub fn decode_event<'a>(data: &'a [u8]) -> Result<Event<'a>, ProgramError> {
    if data.len() < EVENT_DISCRIMINATOR_LEN {
        return Err(SubscriptionsError::InvalidEventTag.into());
    }

    if data[..EVENT_IX_TAG_LE.len()] != EVENT_IX_TAG_LE {
        return Err(SubscriptionsError::InvalidEventTag.into());
    }

    let discriminator = data[EVENT_IX_TAG_LE.len()];
    let payload = &data[EVENT_DISCRIMINATOR_LEN..];

    let disc = EventDiscriminators::try_from(discriminator)
        .map_err(|_| ProgramError::from(SubscriptionsError::InvalidEventDiscriminator))?;

    match disc {
        EventDiscriminators::SubscriptionCreated => {
            Ok(Event::SubscriptionCreated(SubscriptionCreatedEvent::load(payload)?))
        }
        EventDiscriminators::SubscriptionCancelled => {
            Ok(Event::SubscriptionCancelled(SubscriptionCancelledEvent::load(payload)?))
        }
        EventDiscriminators::SubscriptionTransfer => {
            Ok(Event::SubscriptionTransfer(SubscriptionTransferEvent::load(payload)?))
        }
        EventDiscriminators::FixedTransfer => Ok(Event::FixedTransfer(FixedTransferEvent::load(payload)?)),
        EventDiscriminators::RecurringTransfer => Ok(Event::RecurringTransfer(RecurringTransferEvent::load(payload)?)),
        EventDiscriminators::SubscriptionResumed => {
            Ok(Event::SubscriptionResumed(SubscriptionResumedEvent::load(payload)?))
        }
        EventDiscriminators::PlanUpdated => Ok(Event::PlanUpdated(PlanUpdatedEvent::load(payload)?)),
    }
}
