use anyhow::{anyhow, Context, Result};
use solana_address::Address;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signature, Signer},
    system_instruction,
    transaction::Transaction,
};
use subscriptions_client::{
    accounts::{FixedDelegation, Plan, RecurringDelegation, SubscriptionDelegation},
    generated::{instructions::*, types::*},
    SUBSCRIPTIONS_ID,
};

const DEFAULT_RPC_URL: &str = "https://api.devnet.solana.com";
const DECIMALS: u8 = 6;
const SPL_TOKEN_MINT_LEN: usize = 82;
const STARTING_TOKEN_BALANCE: u64 = 10_000_000;
const ACTOR_FUNDING_LAMPORTS: u64 = LAMPORTS_PER_SOL / 20;
const MINIMUM_BALANCE_LAMPORTS: u64 = LAMPORTS_PER_SOL / 5;

fn main() -> Result<()> {
    let rpc_url = std::env::var("GUIDE_DEVNET_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string());
    let keypair_path = std::env::var("GUIDE_DEVNET_KEYPAIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{home}/.config/solana/id.json")
    });
    let selected_flow = std::env::var("GUIDE_DEVNET_FLOW").unwrap_or_else(|_| "all".to_string());

    println!("RPC: {rpc_url}");
    println!("Sponsor keypair: {keypair_path}");

    let rpc = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
    let sponsor = read_keypair_file(&keypair_path)
        .map_err(|err| anyhow!("failed to read sponsor keypair {keypair_path}: {err}"))?;
    assert_sponsor_funded(&rpc, &sponsor)?;
    log_address("sponsor wallet", &sponsor.pubkey());

    if selected_flow == "all" || selected_flow == "authority" {
        test_subscription_authority_lifecycle(&rpc, &sponsor)?;
    }
    if selected_flow == "all" || selected_flow == "fixed" {
        test_fixed_delegation(&rpc, &sponsor)?;
    }
    if selected_flow == "all" || selected_flow == "recurring" {
        test_recurring_delegation(&rpc, &sponsor)?;
    }
    if selected_flow == "all" || selected_flow == "plan" {
        test_subscription_plan(&rpc, &sponsor)?;
    }

    println!("Rust guide devnet checks passed.");
    Ok(())
}

fn test_subscription_authority_lifecycle(rpc: &RpcClient, sponsor: &Keypair) -> Result<()> {
    log_section("Subscription Authority Lifecycle");

    let user = Keypair::new();
    log_address("user wallet", &user.pubkey());
    fund_from_sponsor(rpc, sponsor, &user.pubkey())?;

    let token_mint = create_mint(rpc, &user)?;
    let user_ata = create_ata_and_mint(rpc, &user, &user.pubkey(), &token_mint, STARTING_TOKEN_BALANCE)?;
    let subscription_authority = ensure_subscription_authority(rpc, &user, &token_mint, &user_ata, Some(sponsor))?;

    anyhow::ensure!(rpc.get_account(&subscription_authority).is_ok(), "subscription authority init check failed");
    close_subscription_authority(rpc, &user, &token_mint, Some(&sponsor.pubkey()), "standalone ")?;
    Ok(())
}

fn test_fixed_delegation(rpc: &RpcClient, sponsor: &Keypair) -> Result<()> {
    log_section("Fixed Delegation");

    let user = Keypair::new();
    let delegatee = Keypair::new();
    log_address("user wallet", &user.pubkey());
    log_address("delegatee wallet", &delegatee.pubkey());
    fund_from_sponsor(rpc, sponsor, &user.pubkey())?;
    fund_from_sponsor(rpc, sponsor, &delegatee.pubkey())?;

    let token_mint = create_mint(rpc, &user)?;
    let user_ata = create_ata_and_mint(rpc, &user, &user.pubkey(), &token_mint, STARTING_TOKEN_BALANCE)?;
    let receiver_ata = create_ata_and_mint(rpc, &user, &delegatee.pubkey(), &token_mint, 0)?;

    let nonce = unix_timestamp()? as u64;
    let amount = 1_000_000;
    let expiry_ts = unix_timestamp()? + 60 * 60;
    let subscription_authority = ensure_subscription_authority(rpc, &user, &token_mint, &user_ata, None)?;
    let delegation_pda = fixed_delegation_pda(&subscription_authority, &user.pubkey(), &delegatee.pubkey(), nonce);

    let create_ix = CreateFixedDelegationBuilder::new()
        .delegator(user.pubkey())
        .subscription_authority(subscription_authority)
        .delegation_account(delegation_pda)
        .delegatee(delegatee.pubkey())
        .fixed_delegation(CreateFixedDelegationData { nonce, amount, expiry_ts })
        .instruction();
    let signature = send(rpc, &[create_ix], &user, &[&user])?;
    log_signature("create fixed delegation tx", &signature);
    log_address("fixed delegation PDA", &delegation_pda);

    let before = token_balance(rpc, &receiver_ata)?;
    let transfer_ix = TransferFixedBuilder::new()
        .delegation_pda(delegation_pda)
        .subscription_authority(subscription_authority)
        .delegator_ata(user_ata)
        .receiver_ata(receiver_ata)
        .token_program(spl_token::id())
        .delegatee(delegatee.pubkey())
        .transfer_data(TransferData { amount: 100_000, delegator: user.pubkey(), mint: token_mint })
        .instruction();
    let signature = send(rpc, &[transfer_ix], &delegatee, &[&delegatee])?;
    log_signature("transfer fixed tx", &signature);

    let after = token_balance(rpc, &receiver_ata)?;
    anyhow::ensure!(after - before == 100_000, "fixed delegation transfer balance check failed");
    let delegation = decode_account::<FixedDelegation>(rpc, &delegation_pda)?;
    anyhow::ensure!(delegation.amount == amount - 100_000, "fixed delegation remaining amount check failed");

    let revoke_ix =
        RevokeDelegationBuilder::new().authority(user.pubkey()).delegation_account(delegation_pda).instruction();
    let signature = send(rpc, &[revoke_ix], &user, &[&user])?;
    log_signature("revoke fixed delegation tx", &signature);
    anyhow::ensure!(rpc.get_account(&delegation_pda).is_err(), "fixed delegation revoke check failed");

    close_subscription_authority(rpc, &user, &token_mint, None, "fixed delegation ")?;
    Ok(())
}

fn test_recurring_delegation(rpc: &RpcClient, sponsor: &Keypair) -> Result<()> {
    log_section("Recurring Delegation");

    let user = Keypair::new();
    let delegatee = Keypair::new();
    log_address("user wallet", &user.pubkey());
    log_address("delegatee wallet", &delegatee.pubkey());
    fund_from_sponsor(rpc, sponsor, &user.pubkey())?;
    fund_from_sponsor(rpc, sponsor, &delegatee.pubkey())?;

    let token_mint = create_mint(rpc, &user)?;
    let user_ata = create_ata_and_mint(rpc, &user, &user.pubkey(), &token_mint, STARTING_TOKEN_BALANCE)?;
    let receiver_ata = create_ata_and_mint(rpc, &user, &delegatee.pubkey(), &token_mint, 0)?;

    let now = unix_timestamp()?;
    let nonce = now as u64 + 1;
    let amount_per_period = 1_000_000;
    let period_length_s = 86_400;
    let start_ts = now;
    let expiry_ts = now + period_length_s as i64 * 30;
    let subscription_authority = ensure_subscription_authority(rpc, &user, &token_mint, &user_ata, None)?;
    let delegation_pda = fixed_delegation_pda(&subscription_authority, &user.pubkey(), &delegatee.pubkey(), nonce);
    log_address("recurring delegation PDA", &delegation_pda);

    let create_ix = CreateRecurringDelegationBuilder::new()
        .delegator(user.pubkey())
        .subscription_authority(subscription_authority)
        .delegation_account(delegation_pda)
        .delegatee(delegatee.pubkey())
        .recurring_delegation(CreateRecurringDelegationData {
            nonce,
            amount_per_period,
            period_length_s,
            start_ts,
            expiry_ts,
        })
        .instruction();
    let signature = send(rpc, &[create_ix], &user, &[&user])?;
    log_signature("create recurring delegation tx", &signature);

    let before = token_balance(rpc, &receiver_ata)?;
    let transfer_ix = TransferRecurringBuilder::new()
        .delegation_pda(delegation_pda)
        .subscription_authority(subscription_authority)
        .delegator_ata(user_ata)
        .receiver_ata(receiver_ata)
        .token_program(spl_token::id())
        .delegatee(delegatee.pubkey())
        .transfer_data(TransferData { amount: 100_000, delegator: user.pubkey(), mint: token_mint })
        .instruction();
    let signature = send(rpc, &[transfer_ix], &delegatee, &[&delegatee])?;
    log_signature("transfer recurring tx", &signature);

    let after = token_balance(rpc, &receiver_ata)?;
    anyhow::ensure!(after - before == 100_000, "recurring delegation transfer balance check failed");
    let delegation = decode_account::<RecurringDelegation>(rpc, &delegation_pda)?;
    anyhow::ensure!(delegation.amount_pulled_in_period == 100_000, "recurring delegation period amount check failed");

    let revoke_ix =
        RevokeDelegationBuilder::new().authority(user.pubkey()).delegation_account(delegation_pda).instruction();
    let signature = send(rpc, &[revoke_ix], &user, &[&user])?;
    log_signature("revoke recurring delegation tx", &signature);
    anyhow::ensure!(rpc.get_account(&delegation_pda).is_err(), "recurring delegation revoke check failed");

    close_subscription_authority(rpc, &user, &token_mint, None, "recurring delegation ")?;
    Ok(())
}

fn test_subscription_plan(rpc: &RpcClient, sponsor: &Keypair) -> Result<()> {
    log_section("Subscription Plan");

    let merchant = Keypair::new();
    let subscriber = Keypair::new();
    log_address("merchant wallet", &merchant.pubkey());
    log_address("subscriber wallet", &subscriber.pubkey());
    fund_from_sponsor(rpc, sponsor, &merchant.pubkey())?;
    fund_from_sponsor(rpc, sponsor, &subscriber.pubkey())?;

    let token_mint = create_mint(rpc, &merchant)?;
    let merchant_ata = create_ata_and_mint(rpc, &merchant, &merchant.pubkey(), &token_mint, 0)?;
    let subscriber_ata =
        create_ata_and_mint(rpc, &merchant, &subscriber.pubkey(), &token_mint, STARTING_TOKEN_BALANCE)?;

    let plan_id = unix_timestamp()? as u64;
    let (plan_pda, plan_bump) = plan_pda(&merchant.pubkey(), plan_id);
    let amount = 5_000_000;
    let period_hours = 720;
    let mut metadata_uri = [0u8; 128];
    let metadata_bytes = b"https://example.com/plan.json";
    metadata_uri[..metadata_bytes.len()].copy_from_slice(metadata_bytes);

    let mut destinations = [Pubkey::default(); 4];
    destinations[0] = merchant.pubkey();
    let pullers = [Pubkey::default(); 4];

    let create_plan_ix = CreatePlanBuilder::new()
        .merchant(merchant.pubkey())
        .plan_pda(plan_pda)
        .token_mint(token_mint)
        .token_program(spl_token::id())
        .plan_data(PlanData {
            plan_id,
            mint: token_mint,
            terms: PlanTerms { amount, period_hours, created_at: 0 },
            end_ts: 0,
            destinations,
            pullers,
            metadata_uri,
        })
        .instruction();
    let signature = send(rpc, &[create_plan_ix], &merchant, &[&merchant])?;
    log_signature("create plan tx", &signature);
    log_address("plan PDA", &plan_pda);

    let new_puller = Keypair::new();
    fund_from_sponsor(rpc, sponsor, &new_puller.pubkey())?;
    let mut updated_pullers = [Pubkey::default(); 4];
    updated_pullers[0] = new_puller.pubkey();
    let mut updated_metadata_uri = [0u8; 128];
    let updated_metadata_bytes = b"https://example.com/updated-plan.json";
    updated_metadata_uri[..updated_metadata_bytes.len()].copy_from_slice(updated_metadata_bytes);
    let update_plan_ix = UpdatePlanBuilder::new()
        .owner(merchant.pubkey())
        .plan_pda(plan_pda)
        .update_plan_data(UpdatePlanData {
            status: PlanStatus::Active as u8,
            end_ts: 0,
            pullers: updated_pullers,
            metadata_uri: updated_metadata_uri,
        })
        .instruction();
    let signature = send(rpc, &[update_plan_ix], &merchant, &[&merchant])?;
    log_signature("update plan tx", &signature);

    let updated_plan = decode_account::<Plan>(rpc, &plan_pda)?;
    anyhow::ensure!(updated_plan.data.pullers[0] == new_puller.pubkey(), "plan update puller check failed");
    anyhow::ensure!(updated_plan.data.metadata_uri == updated_metadata_uri, "plan update metadata check failed");

    let subscription_authority = ensure_subscription_authority(rpc, &subscriber, &token_mint, &subscriber_ata, None)?;
    let subscription_pda = subscription_pda(&plan_pda, &subscriber.pubkey());
    let fetched_plan = decode_account::<Plan>(rpc, &plan_pda)?;
    let subscribe_ix = SubscribeBuilder::new()
        .subscriber(subscriber.pubkey())
        .merchant(merchant.pubkey())
        .plan_pda(plan_pda)
        .subscription_pda(subscription_pda)
        .subscription_authority_pda(subscription_authority)
        .subscribe_data(SubscribeData {
            plan_id,
            plan_bump,
            expected_mint: fetched_plan.data.mint,
            expected_amount: fetched_plan.data.terms.amount,
            expected_period_hours: fetched_plan.data.terms.period_hours,
            expected_created_at: fetched_plan.data.terms.created_at,
        })
        .instruction();
    let signature = send(rpc, &[subscribe_ix], &subscriber, &[&subscriber])?;
    log_signature("subscribe tx", &signature);
    log_address("subscription delegation PDA", &subscription_pda);

    let before = token_balance(rpc, &merchant_ata)?;
    let collect_ix = TransferSubscriptionBuilder::new()
        .subscription_pda(subscription_pda)
        .plan_pda(plan_pda)
        .subscription_authority(subscription_authority)
        .delegator_ata(subscriber_ata)
        .receiver_ata(merchant_ata)
        .caller(merchant.pubkey())
        .token_program(spl_token::id())
        .transfer_data(TransferData { amount: 200_000, delegator: subscriber.pubkey(), mint: token_mint })
        .instruction();
    let signature = send(rpc, &[collect_ix], &merchant, &[&merchant])?;
    log_signature("transfer subscription tx", &signature);

    let after = token_balance(rpc, &merchant_ata)?;
    anyhow::ensure!(after - before == 200_000, "subscription transfer balance check failed");
    let subscription = decode_account::<SubscriptionDelegation>(rpc, &subscription_pda)?;
    anyhow::ensure!(subscription.amount_pulled_in_period == 200_000, "subscription pulled amount check failed");

    let cancel_ix = CancelSubscriptionBuilder::new()
        .subscriber(subscriber.pubkey())
        .plan_pda(plan_pda)
        .subscription_pda(subscription_pda)
        .instruction();
    let signature = send(rpc, &[cancel_ix], &subscriber, &[&subscriber])?;
    log_signature("cancel subscription tx", &signature);

    let subscription_after_cancel = decode_account::<SubscriptionDelegation>(rpc, &subscription_pda)?;
    anyhow::ensure!(subscription_after_cancel.expires_at_ts != 0, "subscription cancel check failed");
    Ok(())
}

fn assert_sponsor_funded(rpc: &RpcClient, sponsor: &Keypair) -> Result<()> {
    let balance = rpc.get_balance(&sponsor.pubkey())?;
    anyhow::ensure!(
        balance >= MINIMUM_BALANCE_LAMPORTS,
        "devnet sponsor {} has {balance} lamports; fund it or set GUIDE_DEVNET_KEYPAIR",
        sponsor.pubkey()
    );
    Ok(())
}

fn fund_from_sponsor(rpc: &RpcClient, sponsor: &Keypair, recipient: &Pubkey) -> Result<()> {
    if rpc.get_balance(recipient).unwrap_or(0) >= MINIMUM_BALANCE_LAMPORTS {
        return Ok(());
    }
    let ix = system_instruction::transfer(&sponsor.pubkey(), recipient, ACTOR_FUNDING_LAMPORTS);
    let signature = send(rpc, &[ix], sponsor, &[sponsor])?;
    log_signature(&format!("fund {recipient}"), &signature);
    Ok(())
}

fn create_mint(rpc: &RpcClient, mint_authority: &Keypair) -> Result<Pubkey> {
    let mint = Keypair::new();
    let rent = rpc.get_minimum_balance_for_rent_exemption(SPL_TOKEN_MINT_LEN)?;
    let ixs = vec![
        system_instruction::create_account(
            &mint_authority.pubkey(),
            &mint.pubkey(),
            rent,
            SPL_TOKEN_MINT_LEN as u64,
            &spl_token::id(),
        ),
        spl_token::instruction::initialize_mint(
            &spl_token::id(),
            &mint.pubkey(),
            &mint_authority.pubkey(),
            None,
            DECIMALS,
        )?,
    ];
    let signature = send(rpc, &ixs, mint_authority, &[mint_authority, &mint])?;
    log_address("token mint", &mint.pubkey());
    log_signature("create mint tx", &signature);
    Ok(mint.pubkey())
}

fn create_ata_and_mint(
    rpc: &RpcClient,
    payer_and_mint_authority: &Keypair,
    owner: &Pubkey,
    mint: &Pubkey,
    amount: u64,
) -> Result<Pubkey> {
    let ata = spl_associated_token_account::get_associated_token_address_with_program_id(owner, mint, &spl_token::id());
    let create_ata_ix = spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        &payer_and_mint_authority.pubkey(),
        owner,
        mint,
        &spl_token::id(),
    );
    let mut ixs = vec![create_ata_ix];
    if amount > 0 {
        ixs.push(spl_token::instruction::mint_to(
            &spl_token::id(),
            mint,
            &ata,
            &payer_and_mint_authority.pubkey(),
            &[],
            amount,
        )?);
    }
    let signature = send(rpc, &ixs, payer_and_mint_authority, &[payer_and_mint_authority])?;
    log_address(&format!("token account for {owner}"), &ata);
    log_signature(&format!("create ATA and mint {amount} tokens tx"), &signature);
    Ok(ata)
}

fn ensure_subscription_authority(
    rpc: &RpcClient,
    user: &Keypair,
    token_mint: &Pubkey,
    user_ata: &Pubkey,
    payer: Option<&Keypair>,
) -> Result<Pubkey> {
    let subscription_authority = subscription_authority_pda(&user.pubkey(), token_mint);
    if rpc.get_account(&subscription_authority).is_err() {
        let mut builder = InitSubscriptionAuthorityBuilder::new();
        builder
            .owner(user.pubkey())
            .subscription_authority(subscription_authority)
            .token_mint(*token_mint)
            .user_ata(*user_ata)
            .token_program(spl_token::id());
        let signature = if let Some(payer) = payer {
            builder.add_remaining_account(AccountMeta::new(payer.pubkey(), true));
            let init_ix = builder.instruction();
            send(rpc, &[init_ix], user, &[user, payer])?
        } else {
            let init_ix = builder.instruction();
            send(rpc, &[init_ix], user, &[user])?
        };
        log_signature("init subscription authority tx", &signature);
    }
    log_address("subscription authority PDA", &subscription_authority);
    Ok(subscription_authority)
}

fn close_subscription_authority(
    rpc: &RpcClient,
    user: &Keypair,
    token_mint: &Pubkey,
    rent_receiver: Option<&Pubkey>,
    label: &str,
) -> Result<()> {
    let subscription_authority = subscription_authority_pda(&user.pubkey(), token_mint);
    let receiver_balance_before = rent_receiver.map(|receiver| rpc.get_balance(receiver)).transpose()?;
    let mut builder = CloseSubscriptionAuthorityBuilder::new();
    builder.user(user.pubkey()).subscription_authority(subscription_authority);
    if let Some(receiver) = rent_receiver {
        builder.add_remaining_account(AccountMeta::new(*receiver, false));
    }
    let close_ix = builder.instruction();
    let signature = send(rpc, &[close_ix], user, &[user])?;
    log_signature(&format!("{label}close subscription authority tx"), &signature);
    anyhow::ensure!(
        rpc.get_account(&subscription_authority).is_err(),
        "{label}subscription authority close check failed"
    );
    if let (Some(receiver), Some(before)) = (rent_receiver, receiver_balance_before) {
        let after = rpc.get_balance(receiver)?;
        anyhow::ensure!(after > before, "{label}subscription authority rent receiver check failed");
    }
    Ok(())
}

fn send(rpc: &RpcClient, instructions: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<Signature> {
    let blockhash = rpc.get_latest_blockhash()?;
    let tx = Transaction::new_signed_with_payer(instructions, Some(&payer.pubkey()), signers, blockhash);
    rpc.send_and_confirm_transaction(&tx).context("send_and_confirm_transaction failed")
}

fn token_balance(rpc: &RpcClient, ata: &Pubkey) -> Result<u64> {
    let balance = rpc.get_token_account_balance(ata)?;
    balance.amount.parse::<u64>().context("failed to parse token account balance")
}

trait DecodeAccount: Sized {
    fn decode(data: &[u8]) -> Result<Self>;
}

impl DecodeAccount for FixedDelegation {
    fn decode(data: &[u8]) -> Result<Self> {
        Ok(FixedDelegation::from_bytes(data)?)
    }
}

impl DecodeAccount for RecurringDelegation {
    fn decode(data: &[u8]) -> Result<Self> {
        Ok(RecurringDelegation::from_bytes(data)?)
    }
}

impl DecodeAccount for SubscriptionDelegation {
    fn decode(data: &[u8]) -> Result<Self> {
        Ok(SubscriptionDelegation::from_bytes(data)?)
    }
}

impl DecodeAccount for Plan {
    fn decode(data: &[u8]) -> Result<Self> {
        Ok(Plan::from_bytes(data)?)
    }
}

fn decode_account<T: DecodeAccount>(rpc: &RpcClient, address: &Pubkey) -> Result<T> {
    let account = rpc.get_account(address)?;
    T::decode(&account.data)
}

fn subscription_authority_pda(user: &Pubkey, mint: &Pubkey) -> Pubkey {
    to_pubkey(
        Address::find_program_address(
            &[b"SubscriptionAuthority", user.as_ref(), mint.as_ref()],
            &to_address(SUBSCRIPTIONS_ID),
        )
        .0,
    )
}

fn fixed_delegation_pda(subscription_authority: &Pubkey, delegator: &Pubkey, delegatee: &Pubkey, nonce: u64) -> Pubkey {
    to_pubkey(
        Address::find_program_address(
            &[
                b"delegation",
                subscription_authority.as_ref(),
                delegator.as_ref(),
                delegatee.as_ref(),
                &nonce.to_le_bytes(),
            ],
            &to_address(SUBSCRIPTIONS_ID),
        )
        .0,
    )
}

fn plan_pda(merchant: &Pubkey, plan_id: u64) -> (Pubkey, u8) {
    let (address, bump) = Address::find_program_address(
        &[b"plan", merchant.as_ref(), &plan_id.to_le_bytes()],
        &to_address(SUBSCRIPTIONS_ID),
    );
    (to_pubkey(address), bump)
}

fn subscription_pda(plan_pda: &Pubkey, subscriber: &Pubkey) -> Pubkey {
    to_pubkey(
        Address::find_program_address(
            &[b"subscription", plan_pda.as_ref(), subscriber.as_ref()],
            &to_address(SUBSCRIPTIONS_ID),
        )
        .0,
    )
}

fn to_address(pubkey: Pubkey) -> Address {
    Address::new_from_array(pubkey.to_bytes())
}

fn to_pubkey(address: Address) -> Pubkey {
    Pubkey::new_from_array(address.to_bytes())
}

fn unix_timestamp() -> Result<i64> {
    Ok(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64)
}

fn explorer_address(address: &Pubkey) -> String {
    format!("https://explorer.solana.com/address/{address}?cluster=devnet")
}

fn explorer_tx(signature: &Signature) -> String {
    format!("https://explorer.solana.com/tx/{signature}?cluster=devnet")
}

fn log_section(title: &str) {
    println!("\n## {title}");
}

fn log_address(label: &str, address: &Pubkey) {
    println!("{label}: {address}");
    println!("{label} Explorer: {}", explorer_address(address));
}

fn log_signature(label: &str, signature: &Signature) {
    println!("{label}: {signature}");
    println!("{label} Explorer: {}", explorer_tx(signature));
}
