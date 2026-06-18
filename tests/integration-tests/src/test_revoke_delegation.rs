use solana_pubkey::Pubkey;
use solana_signer::Signer;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        utils::{
            current_ts, days, hours, init_ata, init_mint, init_wallet, initialize_subscription_authority_action,
            move_clock_forward, setup, setup_with_subscription, CancelSubscription, CreateDelegation,
            CreateSubscription, RevokeDelegation, RevokeSubscription, TransferDelegation,
        },
    },
    AccountDiscriminator, FixedDelegation, RecurringDelegation, SubscriptionsError,
};

#[test]
fn revoke_fixed_delegation() {
    let (litesvm, user) = &mut setup();
    let payer = user;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).fixed(100, current_ts() + 1000);
    res.assert_ok();

    let account_before = litesvm.get_account(&delegation_pda);
    assert!(account_before.is_some());
    let binding = account_before.unwrap();
    let delegation_rent = binding.lamports;
    let delegation = FixedDelegation::load(&binding.data).unwrap();
    assert_eq!(delegation.header.discriminator, AccountDiscriminator::FixedDelegation as u8);

    let delegator_balance_before = litesvm.get_account(&payer.pubkey()).unwrap().lamports;

    let res = RevokeDelegation::new(litesvm, payer, mint, delegatee, nonce).execute();
    res.assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let delegator_balance_after = litesvm.get_account(&payer.pubkey()).unwrap().lamports;
    assert!(delegator_balance_after > delegator_balance_before);
    assert!(delegator_balance_after >= delegator_balance_before + delegation_rent - 10000);
}

#[test]
fn revoke_recurring_delegation() {
    let (litesvm, user) = &mut setup();
    let payer = user;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let epoch = days(1);
    let expiry_ts = current_ts() + days(2) as i64;
    let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        100,
        epoch,
        current_ts(),
        expiry_ts,
    );
    res.assert_ok();

    let account_before = litesvm.get_account(&delegation_pda);
    assert!(account_before.is_some());
    let binding = account_before.unwrap();
    let delegation_rent = binding.lamports;
    let delegation = RecurringDelegation::load(&binding.data).unwrap();
    assert_eq!(delegation.header.discriminator, AccountDiscriminator::RecurringDelegation as u8);

    let delegator_balance_before = litesvm.get_account(&payer.pubkey()).unwrap().lamports;

    let res = RevokeDelegation::new(litesvm, payer, mint, delegatee, nonce).execute();
    res.assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let delegator_balance_after = litesvm.get_account(&payer.pubkey()).unwrap().lamports;
    assert!(delegator_balance_after > delegator_balance_before);
    assert!(delegator_balance_after >= delegator_balance_before + delegation_rent - 10000);
}

#[test]
fn non_delegator_cannot_revoke() {
    let (litesvm, user) = &mut setup();
    let payer = user;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let epoch = days(1);
    let expiry_ts = current_ts() + days(2) as i64;
    let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).recurring(
        100,
        epoch,
        current_ts(),
        expiry_ts,
    );
    res.assert_ok();

    let attacker = init_wallet(litesvm, 1_000_000_000);
    let (subscription_authority_pda, _) = crate::tests::pda::get_subscription_authority_pda(&payer.pubkey(), &mint);
    let res = revoke_delegation_action_with_pda(litesvm, &attacker, delegation_pda, subscription_authority_pda);
    assert!(res.is_err());

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_some());
    assert!(account_after.as_ref().map(|a| a.lamports).unwrap_or(0) > 0);
}

#[test]
fn closed_account_is_zeroed() {
    let (litesvm, user) = &mut setup();
    let payer = user;

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).fixed(100, current_ts() + 1000);
    res.assert_ok();

    let account_before = litesvm.get_account(&delegation_pda);
    let _before_data = account_before.as_ref().unwrap().data.clone();

    let res = RevokeDelegation::new(litesvm, payer, mint, delegatee, nonce).execute();
    res.assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);

    if let Some(account) = account_after {
        assert!(account.data.iter().all(|&byte| byte == 0), "All data should be zeroed after close");
    }
}

#[test]
fn revoke_with_wrong_receiver_returns_unauthorized() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);
    let wrong_receiver = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, _) = CreateDelegation::new(litesvm, delegator, mint, delegatee)
        .payer(&sponsor)
        .nonce(nonce)
        .fixed(100, current_ts() + 1000);
    res.assert_ok();

    let result =
        RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce).receiver(wrong_receiver.pubkey()).execute();

    result.assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn writable_accounts_must_be_writable() {
    use solana_instruction::{AccountMeta, Instruction};

    use crate::{
        instructions::revoke_delegation,
        tests::{
            constants::PROGRAM_ID,
            idl,
            utils::{build_and_send_transaction, init_wallet},
        },
    };

    let writable = idl::writable_account_indices("revokeDelegation");

    let (litesvm, user) = &mut setup();
    let payer = user;
    let fee_payer = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).fixed(100, current_ts() + 1000);
    res.assert_ok();

    for (idx, _name, is_signer) in &writable {
        let mut accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(delegation_pda, false)];

        // Flip writable account to readonly, preserving signer flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*revoke_delegation::DISCRIMINATOR] };

        let res = build_and_send_transaction(litesvm, &[&fee_payer, payer], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::AccountNotWritable);
    }
}

#[test]
fn signer_accounts_must_be_signers() {
    use solana_instruction::{AccountMeta, Instruction};

    use crate::{
        instructions::revoke_delegation,
        tests::{
            constants::PROGRAM_ID,
            idl,
            utils::{build_and_send_transaction, init_wallet},
        },
    };

    let signers = idl::signer_account_indices("revokeDelegation");

    let (litesvm, user) = &mut setup();
    let payer = user;
    let fee_payer = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(payer.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, payer, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, payer, mint, delegatee).nonce(nonce).fixed(100, current_ts() + 1000);
    res.assert_ok();

    for (idx, _name, is_writable) in &signers {
        let mut accounts = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(delegation_pda, false)];

        // Flip signer to non-signer, preserving writable flag
        let pubkey = accounts[*idx].pubkey;
        accounts[*idx] =
            if *is_writable { AccountMeta::new(pubkey, false) } else { AccountMeta::new_readonly(pubkey, false) };

        let ix = Instruction { program_id: PROGRAM_ID, accounts, data: vec![*revoke_delegation::DISCRIMINATOR] };

        let res = build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
        res.assert_err(SubscriptionsError::NotSigner);
    }
}

#[test]
fn revoke_subscription_without_cancel_rejected() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    // Try to revoke without cancelling first
    let result = RevokeSubscription::new(&mut litesvm, &alice, subscription_pda, plan_pda).execute();
    result.assert_err(SubscriptionsError::SubscriptionNotCancelled);

    // Account should still exist
    let account = litesvm.get_account(&subscription_pda);
    assert!(account.is_some());
}

#[test]
fn revoke_subscription_after_cancel_succeeds() {
    let (mut litesvm, alice, _merchant, _mint, plan_pda, _plan_bump, subscription_pda) = setup_with_subscription();

    let balance_before = litesvm.get_account(&alice.pubkey()).unwrap().lamports;

    // Cancel first
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Advance clock past the expiration (plan has 1h period)
    move_clock_forward(&mut litesvm, hours(1));

    // Then revoke
    RevokeSubscription::new(&mut litesvm, &alice, subscription_pda, plan_pda).execute().assert_ok();

    // Account should be closed
    let account = litesvm.get_account(&subscription_pda);
    assert!(
        account.is_none() || account.as_ref().map(|a| a.lamports).unwrap_or(0) == 0,
        "Subscription PDA should be closed"
    );

    // Rent should be returned
    let balance_after = litesvm.get_account(&alice.pubkey()).unwrap().lamports;
    assert!(balance_after > balance_before - 10000);
}

#[test]
fn revoke_subscription_with_future_expires_at_ts_rejected() {
    let (mut litesvm, alice, _merchant, mint, plan_pda, _, _subscription_pda) = setup_with_subscription();

    // Manually inject a subscription with expires_at_ts in the future
    let subscription_pda = CreateSubscription::new(&mut litesvm, plan_pda, alice.pubkey(), mint, current_ts())
        .expires_at_ts(current_ts() + days(1) as i64)
        .execute();

    let result = RevokeSubscription::new(&mut litesvm, &alice, subscription_pda, plan_pda).execute();
    result.assert_err(SubscriptionsError::SubscriptionNotCancelled);

    // Account should still exist
    let account = litesvm.get_account(&subscription_pda);
    assert!(account.is_some());
}

#[test]
fn test_revoke_fixed_version_agnostic() {
    use crate::state::header::VERSION_OFFSET;

    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, user, mint, delegatee).nonce(nonce).fixed(100, current_ts() + 1000);
    res.assert_ok();

    let mut account = litesvm.get_account(&delegation_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(delegation_pda, account).unwrap();

    RevokeDelegation::new(litesvm, user, mint, delegatee, nonce).execute().assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);
}

#[test]
fn test_revoke_recurring_version_agnostic() {
    use crate::state::header::VERSION_OFFSET;

    let (litesvm, user) = &mut setup();

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(user.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, user, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, delegation_pda) = CreateDelegation::new(litesvm, user, mint, delegatee).nonce(nonce).recurring(
        100,
        days(1),
        current_ts(),
        current_ts() + days(2) as i64,
    );
    res.assert_ok();

    let mut account = litesvm.get_account(&delegation_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(delegation_pda, account).unwrap();

    RevokeDelegation::new(litesvm, user, mint, delegatee, nonce).execute().assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);
}

#[test]
fn test_revoke_subscription_version_mismatch() {
    use crate::state::header::VERSION_OFFSET;

    let (mut litesvm, alice, _merchant, _mint, plan_pda, _, subscription_pda) = setup_with_subscription();

    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    move_clock_forward(&mut litesvm, hours(1));

    let mut account = litesvm.get_account(&subscription_pda).unwrap();
    account.data[VERSION_OFFSET] = 0;
    litesvm.set_account(subscription_pda, account).unwrap();

    RevokeSubscription::new(&mut litesvm, &alice, subscription_pda, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::MigrationRequired);
}

#[test]
fn sponsor_can_revoke_expired_fixed_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + hours(1) as i64;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, expiry_ts);
    res.assert_ok();

    let delegation_rent = litesvm.get_account(&delegation_pda).unwrap().lamports;

    move_clock_forward(litesvm, hours(2));

    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce).signer(&sponsor).execute().assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + delegation_rent - 10000);
}

#[test]
fn sponsor_can_revoke_expired_recurring_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + days(2) as i64;

    let (res, delegation_pda) = CreateDelegation::new(litesvm, delegator, mint, delegatee)
        .payer(&sponsor)
        .nonce(nonce)
        .recurring(100, days(1), current_ts(), expiry_ts);
    res.assert_ok();

    let delegation_rent = litesvm.get_account(&delegation_pda).unwrap().lamports;

    move_clock_forward(litesvm, days(3));

    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce).signer(&sponsor).execute().assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + delegation_rent - 10000);
}

#[test]
fn sponsor_cannot_revoke_non_expired_fixed_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + hours(2) as i64;

    let (res, _) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, expiry_ts);
    res.assert_ok();

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
        .signer(&sponsor)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn sponsor_cannot_revoke_non_expired_recurring_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + days(2) as i64;

    let (res, _) = CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).recurring(
        100,
        days(1),
        current_ts(),
        expiry_ts,
    );
    res.assert_ok();

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
        .signer(&sponsor)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn sponsor_cannot_revoke_no_expiry_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;

    let (res, _) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, 0);
    res.assert_ok();

    move_clock_forward(litesvm, days(365));

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
        .signer(&sponsor)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn sponsor_cannot_revoke_within_drift_window() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + 100;

    let (res, _) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, expiry_ts);
    res.assert_ok();

    // 110s after creation: past expiry but still within 120s drift window.
    move_clock_forward(litesvm, 110);

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
        .signer(&sponsor)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);

    // Past the drift window: sponsor can revoke.
    move_clock_forward(litesvm, 121);

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce).signer(&sponsor).execute().assert_ok();
}

#[test]
fn delegator_can_revoke_sponsor_funded_before_expiry() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + hours(2) as i64;

    let (res, delegation_pda) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, expiry_ts);
    res.assert_ok();

    let delegation_rent = litesvm.get_account(&delegation_pda).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce).receiver(sponsor.pubkey()).execute().assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + delegation_rent - 10000);
}

#[test]
fn attacker_cannot_revoke_sponsor_funded_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);
    let attacker = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let delegatee = Pubkey::new_unique();
    let nonce: u64 = 0;
    let expiry_ts = current_ts() + hours(1) as i64;

    let (res, _) =
        CreateDelegation::new(litesvm, delegator, mint, delegatee).payer(&sponsor).nonce(nonce).fixed(100, expiry_ts);
    res.assert_ok();

    move_clock_forward(litesvm, hours(2));

    // Attacker passes sponsor as receiver to try to close the account
    RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
        .signer(&attacker)
        .receiver(sponsor.pubkey())
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn sponsor_can_revoke_fully_spent_fixed_delegation() {
    let (litesvm, user) = &mut setup();
    let delegator = user;
    let sponsor = init_wallet(litesvm, 10_000_000_000);
    let delegatee = init_wallet(litesvm, 10_000_000_000);

    let mint = init_mint(litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(delegator.pubkey()), &[]);
    let _delegator_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);
    let _delegatee_ata = init_ata(litesvm, mint, delegatee.pubkey(), 0);

    initialize_subscription_authority_action(litesvm, delegator, mint).0.assert_ok();

    let nonce: u64 = 0;
    let amount: u64 = 100;
    // Far-future expiry so recovery cannot rely on expiry -- only on amount == 0.
    let expiry_ts = current_ts() + hours(24) as i64;

    let (res, delegation_pda) = CreateDelegation::new(litesvm, delegator, mint, delegatee.pubkey())
        .payer(&sponsor)
        .nonce(nonce)
        .fixed(amount, expiry_ts);
    res.assert_ok();

    // Not expired and amount > 0: sponsor cannot recover yet.
    RevokeDelegation::new(litesvm, delegator, mint, delegatee.pubkey(), nonce)
        .signer(&sponsor)
        .receiver(sponsor.pubkey())
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);

    // Spend the delegation to zero.
    TransferDelegation::new(litesvm, &delegatee, delegator.pubkey(), mint, delegation_pda)
        .amount(amount)
        .fixed()
        .assert_ok();

    // amount == 0 is terminal: sponsor can recover rent even though not expired.
    RevokeDelegation::new(litesvm, delegator, mint, delegatee.pubkey(), nonce)
        .signer(&sponsor)
        .receiver(sponsor.pubkey())
        .execute()
        .assert_ok();

    let account_after = litesvm.get_account(&delegation_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);
}

#[allow(clippy::result_large_err)]
fn revoke_delegation_action_with_pda(
    litesvm: &mut litesvm::LiteSVM,
    signer: &solana_keypair::Keypair,
    delegation_pda: Pubkey,
    _subscription_authority_pda: Pubkey,
) -> litesvm::types::TransactionResult {
    use solana_instruction::{AccountMeta, Instruction};
    use solana_signer::Signer;

    use crate::{
        instructions::revoke_delegation,
        tests::{constants::PROGRAM_ID, utils::build_and_send_transaction},
    };

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(signer.pubkey(), true), AccountMeta::new(delegation_pda, false)],
        data: vec![*revoke_delegation::DISCRIMINATOR],
    };

    build_and_send_transaction(litesvm, &[signer], &signer.pubkey(), &ix)
}

/// Helper: spin up a sponsor-funded subscription, returning everything callers
/// need to drive subsequent revoke-subscription tests.
fn setup_sponsored_subscription(
    plan_end_ts: i64,
) -> (
    litesvm::LiteSVM,
    solana_keypair::Keypair, // alice (subscriber)
    solana_keypair::Keypair, // merchant
    solana_keypair::Keypair, // sponsor
    Pubkey,                  // plan_pda
    Pubkey,                  // subscription_pda
) {
    use crate::tests::{
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        pda::get_subscription_pda,
        utils::{
            init_ata, init_mint, init_wallet, initialize_subscription_authority_action, setup, CreatePlan, Subscribe,
        },
    };

    let (mut litesvm, alice) = setup();
    let merchant = solana_keypair::Keypair::new();
    litesvm.airdrop(&merchant.pubkey(), 10_000_000_000).unwrap();
    let sponsor = init_wallet(&mut litesvm, 10_000_000_000);

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(alice.pubkey()), &[]);
    let _alice_ata = init_ata(&mut litesvm, mint, alice.pubkey(), 100_000_000);

    initialize_subscription_authority_action(&mut litesvm, &alice, mint).0.assert_ok();

    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(plan_end_ts)
        .execute();
    res.assert_ok();

    let (_, plan_bump) = crate::tests::pda::get_plan_pda(&merchant.pubkey(), 1);

    Subscribe::new(&mut litesvm, &alice, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .payer(&sponsor)
        .execute()
        .assert_ok();

    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &alice.pubkey());
    (litesvm, alice, merchant, sponsor, plan_pda, subscription_pda)
}

#[test]
fn sponsor_revoke_subscription_when_plan_ended() {
    let plan_end_ts = current_ts() + hours(2) as i64;
    let (mut litesvm, _alice, _merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    let sub_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    // Move past plan end.
    move_clock_forward(&mut litesvm, hours(3));

    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, plan_pda).execute().assert_ok();

    let account_after = litesvm.get_account(&subscription_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + sub_rent - 10_000);
}

#[test]
fn sponsor_revoke_subscription_when_plan_closed() {
    use crate::{state::common::PlanStatus, tests::utils::DeletePlan};

    let plan_end_ts = current_ts() + hours(2) as i64;
    let (mut litesvm, _alice, merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Sunset, expire, and delete the plan.
    crate::tests::utils::UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
        .status(PlanStatus::Sunset)
        .end_ts(plan_end_ts)
        .execute()
        .assert_ok();

    move_clock_forward(&mut litesvm, hours(3));

    DeletePlan::new(&mut litesvm, &merchant, plan_pda).execute().assert_ok();

    // Plan account is now system-owned (closed). Sponsor can revoke.
    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, plan_pda).execute().assert_ok();

    let account_after = litesvm.get_account(&subscription_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);
}

#[test]
fn sponsor_revoke_subscription_when_plan_recreated_with_different_terms() {
    // Same-address ghost plan: merchant deletes the expired plan and
    // recreates it under the same `plan_id` with different terms. The
    // subscription is no longer pull-eligible (transfers fail via
    // `check_plan_terms`), and the sponsor should be able to recover rent
    // unilaterally even though `plan_closed` is false on the recreated PDA.
    use crate::{state::common::PlanStatus, tests::utils::DeletePlan};

    let plan_end_ts = current_ts() + hours(2) as i64;
    let (mut litesvm, _alice, merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Sunset, expire, delete.
    crate::tests::utils::UpdatePlan::new(&mut litesvm, &merchant, plan_pda)
        .status(PlanStatus::Sunset)
        .end_ts(plan_end_ts)
        .execute()
        .assert_ok();

    move_clock_forward(&mut litesvm, hours(3));

    DeletePlan::new(&mut litesvm, &merchant, plan_pda).execute().assert_ok();

    // Recreate the same plan_id with different terms (ghost plan). End_ts
    // is in the future so neither plan_ended nor plan_closed would fire.
    let new_end_ts = current_ts() + days(60) as i64;
    let mint = init_mint(
        &mut litesvm,
        crate::tests::constants::TOKEN_PROGRAM_ID,
        crate::tests::constants::MINT_DECIMALS,
        1_000_000_000,
        None,
        &[],
    );
    let (res, recreated_plan_pda) = crate::tests::utils::CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(999_000_000)
        .period_hours(720)
        .end_ts(new_end_ts)
        .execute();
    res.assert_ok();
    assert_eq!(recreated_plan_pda, plan_pda);

    let sub_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, plan_pda).execute().assert_ok();

    let account_after = litesvm.get_account(&subscription_pda);
    assert!(account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + sub_rent - 10_000);
}

#[test]
fn sponsor_revoke_subscription_when_cancelled_and_expired() {
    let plan_end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, _merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Subscriber cancels.
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();

    // Wait for the cancellation period to end.
    move_clock_forward(&mut litesvm, hours(2));

    let sub_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, plan_pda).execute().assert_ok();

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + sub_rent - 10_000);
}

#[test]
fn sponsor_revoke_active_subscription_rejected() {
    let plan_end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, _alice, _merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Plan still active, subscription not cancelled. Sponsor cannot revoke.
    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn sponsor_revoke_subscription_with_wrong_plan_pda_rejected() {
    let plan_end_ts = current_ts() + hours(2) as i64;
    let (mut litesvm, _alice, merchant, sponsor, _plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Create a second, unrelated plan.
    let mint = init_mint(
        &mut litesvm,
        crate::tests::constants::TOKEN_PROGRAM_ID,
        crate::tests::constants::MINT_DECIMALS,
        1_000_000_000,
        None,
        &[],
    );
    let other_plan_end = current_ts() + days(60) as i64;
    let (res, other_plan_pda) = crate::tests::utils::CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(99)
        .amount(1_000)
        .period_hours(24)
        .end_ts(other_plan_end)
        .execute();
    res.assert_ok();

    move_clock_forward(&mut litesvm, hours(3));

    RevokeSubscription::new(&mut litesvm, &sponsor, subscription_pda, other_plan_pda)
        .execute()
        .assert_err(SubscriptionsError::SubscriptionPlanMismatch);
}

#[test]
fn attacker_cannot_revoke_sponsor_funded_subscription() {
    let plan_end_ts = current_ts() + hours(2) as i64;
    let (mut litesvm, _alice, _merchant, _sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    let attacker = init_wallet(&mut litesvm, 10_000_000_000);

    // Even after the plan expires, an attacker (not delegator and not payer)
    // must not be able to revoke.
    move_clock_forward(&mut litesvm, hours(3));

    RevokeSubscription::new(&mut litesvm, &attacker, subscription_pda, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn subscriber_revoke_routes_rent_to_sponsor() {
    let plan_end_ts = current_ts() + days(30) as i64;
    let (mut litesvm, alice, _merchant, sponsor, plan_pda, subscription_pda) =
        setup_sponsored_subscription(plan_end_ts);

    // Subscriber cancels and waits.
    CancelSubscription::new(&mut litesvm, &alice, plan_pda, subscription_pda).execute().assert_ok();
    move_clock_forward(&mut litesvm, hours(2));

    let sub_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;
    let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

    // Subscriber revokes but receiver = sponsor (because header.payer = sponsor).
    RevokeSubscription::new(&mut litesvm, &alice, subscription_pda, plan_pda)
        .receiver(sponsor.pubkey())
        .execute()
        .assert_ok();

    let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_balance_after >= sponsor_balance_before + sub_rent - 10_000);
}
