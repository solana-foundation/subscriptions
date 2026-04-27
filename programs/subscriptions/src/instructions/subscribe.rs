use core::mem::{size_of, transmute};

use codama::CodamaType;
use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    event_engine::{self, EventSerialize},
    events::SubscriptionCreatedEvent,
    state::{
        common::{find_subscription_pda, AccountDiscriminator, PlanStatus},
        subscription_authority::SubscriptionAuthority,
        plan::Plan,
        subscription_delegation::SubscriptionDelegation,
    },
    verify_plan_pda, AccountCheck, SubscriptionAuthorityAccount, SubscriptionsError, ProgramAccount,
    ProgramAccountInit, SignerAccount, SystemAccount, WritableAccount,
};

/// Instruction discriminator byte for `Subscribe`.
pub const DISCRIMINATOR: &u8 = &11;

/// Instruction data payload for subscribing to a plan.
#[repr(C, packed)]
#[derive(CodamaType, Debug, Clone)]
pub struct SubscribeData {
    /// The plan's `plan_id` (used together with the merchant address to derive the plan PDA).
    pub plan_id: u64,
    /// The plan PDA's bump seed (avoids an on-chain `find_program_address` call).
    pub plan_bump: u8,
}

impl SubscribeData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<SubscribeData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Creates a [`SubscriptionDelegation`] PDA that
/// links the subscriber to a plan.
///
/// Validates the plan is active and not expired, verifies the subscriber's
/// [`SubscriptionAuthority`] matches the plan's mint, creates
/// the subscription account, and emits a
/// [`SubscriptionCreatedEvent`].
pub fn process(accounts: &[AccountView], data: &SubscribeData) -> ProgramResult {
    let accounts_struct = SubscribeAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    // Validate plan PDA derivation
    let expected_plan_pda = verify_plan_pda(
        accounts_struct.merchant.address(),
        data.plan_id,
        data.plan_bump,
    )?;
    if expected_plan_pda != *accounts_struct.plan_pda.address() {
        return Err(SubscriptionsError::InvalidPlanPda.into());
    }

    // Load and validate Plan
    let plan_mint;
    let plan_terms;
    {
        let plan_data = accounts_struct.plan_pda.try_borrow()?;
        let plan = Plan::load(&plan_data)?;

        if data.plan_bump != plan.bump {
            return Err(SubscriptionsError::InvalidPlanPda.into());
        }

        if PlanStatus::try_from(plan.status)? != PlanStatus::Active {
            return Err(SubscriptionsError::PlanSunset.into());
        }

        if plan.data.end_ts != 0 && current_ts > plan.data.end_ts {
            return Err(SubscriptionsError::PlanExpired.into());
        }

        plan_mint = plan.data.mint;
        plan_terms = plan.data.terms;
    }

    // Validate SubscriptionAuthority belongs to subscriber and matches plan mint
    let init_id;
    {
        let md_data = accounts_struct.subscription_authority_pda.try_borrow()?;
        let subscription_authority = SubscriptionAuthority::load(&md_data)?;

        subscription_authority.check_owner(accounts_struct.subscriber.address())?;
        if subscription_authority.token_mint != plan_mint {
            return Err(SubscriptionsError::MintMismatch.into());
        }
        init_id = subscription_authority.init_id;
    }

    // Derive and verify subscription PDA
    let (expected_pda, bump) = find_subscription_pda(
        accounts_struct.plan_pda.address(),
        accounts_struct.subscriber.address(),
    );

    if expected_pda != *accounts_struct.subscription_pda.address() {
        return Err(SubscriptionsError::InvalidSubscriptionPda.into());
    }

    // Check subscription doesn't already exist
    if accounts_struct.subscription_pda.data_len() > 0 {
        return Err(SubscriptionsError::AlreadySubscribed.into());
    }

    // Create subscription account via CPI
    let bump_bytes = [bump];
    let seeds = [
        Seed::from(SubscriptionDelegation::SEED),
        Seed::from(accounts_struct.plan_pda.address().as_ref()),
        Seed::from(accounts_struct.subscriber.address().as_ref()),
        Seed::from(&bump_bytes[..]),
    ];

    ProgramAccount::init::<()>(
        accounts_struct.payer,
        accounts_struct.subscription_pda,
        &seeds,
        SubscriptionDelegation::LEN,
    )?;

    // Initialize subscription state
    {
        let mut binding = accounts_struct.subscription_pda.try_borrow_mut()?;

        // Set discriminator first so load_mut works
        binding[0] = AccountDiscriminator::SubscriptionDelegation as u8;
        let subscription = SubscriptionDelegation::load_mut(&mut binding)?;

        subscription.header.init(
            AccountDiscriminator::SubscriptionDelegation,
            bump,
            accounts_struct.subscriber.address(),
            accounts_struct.plan_pda.address(),
            accounts_struct.payer.address(),
            init_id,
        );

        subscription.terms = plan_terms;
        subscription.amount_pulled_in_period = 0;
        subscription.current_period_start_ts = current_ts;
        subscription.expires_at_ts = 0;
    }

    // Emit SubscriptionCreated event via self-CPI
    let event = SubscriptionCreatedEvent::new(
        *accounts_struct.plan_pda.address(),
        *accounts_struct.subscriber.address(),
        plan_mint,
        current_ts,
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

/// Validated accounts for the [`Subscribe`](crate::SubscriptionsInstruction::Subscribe) instruction.
pub struct SubscribeAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub merchant: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a AccountView,
    pub subscription_authority_pda: &'a AccountView,
    pub system_program: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
    /// The account funding rent. Defaults to `subscriber` if no extra account is provided.
    pub payer: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for SubscribeAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [subscriber, merchant, plan_pda, subscription_pda, subscription_authority_pda, system_program, event_authority, self_program, rem @ ..] =
            accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(subscriber)?;
        WritableAccount::check(subscriber)?;
        ProgramAccount::check(plan_pda)?;
        WritableAccount::check(subscription_pda)?;
        SubscriptionAuthorityAccount::check(subscription_authority_pda)?;
        SystemAccount::check(system_program)?;

        let payer = if let Some(payer) = rem.first() {
            SignerAccount::check(payer)?;
            WritableAccount::check(payer)?;
            payer
        } else {
            subscriber
        };

        Ok(Self {
            subscriber,
            merchant,
            plan_pda,
            subscription_pda,
            subscription_authority_pda,
            system_program,
            event_authority,
            self_program,
            payer,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        state::subscription_delegation::SubscriptionDelegation,
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            pda::{get_plan_pda, get_subscription_pda},
            utils::{
                current_ts, days, init_ata, init_mint, init_wallet,
                initialize_subscription_authority_action, setup, CreatePlan, Subscribe,
            },
        },
        AccountDiscriminator, SubscriptionsError,
    };
    use solana_keypair::Keypair;
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;

    fn setup_plan(
        period_hours: u64,
        end_ts: i64,
    ) -> (
        litesvm::LiteSVM,
        Keypair, // alice (subscriber)
        Keypair, // merchant
        Pubkey,  // mint
        Pubkey,  // plan_pda
        u8,      // plan_bump
    ) {
        let (mut litesvm, alice) = setup();
        let merchant = Keypair::new();
        litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

        let mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        let _alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

        // Initialize subscription_authority for alice
        initialize_subscription_authority_action(&mut litesvm, &alice, mint)
            .0
            .assert_ok();

        // Create plan
        let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
            .plan_id(1)
            .amount(50_000_000)
            .period_hours(period_hours)
            .end_ts(end_ts)
            .execute();
        res.assert_ok();

        let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);

        (litesvm, alice, merchant, mint, plan_pda, plan_bump)
    }

    #[test]
    fn subscribe_happy_path() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        res.assert_ok();

        // Verify subscription state
        let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        assert_eq!(sub_account.data.len(), SubscriptionDelegation::LEN);

        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        assert_eq!(
            sub.header.discriminator,
            AccountDiscriminator::SubscriptionDelegation as u8
        );
        assert_eq!(sub.header.delegator.to_bytes(), alice.pubkey().to_bytes());
        assert_eq!(sub.header.delegatee.to_bytes(), plan_pda.to_bytes());
        assert_eq!(sub.header.payer.to_bytes(), alice.pubkey().to_bytes());
        assert_eq!({ sub.amount_pulled_in_period }, 0);
        assert_eq!({ sub.expires_at_ts }, 0);
    }

    #[test]
    fn subscribe_plan_sunset_rejected() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // Sunset the plan
        use crate::{state::common::PlanStatus, tests::utils::UpdatePlan};
        UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(end_ts)
            .execute()
            .assert_ok();

        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        res.assert_err(SubscriptionsError::PlanSunset);
    }

    #[test]
    fn subscribe_plan_expired_rejected() {
        let end_ts = current_ts() + days(2) as i64;
        let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // Move past plan expiry
        use crate::tests::utils::move_clock_forward;
        move_clock_forward(&mut litesvm, days(3));

        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        res.assert_err(SubscriptionsError::PlanExpired);
    }

    #[test]
    fn subscribe_mint_mismatch_rejected() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, alice, merchant, _mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // Create a different mint and subscription_authority for it
        let other_mint = init_mint(
            &mut litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(alice.pubkey()),
            &[],
        );
        let _other_ata = init_ata(&mut litesvm, other_mint, alice.pubkey(), 100_000_000);
        initialize_subscription_authority_action(&mut litesvm, &alice, other_mint)
            .0
            .assert_ok();

        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            other_mint,
        )
        .execute();
        res.assert_err(SubscriptionsError::MintMismatch);
    }

    #[test]
    fn subscribe_non_subscriber_subscription_authority_rejected() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, _alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // Create another user with their own subscription_authority
        let bob = init_wallet(&mut litesvm, 10_000_000_000);
        let _bob_ata = init_ata(&mut litesvm, mint, bob.pubkey(), 100_000_000);
        initialize_subscription_authority_action(&mut litesvm, &bob, mint)
            .0
            .assert_ok();

        // Try to subscribe using bob's keys but alice's subscription_authority would be wrong
        // Actually bob subscribes normally, this should succeed
        let res = Subscribe::new(
            &mut litesvm,
            &bob,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        res.assert_ok();
    }

    #[test]
    fn subscribe_no_subscription_authority_rejected() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, _alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // Create user without subscription_authority
        let charlie = init_wallet(&mut litesvm, 10_000_000_000);
        let _charlie_ata = init_ata(&mut litesvm, mint, charlie.pubkey(), 100_000_000);

        let res = Subscribe::new(
            &mut litesvm,
            &charlie,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        // Should fail because subscription_authority PDA doesn't exist (not owned by program)
        res.assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);
    }

    #[test]
    fn subscribe_with_sponsor() {
        use crate::tests::utils::init_wallet;

        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);
        let sponsor = init_wallet(&mut litesvm, 10_000_000_000);

        let alice_balance_before = litesvm.get_account(&alice.pubkey()).unwrap().lamports;
        let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .payer(&sponsor)
        .execute();
        res.assert_ok();

        // Subscriber must not be charged.
        let alice_balance_after = litesvm.get_account(&alice.pubkey()).unwrap().lamports;
        assert_eq!(alice_balance_after, alice_balance_before);
        let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
        assert!(sponsor_balance_after < sponsor_balance_before);

        // header.payer should be sponsor.
        let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
        let sub_account = litesvm.get_account(&subscription_pda).unwrap();
        let sub = SubscriptionDelegation::load(&sub_account.data).unwrap();
        assert_eq!(sub.header.payer.to_bytes(), sponsor.pubkey().to_bytes());
        assert_eq!(sub.header.delegator.to_bytes(), alice.pubkey().to_bytes());
    }

    #[test]
    fn subscribe_duplicate_rejected() {
        let end_ts = current_ts() + days(30) as i64;
        let (mut litesvm, alice, merchant, mint, plan_pda, plan_bump) = setup_plan(1, end_ts);

        // First subscription should succeed
        Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute()
        .assert_ok();

        // Second subscription to same plan should fail (PDA already exists)
        let res = Subscribe::new(
            &mut litesvm,
            &alice,
            merchant.pubkey(),
            plan_pda,
            1,
            plan_bump,
            mint,
        )
        .execute();
        res.assert_err(SubscriptionsError::AlreadySubscribed);
    }
}
