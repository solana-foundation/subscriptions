use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    state::plan::Plan, AccountCheck, AccountClose, ProgramAccount, SignerAccount,
    SubscriptionsError, WritableAccount,
};

/// Validated accounts for the [`DeletePlan`](crate::SubscriptionsInstruction::DeletePlan) instruction.
pub struct DeletePlanAccounts<'a> {
    pub owner: &'a AccountView,
    pub plan_pda: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for DeletePlanAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [owner, plan_pda] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(owner)?;
        WritableAccount::check(owner)?;
        WritableAccount::check(plan_pda)?;
        ProgramAccount::check(plan_pda)?;

        Ok(Self { owner, plan_pda })
    }
}

/// Instruction discriminator byte for `DeletePlan`.
pub const DISCRIMINATOR: &u8 = &9;

/// Deletes an expired [`Plan`] PDA, returning rent to the owner.
///
/// The plan must have a non-zero `end_ts` that is in the past. Only the plan
/// owner may delete it.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = DeletePlanAccounts::try_from(accounts)?;

    let data = accounts.plan_pda.try_borrow()?;
    let plan = Plan::load(&data)?;

    if &plan.owner != accounts.owner.address() {
        return Err(SubscriptionsError::NotPlanOwner.into());
    }

    let current_ts = Clock::get()?.unix_timestamp;
    if plan.data.end_ts == 0 || current_ts <= plan.data.end_ts {
        return Err(SubscriptionsError::PlanNotExpired.into());
    }

    drop(data);

    ProgramAccount::close(accounts.plan_pda, accounts.owner)
}
