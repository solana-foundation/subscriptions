use pinocchio::{cpi::Seed, error::ProgramError, AccountView};

use crate::{
    find_plan_pda, state::plan::Plan, AccountCheck, MintInterface, SubscriptionsError,
    ProgramAccount, ProgramAccountInit, SignerAccount, SystemAccount, TokenProgramInterface,
    WritableAccount,
};

/// Validated accounts for the [`CreatePlan`](crate::SubscriptionsInstruction::CreatePlan) instruction.
pub struct CreatePlanAccounts<'a> {
    pub merchant: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub token_mint: &'a AccountView,
    pub system_program: &'a AccountView,
    pub token_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for CreatePlanAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [merchant, plan_pda, token_mint, system_program, token_program] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(merchant)?;
        WritableAccount::check(merchant)?;
        WritableAccount::check(plan_pda)?;
        MintInterface::check_with_program(token_mint, token_program)?;
        TokenProgramInterface::check(token_program)?;
        SystemAccount::check(system_program)?;

        Ok(Self {
            merchant,
            plan_pda,
            token_mint,
            system_program,
            token_program,
        })
    }
}

/// Creates and allocates a [`Plan`] PDA.
///
/// Derives the expected PDA from the merchant address and `plan_id`, then
/// creates the account via CPI. Returns the PDA bump on success.
pub fn create_plan_account(
    accounts: &CreatePlanAccounts,
    plan_id: u64,
) -> Result<u8, ProgramError> {
    if accounts.plan_pda.data_len() > 0 {
        return Err(SubscriptionsError::PlanAlreadyExists.into());
    }

    let (expected_pda, bump) = find_plan_pda(accounts.merchant.address(), plan_id);

    if expected_pda != *accounts.plan_pda.address() {
        return Err(SubscriptionsError::InvalidPlanPda.into());
    }

    let plan_id_bytes = plan_id.to_le_bytes();
    let bump_bytes = [bump];
    let seeds = [
        Seed::from(Plan::SEED),
        Seed::from(accounts.merchant.address().as_ref()),
        Seed::from(&plan_id_bytes[..]),
        Seed::from(&bump_bytes[..]),
    ];

    ProgramAccount::init::<()>(accounts.merchant, accounts.plan_pda, &seeds, Plan::LEN)?;

    Ok(bump)
}
