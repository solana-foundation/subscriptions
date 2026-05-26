use std::time::{SystemTime, UNIX_EPOCH};
use std::vec::Vec;

use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_program_pack::{IsInitialized, Pack};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferMint,
        immutable_owner::ImmutableOwner,
        mint_close_authority::MintCloseAuthority,
        non_transferable::{NonTransferable, NonTransferableAccount},
        pausable::{PausableAccount, PausableConfig},
        permanent_delegate::PermanentDelegate,
        transfer_fee::{TransferFeeAmount, TransferFeeConfig},
        transfer_hook::{TransferHook, TransferHookAccount},
        BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType, StateWithExtensions,
        StateWithExtensionsMut,
    },
    state::{Account as TokenAccount, AccountState, Mint as Mint2022},
};

use solana_instruction::AccountMeta;

use crate::{
    event_engine::event_authority_pda,
    instructions::create_plan::{PlanData, PlanTerms, MAX_DESTINATIONS, MAX_PULLERS},
    instructions::update_plan::UpdatePlanData,
    instructions::{
        cancel_subscription, close_subscription_authority, create_fixed_delegation, create_plan,
        create_recurring_delegation, delete_plan, initialize_subscription_authority, resume_subscription,
        revoke_delegation, subscribe, transfer_fixed_delegation, transfer_recurring_delegation, transfer_subscription,
        update_plan,
    },
    state::common::PlanStatus,
    tests::{
        constants::{PROGRAM_ID, SYSTEM_PROGRAM_ID},
        cu_tracker::record_transaction,
        pda::{get_delegation_pda, get_plan_pda, get_subscription_authority_pda, get_subscription_pda},
    },
};

/// Converts number of minutes into seconds
pub fn minutes(mins: u64) -> u64 {
    mins * 60
}

/// Converts number of hours into seconds
pub fn hours(hours: u64) -> u64 {
    hours * minutes(60)
}

/// Converts number of days into seconds
pub fn days(days: u64) -> u64 {
    days * hours(24)
}

pub fn current_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

pub fn move_clock_forward(litesvm: &mut LiteSVM, seconds: u64) {
    let mut initial_clock = litesvm.get_sysvar::<Clock>();
    initial_clock.unix_timestamp += seconds as i64;
    initial_clock.slot += seconds * 2;
    litesvm.set_sysvar::<Clock>(&initial_clock);
}

pub fn get_ata_balance(litesvm: &LiteSVM, ata: &Pubkey) -> u64 {
    let account = fetch_account::<spl_token_2022_interface::state::Account>(litesvm, ata);
    account.amount
}

pub fn setup() -> (LiteSVM, Keypair) {
    let mut litesvm = LiteSVM::new();

    let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/subscriptions_program.so");
    litesvm.add_program_from_file(PROGRAM_ID.to_bytes(), so_path).unwrap();

    let mut initial_clock = litesvm.get_sysvar::<Clock>();
    initial_clock.unix_timestamp = current_ts();
    litesvm.set_sysvar::<Clock>(&initial_clock);

    let default_payer = Keypair::new();
    litesvm.airdrop(&default_payer.pubkey(), LAMPORTS_PER_SOL * 100).unwrap();

    (litesvm, default_payer)
}

pub fn fetch_account<T: Pack + IsInitialized>(litesvm: &LiteSVM, pubkey: &Pubkey) -> T {
    let account = litesvm.get_account(pubkey).unwrap();
    T::unpack(&account.data[..T::LEN]).unwrap()
}

#[allow(clippy::result_large_err)]
pub fn build_and_send_transaction(
    litesvm: &mut LiteSVM,
    signers: &[&Keypair],
    payer: &Pubkey,
    ix: &Instruction,
) -> TransactionResult {
    let tx = Transaction::new(signers, Message::new(std::slice::from_ref(ix), Some(payer)), litesvm.latest_blockhash());
    let result = litesvm.send_transaction(tx);
    litesvm.expire_blockhash();

    // Record CU consumption to global tracker
    record_transaction(&result, ix);

    result
}

pub fn init_wallet(litesvm: &mut LiteSVM, lamports: u64) -> Keypair {
    let wallet = Keypair::new();
    litesvm.airdrop(&wallet.pubkey(), lamports).unwrap();
    wallet
}

pub fn init_mint(
    litesvm: &mut LiteSVM,
    token_program: Pubkey,
    decimals: u8,
    supply: u64,
    authority: Option<Pubkey>,
    extensions: &[ExtensionType],
) -> Pubkey {
    let mint = Pubkey::new_unique();

    let space = if extensions.is_empty() {
        Mint2022::LEN
    } else {
        ExtensionType::try_calculate_account_len::<Mint2022>(extensions).unwrap()
    };
    let mut mint_data = vec![0u8; space];

    if extensions.is_empty() {
        let mint_state = Mint2022 {
            mint_authority: authority.into(),
            supply,
            decimals,
            is_initialized: true,
            freeze_authority: None.into(),
        };
        Mint2022::pack(mint_state, &mut mint_data).unwrap();
    } else {
        let mut state = StateWithExtensionsMut::<Mint2022>::unpack_uninitialized(&mut mint_data).unwrap();

        state.base.mint_authority = authority.into();
        state.base.supply = supply;
        state.base.decimals = decimals;
        state.base.is_initialized = true;
        state.base.freeze_authority = None.into();

        state.pack_base();
        state.init_account_type().unwrap();

        for ext in extensions {
            match ext {
                ExtensionType::ConfidentialTransferMint => {
                    state.init_extension::<ConfidentialTransferMint>(true).unwrap();
                }
                ExtensionType::NonTransferable => {
                    state.init_extension::<NonTransferable>(true).unwrap();
                }
                ExtensionType::PermanentDelegate => {
                    state.init_extension::<PermanentDelegate>(true).unwrap();
                }
                ExtensionType::TransferFeeConfig => {
                    let extension = state.init_extension::<TransferFeeConfig>(true).unwrap();
                    extension.older_transfer_fee.epoch = 0.into();
                    extension.older_transfer_fee.maximum_fee = 1_000_000.into();
                    extension.older_transfer_fee.transfer_fee_basis_points = 100.into();
                    extension.newer_transfer_fee = extension.older_transfer_fee;
                }
                ExtensionType::TransferHook => {
                    state.init_extension::<TransferHook>(true).unwrap();
                }
                ExtensionType::Pausable => {
                    state.init_extension::<PausableConfig>(true).unwrap();
                }
                ExtensionType::MintCloseAuthority => {
                    state.init_extension::<MintCloseAuthority>(true).unwrap();
                }
                _ => panic!("Unsupported extension type in test helper: {:?}", ext),
            }
        }
    }

    let lamports = litesvm.minimum_balance_for_rent_exemption(space);

    litesvm
        .set_account(
            mint,
            Account { lamports, data: mint_data, owner: token_program, executable: false, rent_epoch: 0 },
        )
        .unwrap();

    mint
}

pub fn set_transfer_hook_config(
    litesvm: &mut LiteSVM,
    mint: Pubkey,
    authority: Option<Pubkey>,
    program_id: Option<Pubkey>,
) {
    let mut account = litesvm.get_account(&mint).unwrap();
    {
        let mut state = StateWithExtensionsMut::<Mint2022>::unpack(&mut account.data).unwrap();
        let extension = state.get_extension_mut::<TransferHook>().unwrap();
        extension.authority = authority.try_into().unwrap();
        extension.program_id = program_id.try_into().unwrap();
    }
    litesvm.set_account(mint, account).unwrap();
}

pub fn init_ata(litesvm: &mut LiteSVM, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
    let token_program = litesvm.get_account(&mint).unwrap().owner;
    let ata = get_associated_token_address_with_program_id(&owner, &mint, &token_program);
    init_token_account_at(litesvm, ata, mint, owner, amount)
}

pub fn init_aux_token_account(litesvm: &mut LiteSVM, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
    init_token_account_at(litesvm, Pubkey::new_unique(), mint, owner, amount)
}

fn init_token_account_at(
    litesvm: &mut LiteSVM,
    token_account: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
) -> Pubkey {
    let token_program = litesvm.get_account(&mint).unwrap().owner;
    let account_extensions = if token_program == crate::tests::constants::TOKEN_2022_PROGRAM_ID {
        let mint_account = litesvm.get_account(&mint).unwrap();
        let mint_state = StateWithExtensions::<Mint2022>::unpack(&mint_account.data).unwrap();
        let mint_extensions = mint_state.get_extension_types().unwrap();
        ExtensionType::get_required_init_account_extensions(&mint_extensions)
    } else {
        vec![]
    };
    let space = if account_extensions.is_empty() {
        TokenAccount::LEN
    } else {
        ExtensionType::try_calculate_account_len::<TokenAccount>(&account_extensions).unwrap()
    };
    let ata_state = TokenAccount {
        mint,
        owner,
        amount,
        delegate: None.into(),
        state: AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    };

    let mut ata_data = vec![0u8; space];
    if account_extensions.is_empty() {
        TokenAccount::pack(ata_state, &mut ata_data).unwrap();
    } else {
        let mut state = StateWithExtensionsMut::<TokenAccount>::unpack_uninitialized(&mut ata_data).unwrap();
        state.base = ata_state;
        state.pack_base();
        state.init_account_type().unwrap();

        for ext in account_extensions {
            match ext {
                ExtensionType::TransferFeeAmount => {
                    state.init_extension::<TransferFeeAmount>(true).unwrap();
                }
                ExtensionType::NonTransferableAccount => {
                    state.init_extension::<NonTransferableAccount>(true).unwrap();
                }
                ExtensionType::ImmutableOwner => {
                    state.init_extension::<ImmutableOwner>(true).unwrap();
                }
                ExtensionType::TransferHookAccount => {
                    state.init_extension::<TransferHookAccount>(true).unwrap();
                }
                ExtensionType::PausableAccount => {
                    state.init_extension::<PausableAccount>(true).unwrap();
                }
                _ => panic!("Unsupported account extension type in test helper: {:?}", ext),
            }
        }
    }
    let lamports = litesvm.minimum_balance_for_rent_exemption(space);

    litesvm
        .set_account(
            token_account,
            Account { lamports, data: ata_data, owner: token_program, executable: false, rent_epoch: 0 },
        )
        .unwrap();

    token_account
}

pub fn initialize_subscription_authority_action(
    litesvm: &mut LiteSVM,
    payer: &Keypair,
    mint: Pubkey,
) -> (TransactionResult, Pubkey, u8) {
    initialize_subscription_authority_action_with_sponsor(litesvm, payer, mint, None)
}

pub fn initialize_subscription_authority_action_with_sponsor(
    litesvm: &mut LiteSVM,
    user: &Keypair,
    mint: Pubkey,
    sponsor: Option<&Keypair>,
) -> (TransactionResult, Pubkey, u8) {
    let token_program = litesvm.get_account(&mint).unwrap().owner;
    let user_ata = get_associated_token_address_with_program_id(&user.pubkey(), &mint, &token_program);
    let (subscription_authority_pda, bump) = get_subscription_authority_pda(&user.pubkey(), &mint);

    let mut accounts = vec![
        AccountMeta::new(user.pubkey(), true),
        AccountMeta::new(subscription_authority_pda, false),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new(user_ata, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(token_program, false),
    ];

    let mut signers: Vec<&Keypair> = vec![user];
    let mut fee_payer = user.pubkey();

    if let Some(sponsor) = sponsor {
        accounts.push(AccountMeta::new(sponsor.pubkey(), true));
        signers.push(sponsor);
        fee_payer = sponsor.pubkey();
    }

    let ix =
        Instruction { program_id: PROGRAM_ID, accounts, data: vec![*initialize_subscription_authority::DISCRIMINATOR] };

    (build_and_send_transaction(litesvm, &signers, &fee_payer, &ix), subscription_authority_pda, bump)
}

pub struct CreateDelegation<'a> {
    litesvm: &'a mut LiteSVM,
    delegator: &'a Keypair,
    payer: Option<&'a Keypair>,
    mint: Pubkey,
    delegatee: Pubkey,
    nonce: u64,
    custom_pda: Option<Pubkey>,
    expected_subscription_authority_init_id: Option<i64>,
}

impl<'a> CreateDelegation<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, delegator: &'a Keypair, mint: Pubkey, delegatee: Pubkey) -> Self {
        Self {
            litesvm,
            delegator,
            payer: None,
            mint,
            delegatee,
            nonce: 0,
            custom_pda: None,
            expected_subscription_authority_init_id: None,
        }
    }

    pub fn payer(mut self, payer: &'a Keypair) -> Self {
        self.payer = Some(payer);
        self
    }

    pub fn nonce(mut self, nonce: u64) -> Self {
        self.nonce = nonce;
        self
    }

    pub fn pda(mut self, pda: Pubkey) -> Self {
        self.custom_pda = Some(pda);
        self
    }

    pub fn expected_subscription_authority_init_id(mut self, init_id: i64) -> Self {
        self.expected_subscription_authority_init_id = Some(init_id);
        self
    }

    fn resolved_expected_subscription_authority_init_id(&self) -> i64 {
        self.expected_subscription_authority_init_id.unwrap_or_else(|| {
            let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.delegator.pubkey(), &self.mint);
            self.litesvm
                .get_account(&subscription_authority_pda)
                .and_then(|account| {
                    crate::state::SubscriptionAuthority::load(&account.data).ok().map(|authority| authority.init_id)
                })
                .unwrap_or_default()
        })
    }

    pub fn fixed(self, amount: u64, expiry_ts: i64) -> (TransactionResult, Pubkey) {
        let nonce_bytes = self.nonce.to_le_bytes().to_vec();
        let expected_subscription_authority_init_id = self.resolved_expected_subscription_authority_init_id();
        self.execute(
            *create_fixed_delegation::DISCRIMINATOR,
            [
                nonce_bytes,
                amount.to_le_bytes().to_vec(),
                expiry_ts.to_le_bytes().to_vec(),
                expected_subscription_authority_init_id.to_le_bytes().to_vec(),
            ]
            .concat(),
        )
    }

    pub fn recurring(
        self,
        amount_per_period: u64,
        period_length_s: u64,
        start_ts: i64,
        expiry_ts: i64,
    ) -> (TransactionResult, Pubkey) {
        let nonce_bytes = self.nonce.to_le_bytes().to_vec();
        let expected_subscription_authority_init_id = self.resolved_expected_subscription_authority_init_id();
        self.execute(
            *create_recurring_delegation::DISCRIMINATOR,
            [
                nonce_bytes,
                amount_per_period.to_le_bytes().to_vec(),
                period_length_s.to_le_bytes().to_vec(),
                start_ts.to_le_bytes().to_vec(),
                expiry_ts.to_le_bytes().to_vec(),
                expected_subscription_authority_init_id.to_le_bytes().to_vec(),
            ]
            .concat(),
        )
    }

    fn execute(self, discriminator: u8, data: Vec<u8>) -> (TransactionResult, Pubkey) {
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.delegator.pubkey(), &self.mint);
        let (derived_pda, _) =
            get_delegation_pda(&subscription_authority_pda, &self.delegator.pubkey(), &self.delegatee, self.nonce);
        let delegation_pda = self.custom_pda.unwrap_or(derived_pda);

        let mut accounts = vec![
            AccountMeta::new(self.delegator.pubkey(), true),
            AccountMeta::new(subscription_authority_pda, false),
            AccountMeta::new(delegation_pda, false),
            AccountMeta::new_readonly(self.delegatee, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ];

        let mut signers = vec![self.delegator];
        let mut fee_payer = self.delegator.pubkey();

        if let Some(p) = self.payer {
            accounts.push(AccountMeta::new(p.pubkey(), true));
            signers.push(p);
            fee_payer = p.pubkey();
        }

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: [vec![discriminator], data].concat() };

        (build_and_send_transaction(self.litesvm, &signers, &fee_payer, &ix), delegation_pda)
    }
}

pub struct TransferDelegation<'a> {
    litesvm: &'a mut LiteSVM,
    signer: &'a Keypair,
    delegator: Pubkey,
    mint: Pubkey,
    delegation_pda: Pubkey,
    amount: u64,
    source: Option<Pubkey>,
    receiver: Option<Pubkey>,
}

impl<'a> TransferDelegation<'a> {
    pub fn new(
        litesvm: &'a mut LiteSVM,
        signer: &'a Keypair,
        delegator: Pubkey,
        mint: Pubkey,
        delegation_pda: Pubkey,
    ) -> Self {
        Self { litesvm, signer, delegator, mint, delegation_pda, amount: 0, source: None, receiver: None }
    }

    pub fn amount(mut self, amount: u64) -> Self {
        self.amount = amount;
        self
    }

    pub fn to(mut self, receiver: Pubkey) -> Self {
        self.receiver = Some(receiver);
        self
    }

    pub fn from(mut self, source: Pubkey) -> Self {
        self.source = Some(source);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn fixed(self) -> TransactionResult {
        self.execute(*transfer_fixed_delegation::DISCRIMINATOR)
    }

    #[allow(clippy::result_large_err)]
    pub fn recurring(self) -> TransactionResult {
        self.execute(*transfer_recurring_delegation::DISCRIMINATOR)
    }

    #[allow(clippy::result_large_err)]
    fn execute(self, discriminator: u8) -> TransactionResult {
        let token_program = self.litesvm.get_account(&self.mint).unwrap().owner;
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.delegator, &self.mint);
        let delegator_ata = self.source.unwrap_or_else(|| {
            get_associated_token_address_with_program_id(&self.delegator, &self.mint, &token_program)
        });

        // Default receiver is the signer's (delegatee's) ATA
        let receiver_ata = self.receiver.unwrap_or_else(|| {
            get_associated_token_address_with_program_id(&self.signer.pubkey(), &self.mint, &token_program)
        });

        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.delegation_pda, false),
                AccountMeta::new(subscription_authority_pda, false),
                AccountMeta::new(delegator_ata, false),
                AccountMeta::new(receiver_ata, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(self.signer.pubkey(), true),
                AccountMeta::new_readonly(event_authority, false),
                AccountMeta::new_readonly(PROGRAM_ID, false),
            ],
            data: [
                vec![discriminator],
                self.amount.to_le_bytes().to_vec(),
                self.delegator.to_bytes().to_vec(),
                self.mint.to_bytes().to_vec(),
            ]
            .concat(),
        };

        build_and_send_transaction(self.litesvm, &[self.signer], &self.signer.pubkey(), &ix)
    }
}

pub struct RevokeDelegation<'a> {
    litesvm: &'a mut LiteSVM,
    delegator: &'a Keypair,
    signer: Option<&'a Keypair>,
    mint: Pubkey,
    delegatee: Pubkey,
    nonce: u64,
    receiver: Option<Pubkey>,
    custom_pda: Option<Pubkey>,
}

impl<'a> RevokeDelegation<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, delegator: &'a Keypair, mint: Pubkey, delegatee: Pubkey, nonce: u64) -> Self {
        Self { litesvm, delegator, signer: None, mint, delegatee, nonce, receiver: None, custom_pda: None }
    }

    pub fn signer(mut self, signer: &'a Keypair) -> Self {
        self.signer = Some(signer);
        self
    }

    pub fn receiver(mut self, receiver: Pubkey) -> Self {
        self.receiver = Some(receiver);
        self
    }

    pub fn pda(mut self, pda: Pubkey) -> Self {
        self.custom_pda = Some(pda);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.delegator.pubkey(), &self.mint);
        let (derived_pda, _) =
            get_delegation_pda(&subscription_authority_pda, &self.delegator.pubkey(), &self.delegatee, self.nonce);
        let delegation_pda = self.custom_pda.unwrap_or(derived_pda);

        let authority = self.signer.unwrap_or(self.delegator);

        let mut accounts = vec![AccountMeta::new(authority.pubkey(), true), AccountMeta::new(delegation_pda, false)];

        if let Some(r) = self.receiver {
            accounts.push(AccountMeta::new(r, false));
        }

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*revoke_delegation::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[authority], &authority.pubkey(), &ix)
    }
}

pub struct CloseSubscriptionAuthority<'a> {
    litesvm: &'a mut LiteSVM,
    user: &'a Keypair,
    mint: Pubkey,
    custom_pda: Option<Pubkey>,
    receiver: Option<Pubkey>,
}

impl<'a> CloseSubscriptionAuthority<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, user: &'a Keypair, mint: Pubkey) -> Self {
        Self { litesvm, user, mint, custom_pda: None, receiver: None }
    }

    pub fn pda(mut self, pda: Pubkey) -> Self {
        self.custom_pda = Some(pda);
        self
    }

    pub fn receiver(mut self, receiver: Pubkey) -> Self {
        self.receiver = Some(receiver);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let (derived_pda, _) = get_subscription_authority_pda(&self.user.pubkey(), &self.mint);
        let subscription_authority_pda = self.custom_pda.unwrap_or(derived_pda);

        let mut accounts =
            vec![AccountMeta::new(self.user.pubkey(), true), AccountMeta::new(subscription_authority_pda, false)];

        if let Some(receiver) = self.receiver {
            accounts.push(AccountMeta::new(receiver, false));
        }

        let ix =
            Instruction { program_id: PROGRAM_ID, accounts, data: vec![*close_subscription_authority::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[self.user], &self.user.pubkey(), &ix)
    }
}

pub struct CreatePlan<'a> {
    litesvm: &'a mut LiteSVM,
    owner: &'a Keypair,
    data: PlanData,
    destinations_vec: Vec<Pubkey>,
    pullers_vec: Vec<Pubkey>,
    custom_pda: Option<Pubkey>,
}

impl<'a> CreatePlan<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, owner: &'a Keypair, mint: Pubkey) -> Self {
        let zero_addr: pinocchio::Address = [0u8; 32].into();
        Self {
            litesvm,
            owner,
            data: PlanData {
                plan_id: 0,
                mint: mint.to_bytes().into(),
                terms: PlanTerms { amount: 0, period_hours: 0, created_at: 0 },
                end_ts: 0,
                destinations: [zero_addr; MAX_DESTINATIONS],
                pullers: [zero_addr; MAX_PULLERS],
                metadata_uri: [0u8; 128],
            },
            destinations_vec: vec![],
            pullers_vec: vec![],
            custom_pda: None,
        }
    }

    pub fn plan_id(mut self, plan_id: u64) -> Self {
        self.data.plan_id = plan_id;
        self
    }

    pub fn amount(mut self, amount: u64) -> Self {
        self.data.terms.amount = amount;
        self
    }

    pub fn period_hours(mut self, period_hours: u64) -> Self {
        self.data.terms.period_hours = period_hours;
        self
    }

    pub fn end_ts(mut self, end_ts: i64) -> Self {
        self.data.end_ts = end_ts;
        self
    }

    pub fn destinations(mut self, destinations: Vec<Pubkey>) -> Self {
        self.destinations_vec = destinations;
        self
    }

    pub fn pullers(mut self, pullers: Vec<Pubkey>) -> Self {
        self.pullers_vec = pullers;
        self
    }

    pub fn metadata_uri(mut self, uri: &str) -> Self {
        let bytes = uri.as_bytes();
        let len = bytes.len().min(128);
        self.data.metadata_uri[..len].copy_from_slice(&bytes[..len]);
        self
    }

    pub fn pda(mut self, pda: Pubkey) -> Self {
        self.custom_pda = Some(pda);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(mut self) -> (TransactionResult, Pubkey) {
        let (derived_pda, _) = get_plan_pda(&self.owner.pubkey(), self.data.plan_id);
        let plan_pda = self.custom_pda.unwrap_or(derived_pda);

        assert!(self.destinations_vec.len() <= MAX_DESTINATIONS, "max {MAX_DESTINATIONS} destinations");
        let mut destinations = [[0u8; 32]; MAX_DESTINATIONS];
        for (i, d) in self.destinations_vec.iter().enumerate() {
            destinations[i] = d.to_bytes();
        }
        self.data.destinations = destinations.map(|d| d.into());

        assert!(self.pullers_vec.len() <= MAX_PULLERS, "max {MAX_PULLERS} pullers");
        let mut pullers = [[0u8; 32]; MAX_PULLERS];
        for (i, p) in self.pullers_vec.iter().enumerate() {
            pullers[i] = p.to_bytes();
        }
        self.data.pullers = pullers.map(|p| p.into());

        let plan_data_bytes =
            unsafe { std::slice::from_raw_parts(&self.data as *const PlanData as *const u8, PlanData::LEN) };

        let mut data = vec![*create_plan::DISCRIMINATOR];
        data.extend_from_slice(plan_data_bytes);

        let mint_pubkey = Pubkey::new_from_array(self.data.mint.to_bytes());
        let token_program = self
            .litesvm
            .get_account(&mint_pubkey)
            .map(|a| a.owner)
            .unwrap_or(crate::tests::constants::TOKEN_PROGRAM_ID);

        let accounts = vec![
            AccountMeta::new(self.owner.pubkey(), true),
            AccountMeta::new(plan_pda, false),
            AccountMeta::new_readonly(mint_pubkey, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(token_program, false),
        ];

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        (build_and_send_transaction(self.litesvm, &[self.owner], &self.owner.pubkey(), &ix), plan_pda)
    }
}

pub struct UpdatePlan<'a> {
    litesvm: &'a mut LiteSVM,
    owner: &'a Keypair,
    plan_pda: Pubkey,
    pullers_vec: Vec<Pubkey>,
    data: UpdatePlanData,
}

impl<'a> UpdatePlan<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, owner: &'a Keypair, plan_pda: Pubkey) -> Self {
        let zero_addr: pinocchio::Address = [0u8; 32].into();
        Self {
            litesvm,
            owner,
            plan_pda,
            pullers_vec: vec![],
            data: UpdatePlanData {
                status: PlanStatus::Active as u8,
                end_ts: 0,
                pullers: [zero_addr; MAX_PULLERS],
                metadata_uri: [0u8; 128],
            },
        }
    }

    pub fn status(mut self, status: PlanStatus) -> Self {
        self.data.status = status as u8;
        self
    }

    pub fn status_raw(mut self, status: u8) -> Self {
        self.data.status = status;
        self
    }

    pub fn end_ts(mut self, end_ts: i64) -> Self {
        self.data.end_ts = end_ts;
        self
    }

    pub fn pullers(mut self, pullers: Vec<Pubkey>) -> Self {
        self.pullers_vec = pullers;
        self
    }

    pub fn metadata_uri(mut self, uri: &str) -> Self {
        let bytes = uri.as_bytes();
        let len = bytes.len().min(128);
        self.data.metadata_uri = [0u8; 128];
        self.data.metadata_uri[..len].copy_from_slice(&bytes[..len]);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(mut self) -> TransactionResult {
        assert!(self.pullers_vec.len() <= MAX_PULLERS, "max {MAX_PULLERS} pullers");
        let mut pullers = [[0u8; 32]; MAX_PULLERS];
        for (i, p) in self.pullers_vec.iter().enumerate() {
            pullers[i] = p.to_bytes();
        }
        self.data.pullers = pullers.map(|p| p.into());

        let data_bytes = unsafe {
            std::slice::from_raw_parts(&self.data as *const UpdatePlanData as *const u8, UpdatePlanData::LEN)
        };

        let mut data = vec![*update_plan::DISCRIMINATOR];
        data.extend_from_slice(data_bytes);

        let accounts = vec![AccountMeta::new(self.owner.pubkey(), true), AccountMeta::new(self.plan_pda, false)];

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        build_and_send_transaction(self.litesvm, &[self.owner], &self.owner.pubkey(), &ix)
    }
}

pub struct DeletePlan<'a> {
    litesvm: &'a mut LiteSVM,
    owner: &'a Keypair,
    plan_pda: Pubkey,
}

impl<'a> DeletePlan<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, owner: &'a Keypair, plan_pda: Pubkey) -> Self {
        Self { litesvm, owner, plan_pda }
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let accounts = vec![AccountMeta::new(self.owner.pubkey(), true), AccountMeta::new(self.plan_pda, false)];

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*delete_plan::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[self.owner], &self.owner.pubkey(), &ix)
    }
}

pub struct CreateSubscription<'a> {
    litesvm: &'a mut LiteSVM,
    plan_pda: Pubkey,
    subscriber: Pubkey,
    mint: Pubkey,
    period_start_ts: i64,
    amount_pulled: u64,
    expires_at_ts: i64,
    terms: PlanTerms,
}

impl<'a> CreateSubscription<'a> {
    pub fn new(
        litesvm: &'a mut LiteSVM,
        plan_pda: Pubkey,
        subscriber: Pubkey,
        mint: Pubkey,
        period_start_ts: i64,
    ) -> Self {
        Self {
            litesvm,
            plan_pda,
            subscriber,
            mint,
            period_start_ts,
            amount_pulled: 0,
            expires_at_ts: 0,
            terms: PlanTerms { amount: 0, period_hours: 0, created_at: 0 },
        }
    }

    pub fn amount_pulled(mut self, amount_pulled: u64) -> Self {
        self.amount_pulled = amount_pulled;
        self
    }

    pub fn expires_at_ts(mut self, expires_at_ts: i64) -> Self {
        self.expires_at_ts = expires_at_ts;
        self
    }

    pub fn terms(mut self, terms: PlanTerms) -> Self {
        self.terms = terms;
        self
    }

    pub fn execute(self) -> Pubkey {
        use crate::{
            state::{common::AccountDiscriminator, versioning::CURRENT_VERSION},
            tests::pda::{get_subscription_authority_pda, get_subscription_pda},
            Header, SubscriptionAuthority, SubscriptionDelegation,
        };

        let (md_pda, _) = get_subscription_authority_pda(&self.subscriber, &self.mint);
        let md_account = self.litesvm.get_account(&md_pda).unwrap();
        let md = SubscriptionAuthority::load(&md_account.data).unwrap();
        let init_id = md.init_id;

        let (subscription_pda, bump) = get_subscription_pda(&self.plan_pda, &self.subscriber);

        let subscription = SubscriptionDelegation {
            header: Header {
                discriminator: AccountDiscriminator::SubscriptionDelegation as u8,
                version: CURRENT_VERSION,
                bump,
                delegator: self.subscriber.to_bytes().into(),
                delegatee: self.plan_pda.to_bytes().into(),
                payer: self.subscriber.to_bytes().into(),
                init_id,
            },
            terms: self.terms,
            amount_pulled_in_period: self.amount_pulled,
            current_period_start_ts: self.period_start_ts,
            expires_at_ts: self.expires_at_ts,
        };

        let data = unsafe {
            std::slice::from_raw_parts(
                &subscription as *const SubscriptionDelegation as *const u8,
                SubscriptionDelegation::LEN,
            )
        };

        let lamports = self.litesvm.minimum_balance_for_rent_exemption(data.len());
        self.litesvm
            .set_account(
                subscription_pda,
                Account { lamports, data: data.to_vec(), owner: PROGRAM_ID, executable: false, rent_epoch: 0 },
            )
            .unwrap();

        subscription_pda
    }
}

pub struct TransferSubscription<'a> {
    litesvm: &'a mut LiteSVM,
    caller: &'a Keypair,
    delegator: Pubkey,
    mint: Pubkey,
    subscription_pda: Pubkey,
    plan_pda: Pubkey,
    amount: u64,
    receiver: Option<Pubkey>,
}

impl<'a> TransferSubscription<'a> {
    pub fn new(
        litesvm: &'a mut LiteSVM,
        caller: &'a Keypair,
        delegator: Pubkey,
        mint: Pubkey,
        subscription_pda: Pubkey,
        plan_pda: Pubkey,
    ) -> Self {
        Self { litesvm, caller, delegator, mint, subscription_pda, plan_pda, amount: 0, receiver: None }
    }

    pub fn amount(mut self, amount: u64) -> Self {
        self.amount = amount;
        self
    }

    pub fn to(mut self, receiver: Pubkey) -> Self {
        self.receiver = Some(receiver);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let token_program = self.litesvm.get_account(&self.mint).unwrap().owner;
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.delegator, &self.mint);
        let delegator_ata = get_associated_token_address_with_program_id(&self.delegator, &self.mint, &token_program);

        let receiver_ata = self.receiver.unwrap_or_else(|| {
            get_associated_token_address_with_program_id(&self.caller.pubkey(), &self.mint, &token_program)
        });

        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.subscription_pda, false),
                AccountMeta::new_readonly(self.plan_pda, false),
                AccountMeta::new_readonly(subscription_authority_pda, false),
                AccountMeta::new(delegator_ata, false),
                AccountMeta::new(receiver_ata, false),
                AccountMeta::new_readonly(self.caller.pubkey(), true),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(event_authority, false),
                AccountMeta::new_readonly(PROGRAM_ID, false),
            ],
            data: [
                vec![*transfer_subscription::DISCRIMINATOR],
                self.amount.to_le_bytes().to_vec(),
                self.delegator.to_bytes().to_vec(),
                self.mint.to_bytes().to_vec(),
            ]
            .concat(),
        };

        build_and_send_transaction(self.litesvm, &[self.caller], &self.caller.pubkey(), &ix)
    }
}

pub struct Subscribe<'a> {
    litesvm: &'a mut LiteSVM,
    subscriber: &'a Keypair,
    merchant: Pubkey,
    plan_pda: Pubkey,
    plan_id: u64,
    plan_bump: u8,
    mint: Pubkey,
    payer: Option<&'a Keypair>,
}

impl<'a> Subscribe<'a> {
    pub fn new(
        litesvm: &'a mut LiteSVM,
        subscriber: &'a Keypair,
        merchant: Pubkey,
        plan_pda: Pubkey,
        plan_id: u64,
        plan_bump: u8,
        mint: Pubkey,
    ) -> Self {
        Self { litesvm, subscriber, merchant, plan_pda, plan_id, plan_bump, mint, payer: None }
    }

    pub fn payer(mut self, payer: &'a Keypair) -> Self {
        self.payer = Some(payer);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&self.subscriber.pubkey(), &self.mint);
        let (subscription_pda, _) = get_subscription_pda(&self.plan_pda, &self.subscriber.pubkey());

        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        let mut accounts = vec![
            AccountMeta::new(self.subscriber.pubkey(), true),
            AccountMeta::new_readonly(self.merchant, false),
            AccountMeta::new_readonly(self.plan_pda, false),
            AccountMeta::new(subscription_pda, false),
            AccountMeta::new_readonly(subscription_authority_pda, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        let mut signers: Vec<&Keypair> = vec![self.subscriber];
        let mut fee_payer = self.subscriber.pubkey();

        if let Some(p) = self.payer {
            accounts.push(AccountMeta::new(p.pubkey(), true));
            signers.push(p);
            fee_payer = p.pubkey();
        }

        // Snapshot live plan terms to bind subscriber consent.
        let plan_account = self.litesvm.get_account(&self.plan_pda).unwrap();
        let plan = crate::state::Plan::load(&plan_account.data).unwrap();
        let expected_amount = plan.data.terms.amount;
        let expected_period_hours = plan.data.terms.period_hours;
        let expected_created_at = plan.data.terms.created_at;
        let expected_mint = plan.data.mint;
        let expected_subscription_authority_init_id = self
            .litesvm
            .get_account(&subscription_authority_pda)
            .and_then(|account| {
                crate::state::SubscriptionAuthority::load(&account.data).ok().map(|authority| authority.init_id)
            })
            .unwrap_or_default();

        let data = [
            vec![*subscribe::DISCRIMINATOR],
            self.plan_id.to_le_bytes().to_vec(),
            vec![self.plan_bump],
            expected_mint.as_ref().to_vec(),
            expected_amount.to_le_bytes().to_vec(),
            expected_period_hours.to_le_bytes().to_vec(),
            expected_created_at.to_le_bytes().to_vec(),
            expected_subscription_authority_init_id.to_le_bytes().to_vec(),
        ]
        .concat();

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

        build_and_send_transaction(self.litesvm, &signers, &fee_payer, &ix)
    }
}

pub struct CancelSubscription<'a> {
    litesvm: &'a mut LiteSVM,
    subscriber: &'a Keypair,
    plan_pda: Pubkey,
    subscription_pda: Pubkey,
}

impl<'a> CancelSubscription<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, subscriber: &'a Keypair, plan_pda: Pubkey, subscription_pda: Pubkey) -> Self {
        Self { litesvm, subscriber, plan_pda, subscription_pda }
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        let accounts = vec![
            AccountMeta::new_readonly(self.subscriber.pubkey(), true),
            AccountMeta::new_readonly(self.plan_pda, false),
            AccountMeta::new(self.subscription_pda, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*cancel_subscription::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[self.subscriber], &self.subscriber.pubkey(), &ix)
    }
}

pub struct ResumeSubscription<'a> {
    litesvm: &'a mut LiteSVM,
    subscriber: &'a Keypair,
    plan_pda: Pubkey,
    subscription_pda: Pubkey,
}

impl<'a> ResumeSubscription<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, subscriber: &'a Keypair, plan_pda: Pubkey, subscription_pda: Pubkey) -> Self {
        Self { litesvm, subscriber, plan_pda, subscription_pda }
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let event_authority = Pubkey::new_from_array(event_authority_pda::ID.to_bytes());

        let accounts = vec![
            AccountMeta::new_readonly(self.subscriber.pubkey(), true),
            AccountMeta::new_readonly(self.plan_pda, false),
            AccountMeta::new(self.subscription_pda, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ];

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*resume_subscription::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[self.subscriber], &self.subscriber.pubkey(), &ix)
    }
}

pub fn setup_with_subscription() -> (
    LiteSVM,
    Keypair, // alice (subscriber)
    Keypair, // merchant
    Pubkey,  // mint
    Pubkey,  // plan_pda
    u8,      // plan_bump
    Pubkey,  // subscription_pda
) {
    use crate::tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        pda::get_subscription_pda,
    };

    let (mut litesvm, alice) = setup();
    let merchant = Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let _alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let end_ts = current_ts() + days(30) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);
    Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint).execute().assert_ok();

    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());

    (litesvm, alice, merchant, mint, plan_pda, plan_bump, subscription_pda)
}

pub struct RevokeSubscription<'a> {
    litesvm: &'a mut LiteSVM,
    authority: &'a Keypair,
    subscription_pda: Pubkey,
    plan_pda: Pubkey,
    receiver: Option<Pubkey>,
}

impl<'a> RevokeSubscription<'a> {
    pub fn new(litesvm: &'a mut LiteSVM, authority: &'a Keypair, subscription_pda: Pubkey, plan_pda: Pubkey) -> Self {
        Self { litesvm, authority, subscription_pda, plan_pda, receiver: None }
    }

    pub fn receiver(mut self, receiver: Pubkey) -> Self {
        self.receiver = Some(receiver);
        self
    }

    #[allow(clippy::result_large_err)]
    pub fn execute(self) -> TransactionResult {
        let mut accounts = vec![
            AccountMeta::new(self.authority.pubkey(), true),
            AccountMeta::new(self.subscription_pda, false),
            AccountMeta::new_readonly(self.plan_pda, false),
        ];

        if let Some(receiver) = self.receiver {
            accounts.push(AccountMeta::new(receiver, false));
        }

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*revoke_delegation::DISCRIMINATOR] };

        build_and_send_transaction(self.litesvm, &[self.authority], &self.authority.pubkey(), &ix)
    }
}
