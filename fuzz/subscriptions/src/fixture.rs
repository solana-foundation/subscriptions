use std::rc::Rc;

use crucible_fuzzer::*;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use subscriptions::accounts::{EventAuthority, Plan, SubscriptionAuthority, SubscriptionDelegation};
use subscriptions::instructions::{
    CancelSubscriptionBuilder, CancelSubscriptionNowBuilder, CloseSubscriptionAuthorityBuilder,
    CreateFixedDelegationBuilder, CreatePlanBuilder, CreateRecurringDelegationBuilder, DeletePlanBuilder,
    InitSubscriptionAuthorityBuilder, ResumeSubscriptionBuilder, RevokeAbandonedDelegationBuilder,
    RevokeDelegationBuilder, RevokeSubscriptionAuthorityBuilder, SubscribeBuilder, TransferFixedBuilder,
    TransferSubscriptionBuilder, UpdatePlanBuilder,
};
use subscriptions::types::{
    CancelSubscriptionNowData, CreateFixedDelegationData, CreateRecurringDelegationData, PlanData, PlanStatus,
    PlanTerms, ResumeData, SubscribeData, TransferData, UpdatePlanData,
};
use subscriptions::SUBSCRIPTIONS_ID;

use crate::constants::{
    GENESIS_TS, INITIAL_TOKENS, MINT_DECIMALS, PLAN_AMOUNT, PLAN_ID, PLAN_PERIOD_HOURS, SUBSCRIBER_COUNT,
};
use crate::helpers::{
    ata_address, create_ata, create_funded_wallet, create_mint, delegation_pda_address, plan_pda_address, set_clock,
    TOKEN_PROGRAM,
};

// Nonces action_create_fixed_delegation draws from; recurring uses a disjoint range.
pub const FIXED_NONCES: [u64; 3] = [0, 1, 2];

#[derive(Clone)]
pub struct SubscriptionsFixture {
    pub ctx: TestContext,
    pub mint: Pubkey,
    pub merchant: Rc<Keypair>,
    pub merchant_ata: Pubkey,
    pub subscribers: Vec<Rc<Keypair>>,
    pub plan_pda: Pubkey,
    pub plan_bump: u8,
    pub now_ts: i64,
    // (ATA balance, authority alive) per subscriber at the last invariant check. Exactly one
    // action runs between checks, so a balance drop observed while the flag was false means
    // tokens moved through a closed authority.
    pub prev_spend_state: Vec<(u64, bool)>,
    // Last observed remaining budget of each fixed delegation (per subscriber, per fixed nonce);
    // None while the delegation account does not exist. transfer_fixed only decrements this budget,
    // so it must never increase while the account stays live.
    pub prev_fixed_amount: Vec<[Option<u64>; FIXED_NONCES.len()]>,
    // (hook program, extra-account-metas PDA, counter) when the mint carries a transfer hook;
    // appended as remaining accounts on transfers so the Token-2022 hook CPI can resolve.
    pub hook_accounts: Option<(Pubkey, Pubkey, Pubkey)>,
}

impl SubscriptionsFixture {
    fn set_time(&mut self, ts: i64) {
        self.now_ts = ts;
        set_clock(&mut self.ctx, ts);
    }

    fn read_plan(&self) -> Option<Plan> {
        let account = self.ctx.get_account(&self.plan_pda).ok()?;
        Plan::from_bytes(&account.data).ok()
    }

    pub fn read_authority(&self, subscriber: &Pubkey) -> Option<SubscriptionAuthority> {
        let (authority_pda, _) = SubscriptionAuthority::find_pda(subscriber, &self.mint);
        let account = self.ctx.get_account(&authority_pda).ok()?;
        SubscriptionAuthority::from_bytes(&account.data).ok()
    }

    pub fn subscription_pda(&self, subscriber: &Pubkey) -> Pubkey {
        SubscriptionDelegation::find_pda(&self.plan_pda, subscriber).0
    }

    fn read_subscription(&self, subscriber: &Pubkey) -> Option<SubscriptionDelegation> {
        let account = self.ctx.get_account(&self.subscription_pda(subscriber)).ok()?;
        SubscriptionDelegation::from_bytes(&account.data).ok()
    }

    pub fn delegation_pda_for(&self, subscriber: &Pubkey, nonce: u64) -> Pubkey {
        let (authority_pda, _) = SubscriptionAuthority::find_pda(subscriber, &self.mint);
        delegation_pda_address(&authority_pda, subscriber, &self.merchant.pubkey(), nonce).0
    }
}

#[fuzz_fixture]
impl SubscriptionsFixture {
    pub fn setup() -> Self {
        let mut ctx = TestContext::new();
        ctx.add_program(&SUBSCRIPTIONS_ID, "../../target/deploy/subscriptions_program.so")
            .expect("load subscriptions program");
        set_clock(&mut ctx, GENESIS_TS);

        let mint_authority = Keypair::new();
        let mint = Pubkey::new_unique();
        create_mint(&mut ctx, &mint, &mint_authority.pubkey(), MINT_DECIMALS);

        #[cfg(feature = "invariant_subscriptions_hook")]
        let hook_accounts = {
            let (validation_pda, counter) = crate::helpers::setup_hook(&mut ctx, &mint);
            Some((crate::helpers::HOOK_PROGRAM, validation_pda, counter))
        };
        #[cfg(not(feature = "invariant_subscriptions_hook"))]
        let hook_accounts = None;

        let merchant = create_funded_wallet(&mut ctx);
        let merchant_ata = create_ata(&mut ctx, &merchant.pubkey(), &mint, 0);

        let mut subscribers = Vec::with_capacity(SUBSCRIBER_COUNT);
        for _ in 0..SUBSCRIBER_COUNT {
            let subscriber = create_funded_wallet(&mut ctx);
            let user_ata = create_ata(&mut ctx, &subscriber.pubkey(), &mint, INITIAL_TOKENS);
            let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &mint);
            let ix = InitSubscriptionAuthorityBuilder::new()
                .owner(subscriber.pubkey())
                .subscription_authority(authority_pda)
                .token_mint(mint)
                .user_ata(user_ata)
                .token_program(TOKEN_PROGRAM)
                .instruction();
            ctx.raw_call(ix).signers(&[&subscriber]).send().expect("send init authority").unwrap();
            subscribers.push(subscriber);
        }

        let (plan_pda, plan_bump) = plan_pda_address(&merchant.pubkey(), PLAN_ID);
        let mut destinations = [Pubkey::default(); 4];
        destinations[0] = merchant.pubkey();
        let mut pullers = [Pubkey::default(); 4];
        pullers[0] = merchant.pubkey();
        let ix = CreatePlanBuilder::new()
            .merchant(merchant.pubkey())
            .plan_pda(plan_pda)
            .token_mint(mint)
            .token_program(TOKEN_PROGRAM)
            .plan_data(PlanData {
                plan_id: PLAN_ID,
                mint,
                terms: PlanTerms { amount: PLAN_AMOUNT, period_hours: PLAN_PERIOD_HOURS, created_at: 0 },
                end_ts: 0,
                destinations,
                pullers,
                metadata_uri: [0u8; 128],
            })
            .instruction();
        ctx.raw_call(ix).signers(&[&merchant]).send().expect("send create plan").unwrap();

        Self {
            ctx,
            mint,
            merchant,
            merchant_ata,
            subscribers,
            plan_pda,
            plan_bump,
            now_ts: GENESIS_TS,
            prev_spend_state: vec![(INITIAL_TOKENS, true); SUBSCRIBER_COUNT],
            prev_fixed_amount: vec![[None; FIXED_NONCES.len()]; SUBSCRIBER_COUNT],
            hook_accounts,
        }
    }

    fn append_hook_accounts(&self, ix: &mut solana_instruction::Instruction) {
        if let Some((program, validation, counter)) = self.hook_accounts {
            ix.accounts.push(solana_instruction::AccountMeta::new_readonly(program, false));
            ix.accounts.push(solana_instruction::AccountMeta::new_readonly(validation, false));
            ix.accounts.push(solana_instruction::AccountMeta::new(counter, false));
        }
    }

    pub fn action_advance_time(&mut self, #[range(1..73)] hours: i64) {
        self.set_time(self.now_ts + hours * 3600);
    }

    // Create plans with fuzzed shapes to reach the CreatePlan validation branches that the single
    // fixed setup plan never touches: zero amount, out-of-range periods, end_ts bounds, and
    // varied destination/puller counts. plan_id 1 collides with the setup plan (already-exists
    // path); 2..5 are fresh.
    pub fn action_create_plan(
        &mut self,
        #[range(1..5)] plan_id: u64,
        #[range(0..2_000_001)] amount: u64,
        #[range(0..8762)] period_hours: u64,
        #[range(0..5)] destination_count: usize,
        #[range(0..5)] puller_count: usize,
        #[range(0..100)] end_hours: i64,
    ) -> bool {
        let candidates = [
            self.merchant.pubkey(),
            self.subscribers[0].pubkey(),
            self.subscribers[1].pubkey(),
            self.subscribers[2].pubkey(),
        ];
        let mut destinations = [Pubkey::default(); 4];
        let mut pullers = [Pubkey::default(); 4];
        for (i, slot) in destinations.iter_mut().enumerate().take(destination_count) {
            *slot = candidates[i];
        }
        for (i, slot) in pullers.iter_mut().enumerate().take(puller_count) {
            *slot = candidates[i];
        }
        let (plan_pda, _) = plan_pda_address(&self.merchant.pubkey(), plan_id);
        let ix = CreatePlanBuilder::new()
            .merchant(self.merchant.pubkey())
            .plan_pda(plan_pda)
            .token_mint(self.mint)
            .token_program(TOKEN_PROGRAM)
            .plan_data(PlanData {
                plan_id,
                mint: self.mint,
                terms: PlanTerms { amount, period_hours, created_at: 0 },
                end_ts: if end_hours == 0 { 0 } else { self.now_ts + end_hours * 3600 },
                destinations,
                pullers,
                metadata_uri: [0u8; 128],
            })
            .instruction();
        self.ctx.raw_call(ix).signers(&[&self.merchant.clone()]).send().map(|o| o.is_success()).unwrap_or(false)
    }

    fn current_subscribe_data(&self, subscriber: &Pubkey) -> Option<SubscribeData> {
        let plan = self.read_plan()?;
        let authority = self.read_authority(subscriber)?;
        Some(SubscribeData {
            plan_id: PLAN_ID,
            plan_bump: self.plan_bump,
            expected_mint: plan.data.mint,
            expected_amount: plan.data.terms.amount,
            expected_period_hours: plan.data.terms.period_hours,
            expected_created_at: plan.data.terms.created_at,
            expected_subscription_authority_init_id: authority.init_id,
        })
    }

    fn send_subscribe(&mut self, subscriber: &Rc<Keypair>, data: SubscribeData) -> bool {
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = SubscribeBuilder::new()
            .subscriber(subscriber.pubkey())
            .merchant(self.merchant.pubkey())
            .plan_pda(self.plan_pda)
            .subscription_pda(self.subscription_pda(&subscriber.pubkey()))
            .subscription_authority_pda(authority_pda)
            .event_authority(EventAuthority::find_pda().0)
            .subscribe_data(data)
            .instruction();
        self.ctx.raw_call(ix).signers(&[subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_subscribe(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(data) = self.current_subscribe_data(&subscriber.pubkey()) else { return false };
        self.send_subscribe(&subscriber, data)
    }

    // Subscribe with one expected_* field deliberately wrong, forcing a compare-and-swap
    // mismatch. The program's guards must reject every variant (StaleSubscriptionAuthority for a
    // wrong init_id, PlanTermsMismatch for wrong terms); the shared invariants confirm a rejected
    // attempt leaves no partial state behind.
    pub fn action_subscribe_wrong_approval(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..5)] field: usize,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(mut data) = self.current_subscribe_data(&subscriber.pubkey()) else { return false };
        match field {
            0 => data.expected_amount = data.expected_amount.wrapping_add(1),
            1 => data.expected_period_hours = data.expected_period_hours.wrapping_add(1),
            2 => data.expected_created_at = data.expected_created_at.wrapping_add(1),
            3 => {
                data.expected_subscription_authority_init_id =
                    data.expected_subscription_authority_init_id.wrapping_add(1)
            }
            _ => data.expected_mint = self.plan_pda,
        }
        self.send_subscribe(&subscriber, data)
    }

    pub fn action_pull_payment(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..2_000_001)] amount: u64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        if !self.ctx.account_has_data(&self.subscription_pda(&subscriber.pubkey()), 1) {
            return false;
        }
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = TransferSubscriptionBuilder::new()
            .subscription_pda(self.subscription_pda(&subscriber.pubkey()))
            .plan_pda(self.plan_pda)
            .subscription_authority(authority_pda)
            .delegator_ata(ata_address(&subscriber.pubkey(), &self.mint))
            .receiver_ata(self.merchant_ata)
            .caller(self.merchant.pubkey())
            .token_mint(self.mint)
            .token_program(TOKEN_PROGRAM)
            .event_authority(EventAuthority::find_pda().0)
            .transfer_data(TransferData { amount, delegator: subscriber.pubkey(), mint: self.mint })
            .instruction();
        let mut ix = ix;
        self.append_hook_accounts(&mut ix);
        self.ctx
            .raw_call(ix)
            .signers(&[&self.merchant.clone()])
            .send()
            .map(|outcome| outcome.is_success())
            .unwrap_or(false)
    }

    pub fn action_cancel_subscription(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let ix = CancelSubscriptionBuilder::new()
            .subscriber(subscriber.pubkey())
            .plan_pda(self.plan_pda)
            .subscription_pda(self.subscription_pda(&subscriber.pubkey()))
            .event_authority(EventAuthority::find_pda().0)
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_resume_subscription(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(subscription) = self.read_subscription(&subscriber.pubkey()) else { return false };
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = ResumeSubscriptionBuilder::new()
            .subscriber(subscriber.pubkey())
            .plan_pda(self.plan_pda)
            .subscription_pda(self.subscription_pda(&subscriber.pubkey()))
            .subscription_authority(authority_pda)
            .event_authority(EventAuthority::find_pda().0)
            .resume_data(ResumeData { expected_expires_at_ts: subscription.expires_at_ts })
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_cancel_subscription_now(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(subscription) = self.read_subscription(&subscriber.pubkey()) else { return false };
        let ix = CancelSubscriptionNowBuilder::new()
            .subscriber(subscriber.pubkey())
            .merchant(self.merchant.pubkey())
            .plan_pda(self.plan_pda)
            .subscription_pda(self.subscription_pda(&subscriber.pubkey()))
            .event_authority(EventAuthority::find_pda().0)
            .cancel_subscription_now_data(CancelSubscriptionNowData {
                expected_current_period_start_ts: subscription.current_period_start_ts,
            })
            .instruction();
        self.ctx
            .raw_call(ix)
            .signers(&[&subscriber, &self.merchant.clone()])
            .send()
            .map(|outcome| outcome.is_success())
            .unwrap_or(false)
    }

    pub fn action_create_fixed_delegation(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..3)] nonce: u64,
        #[range(0..2_000_001)] amount: u64,
        #[range(1..73)] expiry_hours: i64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(authority) = self.read_authority(&subscriber.pubkey()) else { return false };
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let delegatee = self.merchant.pubkey();
        let (delegation, _) = delegation_pda_address(&authority_pda, &subscriber.pubkey(), &delegatee, nonce);
        let ix = CreateFixedDelegationBuilder::new()
            .delegator(subscriber.pubkey())
            .subscription_authority(authority_pda)
            .delegation_account(delegation)
            .delegatee(delegatee)
            .fixed_delegation(CreateFixedDelegationData {
                nonce,
                amount,
                expiry_ts: self.now_ts + expiry_hours * 3600,
                expected_subscription_authority_init_id: authority.init_id,
            })
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_create_recurring_delegation(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(3..6)] nonce: u64,
        #[range(0..2_000_001)] amount_per_period: u64,
        #[range(1..73)] period_hours: u64,
        #[range(1..73)] expiry_hours: i64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let Some(authority) = self.read_authority(&subscriber.pubkey()) else { return false };
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let delegatee = self.merchant.pubkey();
        let (delegation, _) = delegation_pda_address(&authority_pda, &subscriber.pubkey(), &delegatee, nonce);
        let ix = CreateRecurringDelegationBuilder::new()
            .delegator(subscriber.pubkey())
            .subscription_authority(authority_pda)
            .delegation_account(delegation)
            .delegatee(delegatee)
            .recurring_delegation(CreateRecurringDelegationData {
                nonce,
                amount_per_period,
                period_length_s: period_hours * 3600,
                start_ts: self.now_ts,
                expiry_ts: self.now_ts + expiry_hours * 3600,
                expected_subscription_authority_init_id: authority.init_id,
            })
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_transfer_fixed(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..3)] nonce: u64,
        #[range(0..2_000_001)] amount: u64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let delegatee = self.merchant.pubkey();
        let (delegation, _) = delegation_pda_address(&authority_pda, &subscriber.pubkey(), &delegatee, nonce);
        if !self.ctx.account_has_data(&delegation, 1) {
            return false;
        }
        let ix = TransferFixedBuilder::new()
            .delegation_pda(delegation)
            .subscription_authority(authority_pda)
            .delegator_ata(ata_address(&subscriber.pubkey(), &self.mint))
            .receiver_ata(self.merchant_ata)
            .token_mint(self.mint)
            .token_program(TOKEN_PROGRAM)
            .delegatee(delegatee)
            .event_authority(EventAuthority::find_pda().0)
            .transfer_data(TransferData { amount, delegator: subscriber.pubkey(), mint: self.mint })
            .instruction();
        let mut ix = ix;
        self.append_hook_accounts(&mut ix);
        self.ctx
            .raw_call(ix)
            .signers(&[&self.merchant.clone()])
            .send()
            .map(|outcome| outcome.is_success())
            .unwrap_or(false)
    }

    pub fn action_revoke_delegation(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..6)] nonce: u64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let delegatee = self.merchant.pubkey();
        let (delegation, _) = delegation_pda_address(&authority_pda, &subscriber.pubkey(), &delegatee, nonce);
        let ix =
            RevokeDelegationBuilder::new().authority(subscriber.pubkey()).delegation_account(delegation).instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_revoke_abandoned_delegation(
        &mut self,
        #[range(0..3)] subscriber_idx: usize,
        #[range(0..6)] nonce: u64,
    ) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let delegatee = self.merchant.pubkey();
        let (delegation, _) = delegation_pda_address(&authority_pda, &subscriber.pubkey(), &delegatee, nonce);
        let ix = RevokeAbandonedDelegationBuilder::new()
            .payer(subscriber.pubkey())
            .delegation_account(delegation)
            .subscription_authority(authority_pda)
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_update_plan(&mut self, #[range(0..2)] status: u8, #[range(0..73)] end_hours: i64) -> bool {
        let Some(plan) = self.read_plan() else { return false };
        let status = if status == 0 { PlanStatus::Sunset } else { PlanStatus::Active };
        let ix = UpdatePlanBuilder::new()
            .owner(self.merchant.pubkey())
            .plan_pda(self.plan_pda)
            .event_authority(EventAuthority::find_pda().0)
            .update_plan_data(UpdatePlanData {
                status: status as u8,
                end_ts: if end_hours == 0 { 0 } else { self.now_ts + end_hours * 3600 },
                pullers: [self.merchant.pubkey(), Pubkey::default(), Pubkey::default(), Pubkey::default()],
                metadata_uri: [0u8; 128],
                expected_created_at: plan.data.terms.created_at,
                expected_end_ts: plan.data.end_ts,
                expected_pullers: plan.data.pullers,
                expected_metadata_uri: plan.data.metadata_uri,
            })
            .instruction();
        self.ctx
            .raw_call(ix)
            .signers(&[&self.merchant.clone()])
            .send()
            .map(|outcome| outcome.is_success())
            .unwrap_or(false)
    }

    pub fn action_delete_plan(&mut self) -> bool {
        let ix = DeletePlanBuilder::new().owner(self.merchant.pubkey()).plan_pda(self.plan_pda).instruction();
        self.ctx
            .raw_call(ix)
            .signers(&[&self.merchant.clone()])
            .send()
            .map(|outcome| outcome.is_success())
            .unwrap_or(false)
    }

    pub fn action_revoke_subscription_authority(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = RevokeSubscriptionAuthorityBuilder::new()
            .user(subscriber.pubkey())
            .user_ata(ata_address(&subscriber.pubkey(), &self.mint))
            .token_mint(self.mint)
            .token_program(TOKEN_PROGRAM)
            .subscription_authority(authority_pda)
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_close_subscription_authority(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = CloseSubscriptionAuthorityBuilder::new()
            .user(subscriber.pubkey())
            .subscription_authority(authority_pda)
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }

    pub fn action_reinit_authority(&mut self, #[range(0..3)] subscriber_idx: usize) -> bool {
        let subscriber = self.subscribers[subscriber_idx].clone();
        let (authority_pda, _) = SubscriptionAuthority::find_pda(&subscriber.pubkey(), &self.mint);
        let ix = InitSubscriptionAuthorityBuilder::new()
            .owner(subscriber.pubkey())
            .subscription_authority(authority_pda)
            .token_mint(self.mint)
            .user_ata(ata_address(&subscriber.pubkey(), &self.mint))
            .token_program(TOKEN_PROGRAM)
            .instruction();
        self.ctx.raw_call(ix).signers(&[&subscriber]).send().map(|outcome| outcome.is_success()).unwrap_or(false)
    }
}
