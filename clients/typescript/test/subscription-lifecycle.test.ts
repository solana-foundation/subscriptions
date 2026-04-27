import { describe, expect, test } from 'vitest';
import { SUBSCRIPTIONS_ERROR__PLAN_TERMS_MISMATCH } from '../src/generated/errors/subscriptions.ts';
import {
  fetchMaybePlan,
  fetchMaybeSubscriptionDelegation,
  fetchSubscriptionDelegation,
  PlanStatus,
} from '../src/generated/index.ts';
import {
  DEFAULT_TEST_BALANCE,
  expectProgramError,
  initTestSuite,
} from './setup.ts';

describe('Subscription Lifecycle', () => {
  test('full lifecycle: create, subscribe, pull, cancel, sunset, delete', async () => {
    const t = await initTestSuite();
    const planAmount = 500_000n;
    const periodHours = 1n;

    // 1. Merchant creates a plan
    const { planPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 1n,
      mint: t.tokenMint,
      amount: planAmount,
      periodHours,
      endTs: 0n,
      destinations: [],
      pullers: [],
      metadataUri: 'https://example.com/plan.json',
    });

    // 2. Subscriber sets up and subscribes
    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.initSubscriptionAuthority({
      owner: subscriber,
      tokenMint: t.tokenMint,
      userAta: subscriberAta,
      tokenProgram: t.tokenProgram,
    });

    const { subscriptionPda } = await t.client.subscribe({
      subscriber,
      merchant: t.payerKeypair.address,
      planId: 1n,
      tokenMint: t.tokenMint,
    });

    // Verify subscription state
    const subAfterSubscribe = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterSubscribe.header.delegator).toBe(subscriber.address);
    expect(subAfterSubscribe.amountPulledInPeriod).toBe(0n);
    expect(subAfterSubscribe.expiresAtTs).toBe(0n);

    // 3. Merchant pulls funds
    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    const pullAmount = 200_000n;
    await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscriber.address,
      tokenMint: t.tokenMint,
      subscriptionPda,
      planPda,
      amount: pullAmount,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });

    const merchantBalance = await t.rpc
      .getTokenAccountBalance(merchantAta)
      .send();
    expect(merchantBalance.value.amount).toBe(pullAmount.toString());

    const subAfterPull = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterPull.amountPulledInPeriod).toBe(pullAmount);

    // 4. Subscriber cancels
    await t.client.cancelSubscription({
      subscriber,
      planPda,
      subscriptionPda,
    });

    const subAfterCancel = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterCancel.expiresAtTs).not.toBe(0n);

    // 5. Merchant sunsets the plan
    const endTs = await t.minPlanEndTs(periodHours);

    await t.client.updatePlan({
      owner: t.payerKeypair,
      planPda,
      status: PlanStatus.Sunset,
      endTs,
      metadataUri: 'https://example.com/plan.json',
    });

    // 6. Time-travel past endTs, then delete the plan
    await t.timeTravel(Number(endTs) + 60);

    const { signature: deleteSig } = await t.client.deletePlan({
      owner: t.payerKeypair,
      planPda,
    });
    expect(deleteSig).toBeDefined();

    const planAfterDelete = await fetchMaybePlan(t.rpc, planPda);
    expect(planAfterDelete.exists).toBe(false);
  });

  test('whitelisted puller can transfer', async () => {
    const t = await initTestSuite();
    const puller = await t.createFundedKeypair();

    // 1. Merchant creates plan with a whitelisted puller
    const { planPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 1n,
      mint: t.tokenMint,
      amount: 1_000_000n,
      periodHours: 1n,
      endTs: 0n,
      destinations: [],
      pullers: [puller.address],
      metadataUri: 'https://example.com/plan.json',
    });

    // 2. Subscriber subscribes
    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.initSubscriptionAuthority({
      owner: subscriber,
      tokenMint: t.tokenMint,
      userAta: subscriberAta,
      tokenProgram: t.tokenProgram,
    });

    const { subscriptionPda } = await t.client.subscribe({
      subscriber,
      merchant: t.payerKeypair.address,
      planId: 1n,
      tokenMint: t.tokenMint,
    });

    // 3. Puller (not the merchant) pulls funds
    const pullerAta = await t.createAtaWithBalance(
      t.tokenMint,
      puller.address,
      0n,
    );

    const pullAmount = 100_000n;
    const { signature } = await t.client.transferSubscription({
      caller: puller,
      delegator: subscriber.address,
      tokenMint: t.tokenMint,
      subscriptionPda,
      planPda,
      amount: pullAmount,
      receiverAta: pullerAta,
      tokenProgram: t.tokenProgram,
    });

    expect(signature).toBeDefined();

    const balance = await t.rpc.getTokenAccountBalance(pullerAta).send();
    expect(balance.value.amount).toBe(pullAmount.toString());
  });

  test('ghost account attack is blocked and subscriber can recover', async () => {
    const t = await initTestSuite();

    // 1. Merchant creates plan
    const { planPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 10n,
      mint: t.tokenMint,
      amount: 500_000n,
      periodHours: 1n,
      endTs: 0n,
      destinations: [],
      pullers: [],
      metadataUri: 'https://example.com/plan.json',
    });

    // 2. Subscriber subscribes
    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.initSubscriptionAuthority({
      owner: subscriber,
      tokenMint: t.tokenMint,
      userAta: subscriberAta,
      tokenProgram: t.tokenProgram,
    });

    const { subscriptionPda } = await t.client.subscribe({
      subscriber,
      merchant: t.payerKeypair.address,
      planId: 10n,
      tokenMint: t.tokenMint,
    });

    // 3. Merchant sunsets, expires, and deletes the plan
    const endTs = await t.minPlanEndTs(1n);

    await t.client.updatePlan({
      owner: t.payerKeypair,
      planPda,
      status: PlanStatus.Sunset,
      endTs,
      metadataUri: 'https://example.com/plan.json',
    });

    await t.timeTravel(Number(endTs) + 5);

    await t.client.deletePlan({
      owner: t.payerKeypair,
      planPda,
    });

    // 4. Merchant recreates plan with same planId but different terms (ghost)
    const { planPda: ghostPlanPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 10n,
      mint: t.tokenMint,
      amount: 999_000_000n,
      periodHours: 720n,
      endTs: 0n,
      destinations: [],
      pullers: [],
      metadataUri: 'https://example.com/ghost.json',
    });

    expect(ghostPlanPda).toBe(planPda);

    // 5. Transfer is blocked with PlanTermsMismatch
    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    await expectProgramError(
      t.client.transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__PLAN_TERMS_MISMATCH,
    );

    // 6. Subscriber cancels (immediate expiry, no grace period)
    await t.client.cancelSubscription({
      subscriber,
      planPda,
      subscriptionPda,
    });

    const subAfterCancel = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterCancel.expiresAtTs).not.toBe(0n);

    // 7. Subscriber revokes delegation, getting rent back
    const { signature: revokeSig } = await t.client.revokeSubscription({
      authority: subscriber,
      subscriptionPda,
      planPda,
    });
    expect(revokeSig).toBeDefined();

    // Subscription account should be closed
    const subAfterRevoke = await fetchMaybeSubscriptionDelegation(
      t.rpc,
      subscriptionPda,
    );
    expect(subAfterRevoke.exists).toBe(false);
  });
});
