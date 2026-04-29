use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    state::{
        common::{validate_plan_end_ts, PlanStatus},
        plan::Plan,
    },
    AccountCheck, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
};

/// Instruction data payload for updating a plan's mutable fields.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct UpdatePlanData {
    /// New plan status (see [`PlanStatus`]). Setting to
    /// `Sunset` prevents new subscriptions and requires a non-zero `end_ts`.
    pub status: u8,
    /// New end timestamp. `0` means no end (only valid for active plans).
    pub end_ts: i64,
    /// Updated puller whitelist.
    pub pullers: [Address; 4],
    /// Updated metadata URI.
    #[codama(type = fixed_size(string(utf8), 128))]
    pub metadata_uri: [u8; 128],
}

impl UpdatePlanData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<Self>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }

    /// Validates update data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        PlanStatus::try_from(self.status).map_err(|_| SubscriptionsError::InvalidPlanStatus)?;
        if self.end_ts != 0 && self.end_ts <= current_time {
            return Err(SubscriptionsError::InvalidEndTs);
        }
        Ok(())
    }
}

/// Validated accounts for the [`UpdatePlan`](crate::SubscriptionsInstruction::UpdatePlan) instruction.
pub struct UpdatePlanAccounts<'a> {
    pub owner: &'a AccountView,
    pub plan_pda: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for UpdatePlanAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [owner, plan_pda] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(owner)?;
        WritableAccount::check(plan_pda)?;
        ProgramAccount::check(plan_pda)?;

        Ok(Self { owner, plan_pda })
    }
}

/// Instruction discriminator byte for `UpdatePlan`.
pub const DISCRIMINATOR: &u8 = &8;

/// Updates the mutable fields of an existing [`Plan`].
///
/// Only the plan owner may call this. Plans in `Sunset` status are immutable.
pub fn process(accounts: &[AccountView], data: &UpdatePlanData) -> ProgramResult {
    let accounts = UpdatePlanAccounts::try_from(accounts)?;
    let account_data = &mut accounts.plan_pda.try_borrow_mut()?;
    let plan = Plan::load_mut(account_data)?;

    if &plan.owner != accounts.owner.address() {
        return Err(SubscriptionsError::NotPlanOwner.into());
    }

    if plan.status == PlanStatus::Sunset as u8 {
        return Err(SubscriptionsError::PlanImmutableAfterSunset.into());
    }

    if data.status == PlanStatus::Sunset as u8 && data.end_ts == 0 {
        return Err(SubscriptionsError::SunsetRequiresEndTs.into());
    }

    let current_ts = Clock::get()?.unix_timestamp;
    data.validate(current_ts)?;
    validate_plan_end_ts(data.end_ts, plan.data.terms.period_hours, current_ts)?;

    if plan.data.end_ts != 0 && current_ts > plan.data.end_ts {
        return Err(SubscriptionsError::PlanExpired.into());
    }

    plan.status = data.status;
    plan.data.end_ts = data.end_ts;
    plan.data.pullers = data.pullers;
    plan.data.metadata_uri = data.metadata_uri;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::vec::Vec;

    use solana_pubkey::Pubkey;
    use solana_signer::Signer;

    use crate::{
        state::common::PlanStatus,
        state::plan::Plan,
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            utils::{
                current_ts, days, init_mint, move_clock_forward, setup, CreatePlan, UpdatePlan,
            },
        },
    };

    #[test]
    fn update_plan_happy_path() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000_000)
            .period_hours(720)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(current_ts() + days(60) as i64)
            .metadata_uri("https://example.com/updated.json")
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let status = plan.status;
        let ets = plan.data.end_ts;
        let uri_bytes = plan.data.metadata_uri;
        assert_eq!(status, PlanStatus::Sunset as u8);
        assert_ne!(ets, 0);
        let uri = core::str::from_utf8(&uri_bytes).unwrap();
        assert!(uri.starts_with("https://example.com/updated.json"));
    }

    #[test]
    fn update_plan_preserves_immutable_fields() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();
        let puller = Pubkey::new_unique();

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000_000)
            .period_hours(720)
            .destinations(vec![dest])
            .pullers(vec![puller])
            .metadata_uri("https://example.com/plan.json")
            .execute();
        res.assert_ok();

        let account_before = litesvm.get_account(&plan_pda).unwrap();
        let plan_before = Plan::load(&account_before.data).unwrap();
        let amount_before = plan_before.data.terms.amount;
        let period_before = plan_before.data.terms.period_hours;
        let mint_before = plan_before.data.mint;
        let dests_before = plan_before.data.destinations;
        let id_before = plan_before.data.plan_id;

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(current_ts() + days(60) as i64)
            .pullers(vec![puller])
            .metadata_uri("https://example.com/v2.json")
            .execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&plan_pda).unwrap();
        let plan_after = Plan::load(&account_after.data).unwrap();
        let amount_after = plan_after.data.terms.amount;
        let period_after = plan_after.data.terms.period_hours;
        let mint_after = plan_after.data.mint;
        let dests_after = plan_after.data.destinations;
        let id_after = plan_after.data.plan_id;
        assert_eq!(amount_after, amount_before);
        assert_eq!(period_after, period_before);
        assert_eq!(mint_after.to_bytes(), mint_before.to_bytes());
        for i in 0..4 {
            assert_eq!(dests_after[i].to_bytes(), dests_before[i].to_bytes());
        }
        assert_eq!(id_after, id_before);
    }

    #[test]
    fn update_plan_not_owner() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let non_owner = crate::tests::utils::init_wallet(litesvm, 1_000_000_000);
        let res = UpdatePlan::new(litesvm, &non_owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(current_ts() + days(60) as i64)
            .execute();
        res.assert_err(crate::SubscriptionsError::NotPlanOwner);
    }

    #[test]
    fn update_plan_invalid_status() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status_raw(99)
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidPlanStatus);
    }

    #[test]
    fn update_plan_end_ts_in_past() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .end_ts(1000)
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidEndTs);
    }

    #[test]
    fn update_plan_clear_end_ts() {
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
            .end_ts(0)
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let ets = plan.data.end_ts;
        assert_eq!(ets, 0);
    }

    #[test]
    fn update_plan_sunset_is_terminal() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .end_ts(current_ts() + days(60) as i64)
            .execute();
        res.assert_ok();
        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        assert_eq!(plan.status, PlanStatus::Sunset as u8);

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Active)
            .execute();
        res.assert_err(crate::SubscriptionsError::PlanImmutableAfterSunset);
    }

    #[test]
    fn update_plan_no_op() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let account_before = litesvm.get_account(&plan_pda).unwrap();

        let res = UpdatePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&plan_pda).unwrap();
        assert_eq!(account_before.data, account_after.data);
    }

    #[test]
    fn update_plan_sunset_requires_end_ts() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .status(PlanStatus::Sunset)
            .execute();
        res.assert_err(crate::SubscriptionsError::SunsetRequiresEndTs);
    }

    #[test]
    fn update_plan_at_exact_expiry_boundary() {
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

        move_clock_forward(litesvm, days(2));

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .metadata_uri("https://example.com/at-boundary.json")
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let uri = core::str::from_utf8(&plan.data.metadata_uri).unwrap();
        assert!(uri.starts_with("https://example.com/at-boundary.json"));
    }

    #[test]
    fn update_plan_expired() {
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

        let new_end = current_ts() + days(30) as i64;
        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .end_ts(new_end)
            .execute();
        res.assert_err(crate::SubscriptionsError::PlanExpired);
    }

    #[test]
    fn update_plan_add_pullers() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let zero = [0u8; 32];
        for p in &plan.data.pullers {
            assert_eq!(p.to_bytes(), zero);
        }

        let puller_a = Pubkey::new_unique();
        let puller_b = Pubkey::new_unique();
        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .pullers(vec![puller_a, puller_b])
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        assert_eq!(plan.data.pullers[0].to_bytes(), puller_a.to_bytes());
        assert_eq!(plan.data.pullers[1].to_bytes(), puller_b.to_bytes());
        assert_eq!(plan.data.pullers[2].to_bytes(), zero);
        assert_eq!(plan.data.pullers[3].to_bytes(), zero);
    }

    #[test]
    fn update_plan_remove_pullers_owner_still_authorized() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let puller_a = Pubkey::new_unique();
        let puller_b = Pubkey::new_unique();
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .pullers(vec![puller_a, puller_b])
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda).execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let zero = [0u8; 32];
        for p in &plan.data.pullers {
            assert_eq!(p.to_bytes(), zero);
        }

        let owner_addr: pinocchio::Address = owner.pubkey().to_bytes().into();
        assert!(plan.can_pull(&owner_addr).is_ok());

        let random_addr: pinocchio::Address = Pubkey::new_unique().to_bytes().into();
        assert!(plan.can_pull(&random_addr).is_err());
    }

    #[test]
    fn update_plan_replace_pullers() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let puller_a = Pubkey::new_unique();
        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .pullers(vec![puller_a])
            .execute();
        res.assert_ok();

        let puller_b = Pubkey::new_unique();
        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .pullers(vec![puller_b])
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        assert_eq!(plan.data.pullers[0].to_bytes(), puller_b.to_bytes());
        let zero = [0u8; 32];
        assert_eq!(plan.data.pullers[1].to_bytes(), zero);
    }

    #[test]
    fn update_plan_max_pullers() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let pullers: Vec<Pubkey> = (0..4).map(|_| Pubkey::new_unique()).collect();
        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .pullers(pullers.clone())
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        for (i, p) in pullers.iter().enumerate() {
            assert_eq!(plan.data.pullers[i].to_bytes(), p.to_bytes());
        }
    }

    #[test]
    fn update_plan_rejects_near_immediate_end_ts() {
        let (litesvm, owner) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, owner, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(720)
            .execute();
        res.assert_ok();

        let res = UpdatePlan::new(litesvm, owner, plan_pda)
            .end_ts(current_ts() + 2)
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidEndTs);
    }
}
