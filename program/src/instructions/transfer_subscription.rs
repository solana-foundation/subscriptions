use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::SubscriptionTransferEvent,
    helpers::{
        transfer_with_delegate, validate_recurring_transfer, TransferAccounts, TransferData,
    },
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionAuthorityAccount, SubscriptionsError,
    TokenAccountInterface, TokenProgramInterface, WritableAccount,
};

use crate::get_token_account_owner;

/// Instruction discriminator byte for `TransferSubscription`.
pub const DISCRIMINATOR: &u8 = &10;

/// Executes a transfer against a [`SubscriptionDelegation`].
///
/// Validates the caller is an authorized puller, checks the receiver against
/// the plan's destination whitelist, enforces per-period limits, performs the
/// SPL token transfer, and emits a
/// [`SubscriptionTransferEvent`].
pub fn process(accounts: &[AccountView], transfer_data: &TransferData) -> ProgramResult {
    let accounts_struct = TransferSubscriptionAccounts::try_from(accounts)?;

    let current_ts = Clock::get()?.unix_timestamp;

    // Load Plan (immutable borrow) — extract needed data, then drop borrow
    let plan_terms: crate::instructions::create_plan::PlanTerms;
    let plan_end_ts: i64;
    let receiver_owner: Address;
    {
        let plan_data = accounts_struct.plan_pda.try_borrow()?;
        let plan = Plan::load(&plan_data)?;

        if plan.data.mint != transfer_data.mint {
            return Err(SubscriptionsError::MintMismatch.into());
        }

        plan_end_ts = plan.data.end_ts;
        if plan_end_ts != 0 && current_ts > plan_end_ts {
            return Err(SubscriptionsError::PlanExpired.into());
        }

        plan.can_pull(accounts_struct.caller.address())?;

        // Validate destination: read receiver_ata owner from token account data
        let receiver_data = accounts_struct.receiver_ata.try_borrow()?;
        receiver_owner = get_token_account_owner(&receiver_data)?;
        plan.check_destination(&receiver_owner)?;

        plan_terms = plan.data.terms;
    }

    // Load SubscriptionDelegation (mutable borrow)
    let amount_per_period: u64;
    let period_length_s: u64;
    let period_start: i64;
    let amount_pulled_in_period: u64;
    let init_id: i64;
    {
        let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let subscription = SubscriptionDelegation::load_mut(&mut binding)?;

        subscription.check_plan_terms(&plan_terms)?;

        let delegator = subscription.header.delegator;

        // The delegatee must match the plan PDA passed into the instruction
        if subscription.header.delegatee != *accounts_struct.plan_pda.address() {
            return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
        }

        // Verify delegator matches transfer data
        if delegator != transfer_data.delegator {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        // Check cancellation — expires_at_ts is pre-computed at cancellation time
        let expires_at_ts = subscription.expires_at_ts;
        if expires_at_ts != 0 && current_ts >= expires_at_ts {
            return Err(SubscriptionsError::SubscriptionCancelled.into());
        }

        amount_per_period = subscription.terms.amount;
        period_length_s = subscription.terms.period_hours * 3600;

        // Validate recurring transfer
        let mut ps = subscription.current_period_start_ts;
        let mut pulled = subscription.amount_pulled_in_period;
        validate_recurring_transfer(
            transfer_data.amount,
            amount_per_period,
            period_length_s,
            &mut ps,
            &mut pulled,
            plan_end_ts,
            current_ts,
        )?;
        subscription.current_period_start_ts = ps;
        subscription.amount_pulled_in_period = pulled;

        period_start = ps;
        amount_pulled_in_period = pulled;
        init_id = subscription.header.init_id;
    }

    // Execute transfer
    transfer_with_delegate(
        transfer_data.amount,
        &transfer_data.delegator,
        &transfer_data.mint,
        init_id,
        &TransferAccounts {
            delegator_ata: accounts_struct.delegator_ata,
            to_ata: accounts_struct.receiver_ata,
            subscription_authority_pda: accounts_struct.subscription_authority,
            token_program: accounts_struct.token_program,
        },
    )?;

    // Emit TransferSuccess event via self-CPI
    let period_end_ts = {
        let end = period_start + period_length_s as i64;
        if plan_end_ts != 0 && end > plan_end_ts {
            plan_end_ts
        } else {
            end
        }
    };

    let event = SubscriptionTransferEvent::new(
        *accounts_struct.subscription_pda.address(),
        *accounts_struct.plan_pda.address(),
        transfer_data.delegator,
        transfer_data.mint,
        transfer_data.amount,
        period_start,
        period_end_ts,
        amount_pulled_in_period,
        receiver_owner,
    );
    let event_data = event.to_bytes();
    event_engine::emit_event(
        &crate::ID,
        accounts_struct.event_authority,
        accounts_struct.self_program,
        &event_data,
    )?;

    Ok(())
}

/// Validated accounts for the [`TransferSubscription`](crate::SubscriptionsInstruction::TransferSubscription) instruction.
pub struct TransferSubscriptionAccounts<'a> {
    pub subscription_pda: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    pub delegator_ata: &'a AccountView,
    pub receiver_ata: &'a AccountView,
    pub caller: &'a AccountView,
    pub token_program: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for TransferSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [subscription_pda, plan_pda, subscription_authority, delegator_ata, receiver_ata, caller, token_program, event_authority, self_program] =
            accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;
        // Return a specific error if the plan account has been closed
        if !plan_pda.owned_by(&crate::ID) {
            return Err(SubscriptionsError::PlanClosed.into());
        }
        SubscriptionAuthorityAccount::check(subscription_authority)?;
        WritableAccount::check(delegator_ata)?;
        WritableAccount::check(receiver_ata)?;
        SignerAccount::check(caller)?;
        TokenProgramInterface::check(token_program)?;
        TokenAccountInterface::check_accounts_with_program(
            token_program,
            &[delegator_ata, receiver_ata],
        )?;

        Ok(Self {
            subscription_pda,
            plan_pda,
            subscription_authority,
            delegator_ata,
            receiver_ata,
            caller,
            token_program,
            event_authority,
            self_program,
        })
    }
}
