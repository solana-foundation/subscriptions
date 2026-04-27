use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    check_and_update_version,
    event_engine::{self, EventSerialize},
    events::SubscriptionCancelledEvent,
    state::{plan::Plan, subscription_delegation::SubscriptionDelegation},
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction discriminator byte for `CancelSubscription`.
pub const DISCRIMINATOR: &u8 = &12;

/// Cancels a subscription by setting its `expires_at_ts` to the end of the
/// current billing period.
///
/// After cancellation the subscription remains valid until `expires_at_ts`,
/// then it can be closed via [`RevokeDelegation`](crate::instructions::revoke_delegation).
/// Emits a [`SubscriptionCancelledEvent`].
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts_struct = CancelSubscriptionAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    let expires_at_ts;
    let plan_pda;
    {
        let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;
        check_and_update_version(&mut binding)?;
        let subscription = SubscriptionDelegation::load_mut_with_min_size(&mut binding)?;

        // Verify caller is the subscriber (delegator)
        if subscription.header.delegator != *accounts_struct.subscriber.address() {
            return Err(SubscriptionsError::Unauthorized.into());
        }

        // Check not already cancelled
        if subscription.expires_at_ts != 0 {
            return Err(SubscriptionsError::SubscriptionAlreadyCancelled.into());
        }

        // Validate subscription's delegatee matches the passed plan_pda
        if subscription.header.delegatee != *accounts_struct.plan_pda.address() {
            return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
        }

        plan_pda = subscription.header.delegatee;

        // Compute expires_at_ts based on plan state
        if accounts_struct.plan_pda.owned_by(&crate::ID) {
            // Plan is valid — load it and verify terms match
            let plan_data = accounts_struct.plan_pda.try_borrow()?;
            let plan = Plan::load(&plan_data)?;

            if subscription.check_plan_terms(&plan.data.terms).is_err() {
                // Plan terms mismatch (ghost plan) — expire immediately
                expires_at_ts = current_ts;
            } else {
                // Terms match — compute end of current period
                let period_length_s =
                    (subscription.terms.period_hours as i64)
                        .checked_mul(3600)
                        .ok_or::<ProgramError>(SubscriptionsError::ArithmeticOverflow.into())?;
                let period_start = subscription.current_period_start_ts;
                let elapsed = current_ts.saturating_sub(period_start);
                let periods_elapsed = elapsed / period_length_s;
                expires_at_ts = periods_elapsed
                    .checked_add(1)
                    .and_then(|p| p.checked_mul(period_length_s))
                    .and_then(|offset| period_start.checked_add(offset))
                    // Cap at plan end so subscriber can revoke as soon as the plan expires
                    .map(|ts| {
                        if plan.data.end_ts != 0 {
                            ts.min(plan.data.end_ts)
                        } else {
                            ts
                        }
                    })
                    .ok_or::<ProgramError>(SubscriptionsError::ArithmeticOverflow.into())?;
            }
        } else {
            // Plan is closed (not owned by our program) — expire immediately
            expires_at_ts = current_ts;
        }

        subscription.expires_at_ts = expires_at_ts;
    }

    // Emit SubscriptionCancelled event via self-CPI
    let event = SubscriptionCancelledEvent::new(
        plan_pda,
        *accounts_struct.subscriber.address(),
        expires_at_ts,
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

/// Validated accounts for the [`CancelSubscription`](crate::SubscriptionsInstruction::CancelSubscription) instruction.
pub struct CancelSubscriptionAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for CancelSubscriptionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, plan_pda, subscription_pda, event_authority, self_program] = accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        ProgramAccount::check(subscription_pda)?;
        WritableAccount::check(subscription_pda)?;

        Ok(Self {
            subscriber,
            plan_pda,
            subscription_pda,
            event_authority,
            self_program,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        state::subscription_delegation::SubscriptionDelegation,
        tests::{
            asserts::TransactionResultExt,
            utils::{
                current_ts, days, hours, init_wallet, minutes, move_clock_forward,
                setup_with_subscription, CancelSubscription, CreatePlan, DeletePlan, UpdatePlan,
            },
        },
        SubscriptionsError,
    };
    #[test]
    fn cancel_subscription_happy_path() {
        let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) =
            setup_with_subscription();

        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_ok();

        // Verify expires_at_ts is set (end of current period)
        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        assert_ne!({ sub.expires_at_ts }, 0);
    }

    #[test]
    fn cancel_subscription_non_subscriber_rejected() {
        let (mut litesvm, _alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) =
            setup_with_subscription();

        let attacker = init_wallet(&mut litesvm, 10_000_000_000);
        let res =
            CancelSubscription::new(&mut litesvm, &attacker, plan_pda, subscription_pda).execute();
        res.assert_err(SubscriptionsError::Unauthorized);
    }

    #[test]
    fn cancel_subscription_already_cancelled_rejected() {
        let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) =
            setup_with_subscription();

        // Cancel once
        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_ok();

        // Cancel again should fail
        let res =
            CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute();
        res.assert_err(SubscriptionsError::SubscriptionAlreadyCancelled);
    }

    #[test]
    fn test_cancel_subscription_version_mismatch() {
        use crate::state::header::VERSION_OFFSET;

        let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) =
            setup_with_subscription();

        let mut account = litesvm.get_account(&subscription_pda).unwrap();
        account.data[VERSION_OFFSET] = 0;
        litesvm.set_account(subscription_pda, account).unwrap();

        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_err(SubscriptionsError::MigrationRequired);
    }

    #[test]
    fn cancel_subscription_ghost_plan_expires_immediately() {
        use crate::state::common::PlanStatus;

        let (mut litesvm, alice, merchant, mint, plan_pda, _plan_bump, subscription_pda) =
            setup_with_subscription();

        // Get current time before any clock manipulation
        let ts_before = litesvm
            .get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>()
            .unix_timestamp;

        // Sunset, expire, and delete the plan
        let end_ts = current_ts() + days(2) as i64;
        UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute()
            .assert_ok();

        move_clock_forward(&mut litesvm, days(3));

        DeletePlan::new(&mut litesvm, &merchant, plan_pda)
            .execute()
            .assert_ok();

        // Recreate plan with same plan_id but different terms
        let new_end_ts = current_ts() + days(60) as i64;
        let (res, new_plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
            .plan_id(1)
            .amount(999_000_000)
            .period_hours(720)
            .end_ts(new_end_ts)
            .execute();
        res.assert_ok();
        assert_eq!(plan_pda, new_plan_pda);

        // Cancel should succeed but expire immediately (no grace period)
        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_ok();

        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        let expires = sub.expires_at_ts;
        // Should be immediate (current_ts), not end-of-period
        assert!(expires > ts_before);
        // Verify it's NOT a grace period (which would be period_start + period_length)
        // Ghost plan expires at current_ts, which is much less than period_start + 720h
        let svm_ts = litesvm
            .get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>()
            .unix_timestamp;
        assert_eq!(expires, svm_ts);
    }

    #[test]
    fn cancel_subscription_caps_at_plan_end_ts() {
        use crate::instructions::create_plan::PlanTerms;
        use crate::tests::{
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            utils::{
                init_ata, init_mint, initialize_subscription_authority_action, move_clock_forward,
                setup, CreatePlan, CreateSubscription,
            },
        };
        use solana_signer::Signer;

        let (mut litesvm, alice) = setup();
        let merchant = solana_keypair::Keypair::new();
        litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

        let mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
        initialize_subscription_authority_action(&mut litesvm, &alice, mint)
            .0
            .assert_ok();

        let end_ts = current_ts() + minutes(90) as i64;
        let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
            .plan_id(1)
            .amount(50_000_000)
            .period_hours(1)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let svm_ts = litesvm
            .get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>()
            .unix_timestamp;
        let subscription_pda =
            CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts)
                .terms(PlanTerms {
                    amount: 50_000_000,
                    period_hours: 1,
                    created_at: svm_ts,
                })
                .execute();

        move_clock_forward(&mut litesvm, hours(1) + minutes(5));

        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_ok();

        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        assert_eq!(
            { sub.expires_at_ts },
            end_ts,
            "expires_at_ts should be capped at plan end_ts, not period end"
        );
    }

    #[test]
    fn cancel_subscription_after_plan_expired_allows_immediate_revoke() {
        use crate::instructions::create_plan::PlanTerms;
        use crate::tests::{
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            utils::{
                init_ata, init_mint, initialize_subscription_authority_action, move_clock_forward,
                setup, CreatePlan, CreateSubscription,
            },
        };
        use solana_signer::Signer;

        let (mut litesvm, alice) = setup();
        let merchant = solana_keypair::Keypair::new();
        litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

        let mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);
        initialize_subscription_authority_action(&mut litesvm, &alice, mint)
            .0
            .assert_ok();

        let end_ts = current_ts() + hours(2) as i64;
        let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
            .plan_id(1)
            .amount(50_000_000)
            .period_hours(1)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let svm_ts = litesvm
            .get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>()
            .unix_timestamp;
        let subscription_pda =
            CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, svm_ts)
                .terms(PlanTerms {
                    amount: 50_000_000,
                    period_hours: 1,
                    created_at: svm_ts,
                })
                .execute();

        move_clock_forward(&mut litesvm, hours(3));

        CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda)
            .execute()
            .assert_ok();

        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        let current_clock = litesvm
            .get_sysvar::<spl_associated_token_account::solana_program::clock::Clock>()
            .unix_timestamp;
        assert!(
            { sub.expires_at_ts } <= current_clock,
            "expires_at_ts ({}) should be <= current time ({}) so subscriber can revoke immediately",
            { sub.expires_at_ts },
            current_clock
        );
    }
}
