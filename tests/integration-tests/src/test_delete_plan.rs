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
