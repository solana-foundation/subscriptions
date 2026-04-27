//! Subscriptions Solana Program.
//!
//! A token delegation program for SPL Token and Token-2022 that allows users to
//! grant scoped spending authority to third parties without transferring ownership.
//!
//! The program supports three delegation models:
//!
//! - **Fixed delegations** -- a one-time allowance with an optional expiry timestamp.
//! - **Recurring delegations** -- a periodic allowance that resets each period, with
//!   configurable period length and overall expiry.
//! - **Subscription plans** -- merchant-defined plans where subscribers grant recurring
//!   pull access; the merchant (or whitelisted pullers) can transfer funds each period.
//!
//! All delegation state is stored in Program Derived Accounts (PDAs). The program is
//! built on the [Pinocchio](https://docs.rs/pinocchio) runtime for minimal compute
//! overhead and uses [Codama](https://github.com/codama-idl/codama) for IDL generation.

use pinocchio::{address::declare_id, AccountView, Address, ProgramResult};

pinocchio::entrypoint!(process_instruction);

pub mod instructions;
pub use instructions::*;

pub mod state;
pub use state::*;

pub mod errors;
pub use errors::*;

pub mod event_engine;
pub mod events;

pub mod constants;
pub use constants::*;

pub mod tests;

declare_id!("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

/// Program entrypoint: deserializes the instruction discriminator and dispatches
/// to the appropriate instruction processor.
fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = SubscriptionsInstruction::from_bytes(instruction_data)?;

    match instruction {
        SubscriptionsInstruction::InitSubscriptionAuthority => {
            initialize_subscription_authority::process(accounts)
        }
        SubscriptionsInstruction::CreateFixedDelegation(data) => {
            create_fixed_delegation::process(accounts, &data)
        }
        SubscriptionsInstruction::CreateRecurringDelegation(data) => {
            create_recurring_delegation::process(accounts, &data)
        }
        SubscriptionsInstruction::RevokeDelegation => revoke_delegation::process(accounts),
        SubscriptionsInstruction::TransferFixed(data) => {
            transfer_fixed_delegation::process(accounts, &data)
        }
        SubscriptionsInstruction::TransferRecurring(data) => {
            transfer_recurring_delegation::process(accounts, &data)
        }
        SubscriptionsInstruction::CloseSubscriptionAuthority => {
            close_subscription_authority::process(accounts)
        }
        SubscriptionsInstruction::CreatePlan(data) => create_plan::process(accounts, &data),
        SubscriptionsInstruction::UpdatePlan(data) => update_plan::process(accounts, &data),
        SubscriptionsInstruction::DeletePlan => delete_plan::process(accounts),
        SubscriptionsInstruction::TransferSubscription(data) => {
            transfer_subscription::process(accounts, &data)
        }
        SubscriptionsInstruction::Subscribe(data) => subscribe::process(accounts, &data),
        SubscriptionsInstruction::CancelSubscription => cancel_subscription::process(accounts),
        SubscriptionsInstruction::EmitEvent => emit_event::process(program_id, accounts),
    }
}
