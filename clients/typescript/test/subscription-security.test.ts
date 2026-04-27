import { describe, expect, test } from 'vitest';
import {
  SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
  SUBSCRIPTIONS_ERROR__PLAN_CLOSED,
  SUBSCRIPTIONS_ERROR__PLAN_EXPIRED,
  SUBSCRIPTIONS_ERROR__PLAN_IMMUTABLE_AFTER_SUNSET,
  SUBSCRIPTIONS_ERROR__PLAN_NOT_EXPIRED,
  SUBSCRIPTIONS_ERROR__PLAN_SUNSET,
  SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_ALREADY_CANCELLED,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_NOT_CANCELLED,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_PLAN_MISMATCH,
  SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
  SUBSCRIPTIONS_ERROR__UNAUTHORIZED_DESTINATION,
} from '../src/generated/errors/subscriptions.ts';
import {
  fetchMaybePlan,
  fetchMaybeSubscriptionDelegation,
  fetchSubscriptionDelegation,
  findPlanPda,
  findSubscriptionDelegationPda,
  PlanStatus,
} from '../src/generated/index.ts';
import {
  DEFAULT_TEST_BALANCE,
  expectProgramError,
  initTestSuite,
} from './setup.ts';

describe('Subscription Security', () => {
  test('revoke blocked during grace period, allowed after expiry', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    const subAfterCancel = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterCancel.expiresAtTs).not.toBe(0n);

    await expectProgramError(
      t.client.subscriptions.instructions
        .revokeSubscription({
          authority: subscriber,
          subscriptionPda,
          planPda,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__SUBSCRIPTION_NOT_CANCELLED,
    );

    await t.timeTravel(Number(subAfterCancel.expiresAtTs) + 60);

    const signature = await t.client.subscriptions.instructions
      .revokeSubscription({
        authority: subscriber,
        subscriptionPda,
        planPda,
      })
      .sendTransaction();
    expect(signature).toBeDefined();
  });

  test('unauthorized puller is rejected', async () => {
    const t = await initTestSuite();
    const authorizedPuller = await t.createFundedKeypair();
    const attacker = await t.createFundedKeypair();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [authorizedPuller.address],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const attackerAta = await t.createAtaWithBalance(
      t.tokenMint,
      attacker.address,
      0n,
    );

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: attacker,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 100_000n,
          receiverAta: attackerAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );

    const pullerAta = await t.createAtaWithBalance(
      t.tokenMint,
      authorizedPuller.address,
      0n,
    );
    const pullerSig = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: authorizedPuller,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: pullerAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(pullerSig).toBeDefined();

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );
    const merchantSig = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(merchantSig).toBeDefined();
  });

  test('destination whitelist is enforced', async () => {
    const t = await initTestSuite();

    const allowedReceiver = await t.createFundedKeypair();
    const allowedAta = await t.createAtaWithBalance(
      t.tokenMint,
      allowedReceiver.address,
      0n,
    );

    const unauthorizedReceiver = await t.createFundedKeypair();
    const unauthorizedAta = await t.createAtaWithBalance(
      t.tokenMint,
      unauthorizedReceiver.address,
      0n,
    );

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [allowedReceiver.address],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: t.payerKeypair,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 100_000n,
          receiverAta: unauthorizedAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED_DESTINATION,
    );

    const signature = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: allowedAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(signature).toBeDefined();
  });

  test('double subscription is blocked', async () => {
    const t = await initTestSuite();

    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .subscribe({
          subscriber,
          merchant: t.payerKeypair.address,
          planId: 1n,
          tokenMint: t.tokenMint,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
    );
  });

  test('sunset plan blocks new subscriptions', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .updatePlan({
        owner: t.payerKeypair,
        planPda,
        status: PlanStatus.Sunset,
        endTs,
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .subscribe({
          subscriber,
          merchant: t.payerKeypair.address,
          planId: 1n,
          tokenMint: t.tokenMint,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__PLAN_SUNSET,
    );
  });

  test('grace period honored then blocked after expiry', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    await t.client.subscriptions.instructions
      .transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 200_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    const graceSig = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(graceSig).toBeDefined();

    const subData = (await fetchSubscriptionDelegation(t.rpc, subscriptionPda))
      .data;
    await t.timeTravel(Number(subData.expiresAtTs) + 60);

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: t.payerKeypair,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 50_000n,
          receiverAta: merchantAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
    );
  });

  test('double cancel is blocked', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .cancelSubscription({
          subscriber,
          planPda,
          subscriptionPda,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__SUBSCRIPTION_ALREADY_CANCELLED,
    );
  });

  test('plan delete before expiry is blocked', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .deletePlan({
          owner: t.payerKeypair,
          planPda,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__PLAN_NOT_EXPIRED,
    );

    await t.timeTravel(Number(endTs) + 60);

    const signature = await t.client.subscriptions.instructions
      .deletePlan({
        owner: t.payerKeypair,
        planPda,
      })
      .sendTransaction();
    expect(signature).toBeDefined();

    const planAfter = await fetchMaybePlan(t.rpc, planPda);
    expect(planAfter.exists).toBe(false);
  });

  test('plan update after sunset is blocked', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .updatePlan({
        owner: t.payerKeypair,
        planPda,
        status: PlanStatus.Sunset,
        endTs,
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .updatePlan({
          owner: t.payerKeypair,
          planPda,
          status: PlanStatus.Active,
          endTs: 0n,
          metadataUri: 'https://example.com/updated.json',
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__PLAN_IMMUTABLE_AFTER_SUNSET,
    );
  });

  test('subscribe, cancel, revoke, then re-subscribe', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    const subData = (await fetchSubscriptionDelegation(t.rpc, subscriptionPda))
      .data;
    await t.timeTravel(Number(subData.expiresAtTs) + 60);

    await t.client.subscriptions.instructions
      .revokeSubscription({
        authority: subscriber,
        subscriptionPda,
        planPda,
      })
      .sendTransaction();

    const subAfterRevoke = await fetchMaybeSubscriptionDelegation(
      t.rpc,
      subscriptionPda,
    );
    expect(subAfterRevoke.exists).toBe(false);

    const [newSubPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const newSub = (await fetchSubscriptionDelegation(t.rpc, newSubPda)).data;
    expect(newSub.amountPulledInPeriod).toBe(0n);
    expect(newSub.expiresAtTs).toBe(0n);
    expect(newSub.header.delegator).toBe(subscriber.address);
  });

  test('re-init + stale subscription transfer is blocked', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    await t.client.subscriptions.instructions
      .closeSubscriptionAuthority({
        user: subscriber,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: t.payerKeypair,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 100_000n,
          receiverAta: merchantAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
    );
  });

  test('cancel and revoke when plan is already deleted', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .updatePlan({
        owner: t.payerKeypair,
        planPda,
        status: PlanStatus.Sunset,
        endTs,
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await t.timeTravel(Number(endTs) + 60);

    await t.client.subscriptions.instructions
      .deletePlan({
        owner: t.payerKeypair,
        planPda,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    const subAfterCancel = (
      await fetchSubscriptionDelegation(t.rpc, subscriptionPda)
    ).data;
    expect(subAfterCancel.expiresAtTs).not.toBe(0n);

    const signature = await t.client.subscriptions.instructions
      .revokeSubscription({
        authority: subscriber,
        subscriptionPda,
        planPda,
      })
      .sendTransaction();
    expect(signature).toBeDefined();

    const subAfterRevoke = await fetchMaybeSubscriptionDelegation(
      t.rpc,
      subscriptionPda,
    );
    expect(subAfterRevoke.exists).toBe(false);
  });

  test('re-subscribe before revoke is blocked', async () => {
    const t = await initTestSuite();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .subscribe({
          subscriber,
          merchant: t.payerKeypair.address,
          planId: 1n,
          tokenMint: t.tokenMint,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
    );
  });

  test('error precedence: PLAN_CLOSED when plan deleted and subscription cancelled', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .updatePlan({
        owner: t.payerKeypair,
        planPda,
        status: PlanStatus.Sunset,
        endTs,
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    await t.timeTravel(Number(endTs) + 60);

    await t.client.subscriptions.instructions
      .deletePlan({
        owner: t.payerKeypair,
        planPda,
      })
      .sendTransaction();

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: t.payerKeypair,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 50_000n,
          receiverAta: merchantAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__PLAN_CLOSED,
    );
  });

  test('dynamic puller removal blocks old puller', async () => {
    const t = await initTestSuite();
    const pullerA = await t.createFundedKeypair();
    const pullerB = await t.createFundedKeypair();

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [pullerA.address],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const pullerAAta = await t.createAtaWithBalance(
      t.tokenMint,
      pullerA.address,
      0n,
    );

    const firstPull = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: pullerA,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 50_000n,
        receiverAta: pullerAAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(firstPull).toBeDefined();

    await t.client.subscriptions.instructions
      .updatePlan({
        owner: t.payerKeypair,
        planPda,
        status: PlanStatus.Active,
        endTs: 0n,
        metadataUri: 'https://example.com/plan.json',
        pullers: [pullerB.address],
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: pullerA,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 50_000n,
          receiverAta: pullerAAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );

    const pullerBAta = await t.createAtaWithBalance(
      t.tokenMint,
      pullerB.address,
      0n,
    );
    const newPull = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: pullerB,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 50_000n,
        receiverAta: pullerBAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(newPull).toBeDefined();
  });

  test('cancel with wrong plan account fails', async () => {
    const t = await initTestSuite();

    const [planA] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours: 1n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/planA.json',
      })
      .sendTransaction();

    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 2n,
        mint: t.tokenMint,
        amount: 100_000n,
        periodHours: 24n,
        endTs: 0n,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/planB.json',
      })
      .sendTransaction();

    const [planBPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 2n,
    });

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await expectProgramError(
      t.client.subscriptions.instructions
        .cancelSubscription({
          subscriber,
          planPda: planBPda,
          subscriptionPda,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__SUBSCRIPTION_PLAN_MISMATCH,
    );

    const signature = await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda: planA,
        subscriptionPda,
      })
      .sendTransaction();
    expect(signature).toBeDefined();
  });

  test('plan end_ts expiry blocks subscription transfer', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    const signature = await t.client.subscriptions.instructions
      .transferSubscription({
        caller: t.payerKeypair,
        delegator: subscriber.address,
        tokenMint: t.tokenMint,
        subscriptionPda,
        planPda,
        amount: 100_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();
    expect(signature).toBeDefined();

    await t.timeTravel(Number(endTs) + 60);

    await expectProgramError(
      t.client.subscriptions.instructions
        .transferSubscription({
          caller: t.payerKeypair,
          delegator: subscriber.address,
          tokenMint: t.tokenMint,
          subscriptionPda,
          planPda,
          amount: 50_000n,
          receiverAta: merchantAta,
          tokenProgram: t.tokenProgram,
        })
        .sendTransaction(),
      SUBSCRIPTIONS_ERROR__PLAN_EXPIRED,
    );
  });

  test('cancel on expired plan caps expires_at_ts, enabling immediate revoke', async () => {
    const t = await initTestSuite();
    const periodHours = 1n;
    const endTs = await t.minPlanEndTs(periodHours);

    const [planPda] = await findPlanPda({
      owner: t.payerKeypair.address,
      planId: 1n,
    });
    await t.client.subscriptions.instructions
      .createPlan({
        owner: t.payerKeypair,
        planId: 1n,
        mint: t.tokenMint,
        amount: 500_000n,
        periodHours,
        endTs,
        destinations: [],
        pullers: [],
        metadataUri: 'https://example.com/plan.json',
      })
      .sendTransaction();

    const subscriber = await t.createFundedKeypair();
    const subscriberAta = await t.createAtaWithBalance(
      t.tokenMint,
      subscriber.address,
      DEFAULT_TEST_BALANCE,
    );
    await t.client.subscriptions.instructions
      .initSubscriptionAuthority({
        owner: subscriber,
        tokenMint: t.tokenMint,
        userAta: subscriberAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const [subscriptionPda] = await findSubscriptionDelegationPda({
      planPda: (
        await findPlanPda({
          owner: t.payerKeypair.address,
          planId: 1n,
        })
      )[0],
      subscriber: subscriber.address,
    });
    await t.client.subscriptions.instructions
      .subscribe({
        subscriber,
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      })
      .sendTransaction();

    await t.timeTravel(Number(endTs) + 120);

    await t.client.subscriptions.instructions
      .cancelSubscription({
        subscriber,
        planPda,
        subscriptionPda,
      })
      .sendTransaction();

    const subData = (await fetchSubscriptionDelegation(t.rpc, subscriptionPda))
      .data;
    expect(subData.expiresAtTs).toBeLessThanOrEqual(endTs);

    const signature = await t.client.subscriptions.instructions
      .revokeSubscription({
        authority: subscriber,
        subscriptionPda,
        planPda,
      })
      .sendTransaction();
    expect(signature).toBeDefined();

    const subAfterRevoke = await fetchMaybeSubscriptionDelegation(
      t.rpc,
      subscriptionPda,
    );
    expect(subAfterRevoke.exists).toBe(false);
  });
});
