use pinocchio::{account::AccountView, entrypoint, Address, ProgramResult};

use crate::instructions::{
    cancel_subscription, close_subscription_authority, create_fixed_delegation, create_plan,
    create_recurring_delegation, delete_plan, emit_event, initialize_subscription_authority, revoke_delegation,
    subscribe, transfer_fixed_delegation, transfer_recurring_delegation, transfer_subscription, update_plan,
    SubscriptionsInstruction,
};

entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Address, accounts: &[AccountView], instruction_data: &[u8]) -> ProgramResult {
    let instruction = SubscriptionsInstruction::from_bytes(instruction_data)?;

    match instruction {
        SubscriptionsInstruction::InitSubscriptionAuthority => initialize_subscription_authority::process(accounts),
        SubscriptionsInstruction::CreateFixedDelegation(data) => create_fixed_delegation::process(accounts, &data),
        SubscriptionsInstruction::CreateRecurringDelegation(data) => {
            create_recurring_delegation::process(accounts, &data)
        }
        SubscriptionsInstruction::RevokeDelegation => revoke_delegation::process(accounts),
        SubscriptionsInstruction::TransferFixed(data) => transfer_fixed_delegation::process(accounts, &data),
        SubscriptionsInstruction::TransferRecurring(data) => transfer_recurring_delegation::process(accounts, &data),
        SubscriptionsInstruction::CloseSubscriptionAuthority => close_subscription_authority::process(accounts),
        SubscriptionsInstruction::CreatePlan(data) => create_plan::process(accounts, &data),
        SubscriptionsInstruction::UpdatePlan(data) => update_plan::process(accounts, &data),
        SubscriptionsInstruction::DeletePlan => delete_plan::process(accounts),
        SubscriptionsInstruction::TransferSubscription(data) => transfer_subscription::process(accounts, &data),
        SubscriptionsInstruction::Subscribe(data) => subscribe::process(accounts, &data),
        SubscriptionsInstruction::CancelSubscription => cancel_subscription::process(accounts),
        SubscriptionsInstruction::EmitEvent => emit_event::process(program_id, accounts),
    }
}
