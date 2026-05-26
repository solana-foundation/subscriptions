use core::mem::{size_of, transmute};

use codama::CodamaType;
use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use pinocchio::Address;

use crate::{
    event_engine::{self, EventSerialize},
    events::SubscriptionCreatedEvent,
    helpers::system::resolve_optional_payer,
    state::{
        common::{find_subscription_pda, AccountDiscriminator, PlanStatus},
        plan::Plan,
        subscription_authority::SubscriptionAuthority,
        subscription_delegation::SubscriptionDelegation,
    },
    verify_plan_pda, AccountCheck, ProgramAccount, ProgramAccountInit, SignerAccount, SubscriptionAuthorityAccount,
    SubscriptionsError, SystemAccount, WritableAccount,
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
    /// Plan terms the subscriber consented to. The program rejects if the live
    /// plan disagrees, preventing a stale signed subscribe from binding the
    /// subscriber to terms different from what was displayed at signing time.
    pub expected_mint: Address,
    pub expected_amount: u64,
    pub expected_period_hours: u64,
    pub expected_created_at: i64,
    pub expected_subscription_authority_init_id: i64,
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
pub fn process(accounts: &mut [AccountView], data: &SubscribeData) -> ProgramResult {
    let accounts_struct = SubscribeAccounts::try_from(accounts)?;
    let current_ts = Clock::get()?.unix_timestamp;

    // Validate plan PDA derivation
    let expected_plan_pda = verify_plan_pda(accounts_struct.merchant.address(), data.plan_id, data.plan_bump)?;
    if expected_plan_pda != *accounts_struct.plan_pda.address() {
        return Err(SubscriptionsError::InvalidPlanPda.into());
    }

    // Load and validate Plan
    let plan_mint;
    let plan_terms;
    {
        let plan_data = accounts_struct.plan_pda.try_borrow()?;
        let plan = Plan::load(&plan_data)?;

        if PlanStatus::try_from(plan.status)? != PlanStatus::Active {
            return Err(SubscriptionsError::PlanSunset.into());
        }

        if plan.data.end_ts != 0 && current_ts > plan.data.end_ts {
            return Err(SubscriptionsError::PlanExpired.into());
        }

        // Bind subscriber consent to the live plan terms.
        let live_amount = plan.data.terms.amount;
        let live_period_hours = plan.data.terms.period_hours;
        let live_created_at = plan.data.terms.created_at;
        if plan.data.mint != data.expected_mint
            || live_amount != data.expected_amount
            || live_period_hours != data.expected_period_hours
            || live_created_at != data.expected_created_at
        {
            return Err(SubscriptionsError::PlanTermsMismatch.into());
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
        if subscription_authority.init_id != data.expected_subscription_authority_init_id {
            return Err(SubscriptionsError::StaleSubscriptionAuthority.into());
        }
        init_id = subscription_authority.init_id;
    }

    // Derive and verify subscription PDA
    let (expected_pda, bump) =
        find_subscription_pda(accounts_struct.plan_pda.address(), accounts_struct.subscriber.address());

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
    event_engine::emit_event(&crate::ID, accounts_struct.event_authority, accounts_struct.self_program, &event_data)?;

    Ok(())
}

/// Validated accounts for the [`Subscribe`](crate::SubscriptionsInstruction::Subscribe) instruction.
pub struct SubscribeAccounts<'a> {
    pub subscriber: &'a AccountView,
    pub merchant: &'a AccountView,
    pub plan_pda: &'a AccountView,
    pub subscription_pda: &'a mut AccountView,
    pub subscription_authority_pda: &'a AccountView,
    pub system_program: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub self_program: &'a AccountView,
    /// The account funding rent. Defaults to `subscriber` if no extra account is provided.
    pub payer: &'a AccountView,
}

impl<'a> TryFrom<&'a mut [AccountView]> for SubscribeAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
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

        let payer = resolve_optional_payer(subscriber, rem)?;

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
