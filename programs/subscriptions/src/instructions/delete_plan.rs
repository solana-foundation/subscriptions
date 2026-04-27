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

#[cfg(test)]
mod tests {
    use solana_signer::Signer;

    use crate::{
        state::common::PlanStatus,
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            utils::{
                current_ts, days, init_mint, init_wallet, move_clock_forward, setup, CreatePlan,
                DeletePlan, UpdatePlan,
            },
        },
        SubscriptionsError,
    };

    #[test]
    fn delete_plan_happy_path() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(3));

        let account_before = litesvm.get_account(&plan_pda);
        assert!(account_before.is_some());
        let rent = account_before.unwrap().lamports;
        let owner_balance_before = litesvm.get_account(&owner.pubkey()).unwrap().lamports;

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&plan_pda);
        assert!(
            account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0
        );

        let owner_balance_after = litesvm.get_account(&owner.pubkey()).unwrap().lamports;
        assert!(owner_balance_after > owner_balance_before);
        assert!(owner_balance_after >= owner_balance_before + rent - 10000);
    }

    #[test]
    fn delete_plan_not_owner() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(3));

        let attacker = init_wallet(litesvm, 1_000_000_000);
        let res = DeletePlan::new(litesvm, &attacker, plan_pda).execute();
        res.assert_err(SubscriptionsError::NotPlanOwner);

        let account_after = litesvm.get_account(&plan_pda);
        assert!(account_after.is_some());
        assert!(account_after.as_ref().map(|a| a.lamports).unwrap_or(0) > 0);
    }

    #[test]
    fn delete_active_expired_plan() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(3));

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&plan_pda);
        assert!(
            account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0
        );
    }

    #[test]
    fn delete_active_not_expired_fails() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(30) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_err(SubscriptionsError::PlanNotExpired);
    }

    #[test]
    fn delete_sunset_not_expired_fails() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(30) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_err(SubscriptionsError::PlanNotExpired);
    }

    #[test]
    fn delete_sunset_exactly_at_end_ts_fails() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(2));

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_err(SubscriptionsError::PlanNotExpired);
    }

    #[test]
    fn delete_plan_double_delete_fails() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(3));

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        assert!(res.is_err());
    }

    #[test]
    fn delete_plan_data_zeroed() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let end_ts = current_ts() + days(2) as i64;
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        move_clock_forward(litesvm, days(3));

        let res = DeletePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&plan_pda);
        if let Some(account) = account_after {
            assert!(
                account.data.iter().all(|&byte| byte == 0),
                "All data should be zeroed after delete"
            );
        }
    }
}
