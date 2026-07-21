use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

use crate::{
    tests::{
        asserts::TransactionResultExt,
        constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
        pda::{get_plan_pda, get_subscription_pda},
        utils::{
            advance_slots, current_ts, days, init_ata, init_mint, init_wallet,
            initialize_subscription_authority_action, move_clock_forward, setup, CloseSubscriptionAuthority,
            CreatePlan, RevokeAbandonedSubscription, Subscribe,
        },
    },
    SubscriptionsError,
};

/// Creates a sponsor-funded subscription and returns
/// `(litesvm, subscriber, sponsor, mint, plan_pda)`.
fn setup_sponsored_subscription() -> (litesvm::LiteSVM, Keypair, Keypair, Pubkey, Pubkey) {
    let (mut litesvm, subscriber) = setup();
    let merchant = init_wallet(&mut litesvm, 10_000_000_000);
    let sponsor = init_wallet(&mut litesvm, 10_000_000_000);

    let mint = init_mint(&mut litesvm, TOKEN_PROGRAM_ID, MINT_DECIMALS, 1_000_000_000, Some(subscriber.pubkey()), &[]);
    let _subscriber_ata = init_ata(&mut litesvm, mint, subscriber.pubkey(), 100_000_000);

    initialize_subscription_authority_action(&mut litesvm, &subscriber, mint).0.assert_ok();

    let end_ts = current_ts() + days(30) as i64;
    let (res, plan_pda) = CreatePlan::new(&mut litesvm, &merchant, mint)
        .plan_id(1)
        .amount(50_000_000)
        .period_hours(1)
        .end_ts(end_ts)
        .execute();
    res.assert_ok();

    let (_, plan_bump) = get_plan_pda(&merchant.pubkey(), 1);
    // Sponsor funds the subscription rent => subscription header.payer == sponsor.
    Subscribe::new(&mut litesvm, &subscriber, merchant.pubkey(), plan_pda, 1, plan_bump, mint)
        .payer(&sponsor)
        .execute()
        .assert_ok();

    (litesvm, subscriber, sponsor, mint, plan_pda)
}

#[test]
fn sponsor_recovers_subscription_after_authority_rotated() {
    let (mut litesvm, subscriber, sponsor, mint, plan_pda) = setup_sponsored_subscription();
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &subscriber.pubkey());

    // Subscriber rotates their authority (close + reinit in a later slot => new init_id),
    // which permanently stales the subscription (transfers would fail StaleSubscriptionAuthority).
    CloseSubscriptionAuthority::new(&mut litesvm, &subscriber, mint).execute().assert_ok();
    move_clock_forward(&mut litesvm, 10);
    initialize_subscription_authority_action(&mut litesvm, &subscriber, mint).0.assert_ok();

    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    let subscription_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;

    RevokeAbandonedSubscription::new(&mut litesvm, &sponsor, subscriber.pubkey(), mint, plan_pda).execute().assert_ok();

    let after = litesvm.get_account(&subscription_pda);
    assert!(after.is_none() || after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_after >= sponsor_before + subscription_rent - 10_000);
}

#[test]
fn revoke_abandoned_subscription_rejects_same_slot_closure() {
    let (mut litesvm, subscriber, sponsor, mint, plan_pda) = setup_sponsored_subscription();

    // Authority closed in the same slot the subscription was created: a same-slot
    // re-init recreates the matching init_id, so it is not terminally abandoned.
    CloseSubscriptionAuthority::new(&mut litesvm, &subscriber, mint).execute().assert_ok();

    RevokeAbandonedSubscription::new(&mut litesvm, &sponsor, subscriber.pubkey(), mint, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn revoke_abandoned_subscription_recovers_after_authority_closed_slot_advanced() {
    let (mut litesvm, subscriber, sponsor, mint, plan_pda) = setup_sponsored_subscription();
    let (subscription_pda, _) = get_subscription_pda(&plan_pda, &subscriber.pubkey());

    // Authority closed and the creation slot has passed: the subscription is now
    // terminally abandoned (a same-slot re-init can no longer revive it), so the
    // sponsor can reclaim its rent.
    CloseSubscriptionAuthority::new(&mut litesvm, &subscriber, mint).execute().assert_ok();
    advance_slots(&mut litesvm, 1);

    let sponsor_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    let subscription_rent = litesvm.get_account(&subscription_pda).unwrap().lamports;

    RevokeAbandonedSubscription::new(&mut litesvm, &sponsor, subscriber.pubkey(), mint, plan_pda).execute().assert_ok();

    let after = litesvm.get_account(&subscription_pda);
    assert!(after.is_none() || after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0);

    let sponsor_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
    assert!(sponsor_after >= sponsor_before + subscription_rent - 10_000);
}

#[test]
fn revoke_abandoned_subscription_rejects_live_authority() {
    let (mut litesvm, subscriber, sponsor, mint, plan_pda) = setup_sponsored_subscription();

    // Authority still live with the same init_id the subscription recorded => billable, not abandoned.
    RevokeAbandonedSubscription::new(&mut litesvm, &sponsor, subscriber.pubkey(), mint, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}

#[test]
fn revoke_abandoned_subscription_rejects_unbound_authority() {
    let (mut litesvm, subscriber, sponsor, mint, plan_pda) = setup_sponsored_subscription();

    // Supplying an authority that is not the canonical (subscriber, plan-mint) PDA is rejected,
    // even if it is closed/stale -- prevents spoofing abandonment with an unrelated-mint authority.
    RevokeAbandonedSubscription::new(&mut litesvm, &sponsor, subscriber.pubkey(), mint, plan_pda)
        .authority(Pubkey::new_unique())
        .execute()
        .assert_err(SubscriptionsError::InvalidSubscriptionAuthorityPda);
}

#[test]
fn revoke_abandoned_subscription_rejects_non_sponsor_caller() {
    let (mut litesvm, subscriber, _sponsor, mint, plan_pda) = setup_sponsored_subscription();
    let stranger = init_wallet(&mut litesvm, 10_000_000_000);

    CloseSubscriptionAuthority::new(&mut litesvm, &subscriber, mint).execute().assert_ok();
    move_clock_forward(&mut litesvm, 10);
    initialize_subscription_authority_action(&mut litesvm, &subscriber, mint).0.assert_ok();

    // Even with a genuinely abandoned authority, only the recorded payer may reclaim rent.
    RevokeAbandonedSubscription::new(&mut litesvm, &stranger, subscriber.pubkey(), mint, plan_pda)
        .execute()
        .assert_err(SubscriptionsError::Unauthorized);
}
