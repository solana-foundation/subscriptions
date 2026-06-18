//! Instruction definitions and dispatch for the subscriptions program.
//!
//! Each instruction variant carries its own discriminator (the first byte of
//! instruction data) and, where applicable, an inline data payload. The Codama
//! annotations on each variant describe the required accounts.

pub mod cancel_subscription;
pub mod close_subscription_authority;
pub mod create_fixed_delegation;
pub use create_fixed_delegation::CreateFixedDelegationData;
pub mod create_plan;
pub mod create_recurring_delegation;
pub mod delete_plan;
pub mod subscribe;
pub mod update_plan;
pub use create_recurring_delegation::CreateRecurringDelegationData;
pub mod emit_event;
pub mod helpers;
pub mod initialize_subscription_authority;
pub mod resume_subscription;
pub mod revoke_abandoned_delegation;
pub mod revoke_abandoned_subscription;
pub mod revoke_delegation;
pub mod revoke_subscription_authority;
pub mod transfer_fixed_delegation;
pub mod transfer_recurring_delegation;
pub mod transfer_subscription;

pub use helpers::*;

use core::fmt;

use codama::CodamaInstructions;
use pinocchio::error::ProgramError;

use crate::event_engine::EMIT_EVENT_IX_DISC;
use crate::instructions::create_plan::PlanData;
use crate::instructions::subscribe::SubscribeData;
use crate::instructions::update_plan::UpdatePlanData;
use crate::SubscriptionsError;

/// All instructions supported by the subscriptions program.
///
/// The discriminator byte (`repr(u8)` value) is serialized as the first byte of
/// instruction data. Codama `#[codama(account(...))]` annotations describe the
/// expected account list for each variant.
#[derive(Debug, CodamaInstructions)]
#[repr(u8)]
#[allow(clippy::large_enum_variant)]
pub enum SubscriptionsInstruction {
    #[codama(account(name = "owner", signer, writable, docs = "The owner of the subscription-authority program"))]
    #[codama(account(
        name = "subscription_authority",
        writable,
        docs = "The subscription_authority PDA that will be the delegate instance for this token",
        default_value = pda("subscriptionAuthority", [seed("user", account("owner")), seed("tokenMint", account("token_mint"))])
    ))]
    #[codama(account(
        name = "token_mint",
        docs = "The token mint that we are creating a subscription-authority account for"
    ))]
    #[codama(account(name = "user_ata", writable, docs = "The ata that we are setting up delegation for"))]
    #[codama(account(
        name = "system_program",
        docs = "The system program",
        default_value = program("system")
    ))]
    #[codama(account(name = "token_program", docs = "Token program"))]
    #[codama(account(
        name = "payer",
        signer,
        writable,
        optional,
        docs = "Optional sponsor that funds the account rent. Defaults to the owner/signer when omitted."
    ))]
    #[codama(optional_account_strategy = omitted)]
    InitSubscriptionAuthority = 0,

    #[codama(account(name = "delegator", signer, writable, docs = "The user creating the delegation"))]
    #[codama(account(name = "subscription_authority", docs = "The subscription_authority PDA for this token"))]
    #[codama(account(name = "delegation_account", writable, docs = "The fixed delegation PDA being created"))]
    #[codama(account(name = "delegatee", docs = "The user receiving delegation rights"))]
    #[codama(account(
        name = "system_program",
        docs = "The system program",
        default_value = program("system")
    ))]
    #[codama(account(
        name = "payer",
        signer,
        writable,
        optional,
        docs = "Optional sponsor that funds the account rent. Defaults to the delegator/signer when omitted."
    ))]
    #[codama(optional_account_strategy = omitted)]
    CreateFixedDelegation(#[codama(name = "fixed_delegation")] CreateFixedDelegationData) = 1,

    #[codama(account(name = "delegator", signer, writable, docs = "The user creating the delegation"))]
    #[codama(account(name = "subscription_authority", docs = "The subscription_authority PDA for this token"))]
    #[codama(account(name = "delegation_account", writable, docs = "The recurring delegation PDA being created"))]
    #[codama(account(name = "delegatee", docs = "The user receiving delegation rights"))]
    #[codama(account(
        name = "system_program",
        docs = "The system program",
        default_value = program("system")
    ))]
    #[codama(account(
        name = "payer",
        signer,
        writable,
        optional,
        docs = "Optional sponsor that funds the account rent. Defaults to the delegator/signer when omitted."
    ))]
    #[codama(optional_account_strategy = omitted)]
    CreateRecurringDelegation(#[codama(name = "recurring_delegation")] CreateRecurringDelegationData) = 2,

    #[codama(account(
        name = "authority",
        signer,
        writable,
        docs = "The delegator revoking the delegation (receives rent)"
    ))]
    #[codama(account(name = "delegation_account", writable, docs = "The delegation PDA to close"))]
    RevokeDelegation = 3,

    #[codama(account(name = "delegation_pda", writable, docs = "The fixed delegation PDA to transfer from"))]
    #[codama(account(name = "subscription_authority", docs = "The subscription-authority PDA"))]
    #[codama(account(name = "delegator_ata", writable, docs = "The delegator's ATA to transfer from"))]
    #[codama(account(name = "receiver_ata", writable, docs = "The receiver's ATA to transfer to"))]
    #[codama(account(name = "token_mint", docs = "The token mint"))]
    #[codama(account(name = "token_program", docs = "Token program"))]
    #[codama(account(name = "delegatee", signer, docs = "The delegatee signing the transfer"))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    TransferFixed(#[codama(name = "transfer_data")] TransferData) = 4,

    #[codama(account(name = "delegation_pda", writable, docs = "The recurring delegation PDA to transfer from"))]
    #[codama(account(name = "subscription_authority", docs = "The subscription-authority PDA"))]
    #[codama(account(name = "delegator_ata", writable, docs = "The delegator's ATA to transfer from"))]
    #[codama(account(name = "receiver_ata", writable, docs = "The receiver's ATA to transfer to"))]
    #[codama(account(name = "token_mint", docs = "The token mint"))]
    #[codama(account(name = "token_program", docs = "Token program"))]
    #[codama(account(name = "delegatee", signer, docs = "The delegatee signing the transfer"))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    TransferRecurring(#[codama(name = "transfer_data")] TransferData) = 5,

    #[codama(account(
        name = "user",
        signer,
        writable,
        docs = "The user who owns the SubscriptionAuthority PDA (receives rent)"
    ))]
    #[codama(account(name = "subscription_authority", writable, docs = "The SubscriptionAuthority PDA to close"))]
    #[codama(account(
        name = "receiver",
        writable,
        optional,
        docs = "Optional rent recipient, required when the recorded payer differs from the user. Must match the stored payer."
    ))]
    #[codama(optional_account_strategy = omitted)]
    CloseSubscriptionAuthority = 6,

    #[codama(account(name = "merchant", signer, writable, docs = "The merchant creating the plan"))]
    #[codama(account(name = "plan_pda", writable, docs = "The plan PDA being created"))]
    #[codama(account(name = "token_mint", docs = "The token mint"))]
    #[codama(account(
        name = "system_program",
        docs = "The system program",
        default_value = program("system")
    ))]
    #[codama(account(
        name = "token_program",
        docs = "The token program",
        default_value = program("token")
    ))]
    CreatePlan(#[codama(name = "plan_data")] PlanData) = 7,

    #[codama(account(name = "owner", signer, docs = "The plan owner updating the plan"))]
    #[codama(account(name = "plan_pda", writable, docs = "The plan PDA being updated"))]
    UpdatePlan(#[codama(name = "update_plan_data")] UpdatePlanData) = 8,

    #[codama(account(name = "owner", signer, writable, docs = "The plan owner deleting the plan (receives rent)"))]
    #[codama(account(name = "plan_pda", writable, docs = "The plan PDA being deleted"))]
    DeletePlan = 9,

    #[codama(account(name = "subscription_pda", writable, docs = "The subscription delegation PDA"))]
    #[codama(account(name = "plan_pda", docs = "The plan PDA"))]
    #[codama(account(name = "subscription_authority", docs = "The subscription-authority PDA"))]
    #[codama(account(name = "delegator_ata", writable, docs = "The delegator's ATA to transfer from"))]
    #[codama(account(name = "receiver_ata", writable, docs = "The receiver's ATA to transfer to"))]
    #[codama(account(name = "caller", signer, docs = "The authorized puller (plan owner or whitelisted)"))]
    #[codama(account(name = "token_mint", docs = "The token mint"))]
    #[codama(account(name = "token_program", docs = "Token program"))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    TransferSubscription(#[codama(name = "transfer_data")] TransferData) = 10,

    #[codama(account(
        name = "subscriber",
        signer,
        writable,
        docs = "The subscriber creating the subscription (pays rent)"
    ))]
    #[codama(account(name = "merchant", docs = "The merchant who owns the plan"))]
    #[codama(account(name = "plan_pda", docs = "The plan PDA to subscribe to"))]
    #[codama(account(
        name = "subscription_pda",
        writable,
        docs = "The subscription PDA being created",
        default_value = pda("subscriptionDelegation", [seed("planPda", account("plan_pda")), seed("subscriber", account("subscriber"))])
    ))]
    #[codama(account(
        name = "subscription_authority_pda",
        docs = "The subscriber's SubscriptionAuthority PDA for the plan's mint"
    ))]
    #[codama(account(
        name = "system_program",
        docs = "The system program",
        default_value = program("system")
    ))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    #[codama(account(
        name = "payer",
        signer,
        writable,
        optional,
        docs = "Optional sponsor that funds the account rent. Defaults to the subscriber/signer when omitted."
    ))]
    #[codama(optional_account_strategy = omitted)]
    Subscribe(#[codama(name = "subscribe_data")] SubscribeData) = 11,

    #[codama(account(name = "subscriber", signer, docs = "The subscriber cancelling the subscription"))]
    #[codama(account(name = "plan_pda", docs = "The plan PDA for the subscription"))]
    #[codama(account(
        name = "subscription_pda",
        writable,
        docs = "The subscription PDA being cancelled",
        default_value = pda("subscriptionDelegation", [seed("planPda", account("plan_pda")), seed("subscriber", account("subscriber"))])
    ))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    CancelSubscription = 12,

    #[codama(account(name = "subscriber", signer, docs = "The subscriber resuming the subscription"))]
    #[codama(account(name = "plan_pda", docs = "The plan PDA for the subscription"))]
    #[codama(account(
        name = "subscription_pda",
        writable,
        docs = "The subscription PDA being resumed",
        default_value = pda("subscriptionDelegation", [seed("planPda", account("plan_pda")), seed("subscriber", account("subscriber"))])
    ))]
    #[codama(account(
        name = "event_authority",
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    #[codama(account(
        name = "self_program",
        docs = "This program (for self-CPI)",
        default_value = public_key("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44")
    ))]
    ResumeSubscription = 13,

    #[codama(account(
        name = "user",
        signer,
        writable,
        docs = "The ATA owner: revokes the program's delegate and, when still open, closes the SubscriptionAuthority PDA (receives rent when self-funded)"
    ))]
    #[codama(account(name = "user_ata", writable, docs = "The user's ATA whose delegate is being revoked"))]
    #[codama(account(name = "token_mint", docs = "The token mint of the user's ATA"))]
    #[codama(account(name = "token_program", docs = "Token program"))]
    #[codama(account(
        name = "subscription_authority",
        writable,
        docs = "The SubscriptionAuthority PDA. Closed when still open; ignored when already closed.",
        default_value = pda("subscriptionAuthority", [seed("user", account("user")), seed("tokenMint", account("token_mint"))])
    ))]
    #[codama(account(
        name = "receiver",
        writable,
        optional,
        docs = "Optional rent recipient, required when the SubscriptionAuthority is still open and its recorded payer differs from the user. Must match the stored payer."
    ))]
    #[codama(optional_account_strategy = omitted)]
    RevokeSubscriptionAuthority = 14,

    #[codama(account(name = "payer", signer, writable, docs = "The recorded payer reclaiming rent"))]
    #[codama(account(name = "delegation_account", writable, docs = "The fixed or recurring delegation PDA to close"))]
    #[codama(account(
        name = "subscription_authority",
        docs = "The delegation's recorded SubscriptionAuthority PDA (may be closed)"
    ))]
    RevokeAbandonedDelegation = 15,

    #[codama(account(name = "payer", signer, writable, docs = "The recorded payer reclaiming rent"))]
    #[codama(account(name = "subscription_account", writable, docs = "The abandoned subscription PDA to close"))]
    #[codama(account(
        name = "subscription_authority",
        docs = "The subscriber's recorded SubscriptionAuthority PDA for the plan's mint (may be closed)"
    ))]
    #[codama(account(name = "plan_pda", docs = "The plan the subscription belongs to; provides the mint"))]
    RevokeAbandonedSubscription = 16,

    #[codama(skip)]
    #[codama(account(
        name = "event_authority",
        signer,
        docs = "The event authority PDA",
        default_value = pda("eventAuthority")
    ))]
    EmitEvent = 228,
}

impl SubscriptionsInstruction {
    /// Parse a `SubscriptionsInstruction` from raw instruction bytes.
    /// The first byte is the discriminator, followed by instruction-specific data.
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        let (discriminator, rest) = data.split_first().ok_or(SubscriptionsError::InvalidInstruction)?;

        match discriminator {
            initialize_subscription_authority::DISCRIMINATOR => Ok(Self::InitSubscriptionAuthority),
            create_fixed_delegation::DISCRIMINATOR => {
                let loaded = CreateFixedDelegationData::load(rest)?;
                Ok(Self::CreateFixedDelegation(loaded.clone()))
            }
            create_recurring_delegation::DISCRIMINATOR => {
                let loaded = CreateRecurringDelegationData::load(rest)?;
                Ok(Self::CreateRecurringDelegation(loaded.clone()))
            }
            revoke_delegation::DISCRIMINATOR => Ok(Self::RevokeDelegation),
            transfer_fixed_delegation::DISCRIMINATOR => {
                let loaded = TransferData::load(rest)?;
                Ok(Self::TransferFixed(loaded.clone()))
            }
            transfer_recurring_delegation::DISCRIMINATOR => {
                let loaded = TransferData::load(rest)?;
                Ok(Self::TransferRecurring(loaded.clone()))
            }
            close_subscription_authority::DISCRIMINATOR => Ok(Self::CloseSubscriptionAuthority),
            create_plan::DISCRIMINATOR => {
                let loaded = PlanData::load(rest)?;
                Ok(Self::CreatePlan(loaded.clone()))
            }
            update_plan::DISCRIMINATOR => {
                let loaded = UpdatePlanData::load(rest)?;
                Ok(Self::UpdatePlan(loaded.clone()))
            }
            delete_plan::DISCRIMINATOR => Ok(Self::DeletePlan),
            transfer_subscription::DISCRIMINATOR => {
                let loaded = TransferData::load(rest)?;
                Ok(Self::TransferSubscription(loaded.clone()))
            }
            subscribe::DISCRIMINATOR => {
                let loaded = SubscribeData::load(rest)?;
                Ok(Self::Subscribe(loaded.clone()))
            }
            cancel_subscription::DISCRIMINATOR => Ok(Self::CancelSubscription),
            resume_subscription::DISCRIMINATOR => Ok(Self::ResumeSubscription),
            revoke_subscription_authority::DISCRIMINATOR => Ok(Self::RevokeSubscriptionAuthority),
            revoke_abandoned_delegation::DISCRIMINATOR => Ok(Self::RevokeAbandonedDelegation),
            revoke_abandoned_subscription::DISCRIMINATOR => Ok(Self::RevokeAbandonedSubscription),
            &EMIT_EVENT_IX_DISC => Ok(Self::EmitEvent),
            _ => Err(SubscriptionsError::InvalidInstruction.into()),
        }
    }
}

impl fmt::Display for SubscriptionsInstruction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InitSubscriptionAuthority => write!(f, "init_subscription_authority"),
            Self::CreateFixedDelegation(_) => write!(f, "create_fixed_delegation"),
            Self::CreateRecurringDelegation(_) => write!(f, "create_recurring_delegation"),
            Self::RevokeDelegation => write!(f, "revoke_delegation"),
            Self::TransferFixed(_) => write!(f, "transfer_fixed"),
            Self::TransferRecurring(_) => write!(f, "transfer_recurring"),
            Self::CloseSubscriptionAuthority => write!(f, "close_subscription_authority"),
            Self::CreatePlan(_) => write!(f, "create_plan"),
            Self::UpdatePlan(_) => write!(f, "update_plan"),
            Self::DeletePlan => write!(f, "delete_plan"),
            Self::TransferSubscription(_) => write!(f, "transfer_subscription"),
            Self::Subscribe(_) => write!(f, "subscribe"),
            Self::CancelSubscription => write!(f, "cancel_subscription"),
            Self::ResumeSubscription => write!(f, "resume_subscription"),
            Self::RevokeSubscriptionAuthority => write!(f, "revoke_subscription_authority"),
            Self::RevokeAbandonedDelegation => write!(f, "revoke_abandoned_delegation"),
            Self::RevokeAbandonedSubscription => write!(f, "revoke_abandoned_subscription"),
            Self::EmitEvent => write!(f, "emit_event"),
        }
    }
}
