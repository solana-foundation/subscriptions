use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    create_plan_account,
    state::{
        common::{validate_plan_end_ts, AccountDiscriminator, PlanStatus},
        plan::{self, Plan},
    },
    CreatePlanAccounts, SubscriptionsError,
};

/// Maximum allowed period length for plans (365 days in hours).
pub const MAX_PLAN_PERIOD_HOURS: u64 = 8760;

/// Maximum number of destination wallets a plan can whitelist.
pub const MAX_DESTINATIONS: usize = 4;

/// Maximum number of puller addresses a plan can authorize.
pub const MAX_PULLERS: usize = 4;

/// Immutable billing terms snapshotted into each [`SubscriptionDelegation`] at subscribe time.
#[repr(C, packed)]
#[derive(Debug, Clone, Copy, CodamaType)]
pub struct PlanTerms {
    /// Maximum token amount that can be pulled per billing period.
    pub amount: u64,
    /// Billing period length in hours (must be > 0 and <= [`MAX_PLAN_PERIOD_HOURS`]).
    pub period_hours: u64,
    /// Unix timestamp when the plan was created on-chain. Set by the program at plan creation time.
    pub created_at: i64,
}

/// Configuration data embedded in a [`Plan`] account and supplied when creating one.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct PlanData {
    /// Merchant-chosen identifier for the plan (unique per owner).
    pub plan_id: u64,
    /// SPL token mint that subscriptions under this plan operate on.
    pub mint: Address,
    /// Immutable plan terms
    pub terms: PlanTerms,
    /// Optional unix timestamp after which the plan expires. `0` means no end.
    pub end_ts: i64,
    /// Whitelisted destination wallets for transfers. All-zero entries are ignored.
    pub destinations: [Address; 4],
    /// Addresses authorized to pull subscription transfers (in addition to the owner).
    pub pullers: [Address; 4],
    /// UTF-8 metadata URI (e.g., pointing to off-chain plan details). Padded with zeros.
    #[codama(type = fixed_size(string(utf8), 128))]
    pub metadata_uri: [u8; 128],
}

impl PlanData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<PlanData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }

    /// Validates plan data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.terms.amount == 0 {
            return Err(SubscriptionsError::InvalidAmount);
        }
        if self.terms.period_hours == 0 || self.terms.period_hours > MAX_PLAN_PERIOD_HOURS {
            return Err(SubscriptionsError::InvalidPeriodLength);
        }

        // Destinations are not validated here; empty destinations means any destination is valid at transfer time.
        // Pullers are not validated here; empty pullers defaults to owner-only authorization in transfer.
        validate_plan_end_ts(self.end_ts, self.terms.period_hours, current_time)?;

        Ok(())
    }
}

/// Instruction discriminator byte for `CreatePlan`.
pub const DISCRIMINATOR: &u8 = &7;

/// Creates a new subscription [`Plan`] PDA.
///
/// Validates the plan data, creates the plan account via CPI, and initializes
/// its fields including owner, status, and the embedded [`PlanData`].
pub fn process(accounts: &[AccountView], data: &PlanData) -> ProgramResult {
    let current_ts = Clock::get()?.unix_timestamp;
    data.validate(current_ts)?;

    let accounts = CreatePlanAccounts::try_from(accounts)?;

    if accounts.token_mint.address() != &data.mint {
        return Err(SubscriptionsError::MintMismatch.into());
    }

    let bump = create_plan_account(&accounts, data.plan_id)?;

    let account_data = &mut accounts.plan_pda.try_borrow_mut()?;
    account_data[plan::PLAN_DISCRIMINATOR_OFFSET] = AccountDiscriminator::Plan as u8;
    let plan = Plan::load_mut(account_data)?;

    plan.owner = *accounts.merchant.address();
    plan.bump = bump;
    plan.status = PlanStatus::Active as u8;
    unsafe {
        core::ptr::copy_nonoverlapping(
            data as *const PlanData as *const u8,
            core::ptr::addr_of_mut!(plan.data) as *mut u8,
            PlanData::LEN,
        );
    }
    plan.data.terms.created_at = current_ts;

    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_account::Account;
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;

    use crate::{
        state::common::PlanStatus,
        state::plan::Plan,
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            pda::get_plan_pda,
            utils::{current_ts, days, init_mint, setup, CreatePlan},
        },
    };

    #[test]
    fn create_plan_happy_path() {
        let (litesvm, merchant) = &mut setup();
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
        let end_ts = current_ts() + days(30) as i64;

        let (res, plan_pda) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000_000)
            .period_hours(720)
            .end_ts(end_ts)
            .destinations(vec![dest])
            .pullers(vec![puller])
            .metadata_uri("https://example.com/plan.json")
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        assert_eq!(account.data.len(), Plan::LEN);
        let plan = Plan::load(&account.data).unwrap();

        let owner = plan.owner;
        let status = plan.status;
        let id = plan.data.plan_id;
        let plan_mint = plan.data.mint;
        let amt = plan.data.terms.amount;
        let ph = plan.data.terms.period_hours;
        let ets = plan.data.end_ts;
        let dests = plan.data.destinations;
        let pulls = plan.data.pullers;
        let bump = plan.bump;

        assert_eq!(owner.to_bytes(), merchant.pubkey().to_bytes());
        assert_eq!(status, PlanStatus::Active as u8);
        assert_eq!(id, 1);
        assert_eq!(plan_mint.to_bytes(), mint.to_bytes());
        assert_eq!(amt, 1_000_000);
        assert_eq!(ph, 720);
        assert_eq!(ets, end_ts);
        assert_eq!(dests[0].to_bytes(), dest.to_bytes());
        assert_eq!(pulls[0].to_bytes(), puller.to_bytes());
        assert_ne!(bump, 0);
    }

    #[test]
    fn create_plan_no_expiry() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, plan_pda) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(500_000)
            .period_hours(24)
            .end_ts(0)
            .destinations(vec![dest])
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let ets = plan.data.end_ts;
        assert_eq!(ets, 0);
    }

    #[test]
    fn create_plan_period_hours_zero() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(0)
            .destinations(vec![dest])
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidPeriodLength);
    }

    #[test]
    fn create_plan_period_hours_exceeds_max() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(8761)
            .destinations(vec![dest])
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidPeriodLength);
    }

    #[test]
    fn create_plan_amount_zero() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(0)
            .period_hours(24)
            .destinations(vec![dest])
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidAmount);
    }

    #[test]
    fn create_plan_no_destinations() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );

        let (res, plan_pda) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let zero = [0u8; 32];
        for dest in &plan.data.destinations {
            assert_eq!(dest.to_bytes(), zero);
        }
    }

    #[test]
    fn create_plan_expired_end_ts() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .end_ts(1_000)
            .destinations(vec![dest])
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidEndTs);
    }

    #[test]
    fn create_plan_end_ts_before_first_period() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();
        let end_ts = current_ts() + days(1) as i64;

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(720)
            .end_ts(end_ts)
            .destinations(vec![dest])
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidEndTs);
    }

    #[test]
    fn create_plan_wrong_pda() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();
        let wrong_pda = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .destinations(vec![dest])
            .pda(wrong_pda)
            .execute();
        res.assert_err(crate::SubscriptionsError::InvalidPlanPda);
    }

    #[test]
    fn create_plan_mint_mismatch_attack() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::create_plan::{PlanData, PlanTerms, MAX_DESTINATIONS, MAX_PULLERS},
            tests::{
                constants::{PROGRAM_ID, SYSTEM_PROGRAM_ID},
                pda::get_plan_pda,
                utils::build_and_send_transaction,
            },
        };

        let (litesvm, merchant) = &mut setup();

        let clean_mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let malicious_mint = Pubkey::new_unique();
        let dest = Pubkey::new_unique();

        let plan_id: u64 = 1;
        let (plan_pda, _) = get_plan_pda(&merchant.pubkey(), plan_id);

        let zero_addr: pinocchio::Address = [0u8; 32].into();
        let mut destinations = [zero_addr; MAX_DESTINATIONS];
        destinations[0] = dest.to_bytes().into();

        let plan_data = PlanData {
            plan_id,
            mint: malicious_mint.to_bytes().into(),
            terms: PlanTerms {
                amount: 1_000,
                period_hours: 24,
                created_at: 0,
            },
            end_ts: 0,
            destinations,
            pullers: [zero_addr; MAX_PULLERS],
            metadata_uri: [0u8; 128],
        };

        let plan_data_bytes = unsafe {
            std::slice::from_raw_parts(&plan_data as *const PlanData as *const u8, PlanData::LEN)
        };
        let mut data = vec![7u8];
        data.extend_from_slice(plan_data_bytes);

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(merchant.pubkey(), true),
                AccountMeta::new(plan_pda, false),
                AccountMeta::new_readonly(clean_mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
            data,
        };

        let res = build_and_send_transaction(litesvm, &[merchant], &merchant.pubkey(), &ix);
        res.assert_err(crate::SubscriptionsError::MintMismatch);
    }

    #[test]
    fn create_plan_prefunded_pda() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();
        let plan_id: u64 = 42;

        let (plan_pda_addr, _) = get_plan_pda(&merchant.pubkey(), plan_id);
        litesvm
            .set_account(
                plan_pda_addr,
                Account {
                    lamports: 1_000,
                    data: vec![],
                    owner: Pubkey::default(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        let (res, plan_pda) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(plan_id)
            .amount(1_000_000)
            .period_hours(720)
            .destinations(vec![dest])
            .execute();
        res.assert_ok();

        let account = litesvm.get_account(&plan_pda).unwrap();
        let plan = Plan::load(&account.data).unwrap();
        let owner = plan.owner;
        let status = plan.status;
        assert_eq!(owner.to_bytes(), merchant.pubkey().to_bytes());
        assert_eq!(status, PlanStatus::Active as u8);
    }

    #[test]
    fn create_plan_duplicate_plan_id() {
        let (litesvm, merchant) = &mut setup();
        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            None,
            &[],
        );
        let dest = Pubkey::new_unique();

        let (res, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(1_000)
            .period_hours(24)
            .destinations(vec![dest])
            .execute();
        res.assert_ok();

        let (res2, _) = CreatePlan::new(litesvm, merchant, mint)
            .plan_id(1)
            .amount(2_000)
            .period_hours(48)
            .destinations(vec![dest])
            .execute();
        res2.assert_err(crate::SubscriptionsError::PlanAlreadyExists);
    }
}
