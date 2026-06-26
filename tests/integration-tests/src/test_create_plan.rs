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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);

    let (res, plan_pda) = CreatePlan::new(litesvm, merchant, mint).plan_id(1).amount(1_000).period_hours(24).execute();
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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

    let clean_mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
        terms: PlanTerms { amount: 1_000, period_hours: 24, created_at: 0 },
        end_ts: 0,
        destinations,
        pullers: [zero_addr; MAX_PULLERS],
        metadata_uri: [0u8; 128],
    };

    let plan_data_bytes =
        unsafe { std::slice::from_raw_parts(&plan_data as *const PlanData as *const u8, PlanData::LEN) };
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
fn create_plan_rejects_uninitialized_mint() {
    let (litesvm, merchant) = &mut setup();

    let fake_mint = Pubkey::new_unique();
    litesvm
        .set_account(
            fake_mint,
            Account {
                lamports: 1_000_000_000,
                data: vec![0u8; 82],
                owner: TOKEN_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let (res, _) = CreatePlan::new(litesvm, merchant, fake_mint)
        .plan_id(7)
        .amount(1_000_000)
        .period_hours(720)
        .destinations(vec![Pubkey::new_unique()])
        .execute();
    res.assert_err(crate::SubscriptionsError::InvalidTokenSplMintAccountData);
}

#[test]
fn create_plan_prefunded_pda() {
    let (litesvm, merchant) = &mut setup();
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
    let dest = Pubkey::new_unique();
    let plan_id: u64 = 42;

    let (plan_pda_addr, _) = get_plan_pda(&merchant.pubkey(), plan_id);
    litesvm
        .set_account(
            plan_pda_addr,
            Account { lamports: 1_000, data: vec![], owner: Pubkey::default(), executable: false, rent_epoch: 0 },
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
    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, None, &[]);
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
