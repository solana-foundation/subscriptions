import { describe, expect, test } from 'vitest';
import {
  SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
} from '../src/generated/errors/subscriptions.ts';
import { fetchSubscriptionDelegation } from '../src/generated/index.ts';
import { getDelegationPDA, getSubscriptionAuthorityPDA } from '../src/pdas.ts';
import {
  DEFAULT_TEST_BALANCE,
  expectProgramError,
  initTestSuite,
} from './setup.ts';

describe('Multi-Wallet Scenarios', () => {
  test('multi-subscriber isolation: cancel one does not affect others', async () => {
    const t = await initTestSuite();

    const { planPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 1n,
      mint: t.tokenMint,
      amount: 500_000n,
      periodHours: 1n,
      endTs: 0n,
      destinations: [],
      pullers: [],
      metadataUri: 'https://example.com/plan.json',
    });

    const subscribers = await Promise.all(
      Array.from({ length: 3 }, () => t.createFundedKeypair()),
    );
    const subscriberAtas = await Promise.all(
      subscribers.map((s) =>
        t.createAtaWithBalance(t.tokenMint, s.address, DEFAULT_TEST_BALANCE),
      ),
    );

    for (let i = 0; i < 3; i++) {
      await t.client.initSubscriptionAuthority({
        owner: subscribers[i],
        tokenMint: t.tokenMint,
        userAta: subscriberAtas[i],
        tokenProgram: t.tokenProgram,
      });
    }

    const subPdas: `${string}`[] = [];
    for (let i = 0; i < 3; i++) {
      const { subscriptionPda } = await t.client.subscribe({
        subscriber: subscribers[i],
        merchant: t.payerKeypair.address,
        planId: 1n,
        tokenMint: t.tokenMint,
      });
      subPdas.push(subscriptionPda);
    }

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscribers[0].address,
      tokenMint: t.tokenMint,
      subscriptionPda: subPdas[0],
      planPda,
      amount: 100_000n,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });

    await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscribers[1].address,
      tokenMint: t.tokenMint,
      subscriptionPda: subPdas[1],
      planPda,
      amount: 150_000n,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });

    await t.client.cancelSubscription({
      subscriber: subscribers[2],
      planPda,
      subscriptionPda: subPdas[2],
    });

    const subC = (await fetchSubscriptionDelegation(t.rpc, subPdas[2])).data;
    await t.timeTravel(Number(subC.expiresAtTs) + 60);

    await expectProgramError(
      t.client.transferSubscription({
        caller: t.payerKeypair,
        delegator: subscribers[2].address,
        tokenMint: t.tokenMint,
        subscriptionPda: subPdas[2],
        planPda,
        amount: 50_000n,
        receiverAta: merchantAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
    );

    const { signature: sigA } = await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscribers[0].address,
      tokenMint: t.tokenMint,
      subscriptionPda: subPdas[0],
      planPda,
      amount: 100_000n,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });
    expect(sigA).toBeDefined();

    const { signature: sigB } = await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscribers[1].address,
      tokenMint: t.tokenMint,
      subscriptionPda: subPdas[1],
      planPda,
      amount: 100_000n,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });
    expect(sigB).toBeDefined();

    // Time travel moved past C's grace period (~2 hours), advancing A and B
    // into a new billing period. amountPulledInPeriod resets, so only the
    // second charge (100k each) is reflected.
    const subAData = (await fetchSubscriptionDelegation(t.rpc, subPdas[0]))
      .data;
    const subBData = (await fetchSubscriptionDelegation(t.rpc, subPdas[1]))
      .data;
    expect(subAData.amountPulledInPeriod).toBe(100_000n);
    expect(subBData.amountPulledInPeriod).toBe(100_000n);
    expect(subC.expiresAtTs).not.toBe(0n);
  });

  test('re-init defense: user kill-switch blocks merchant, then recovers', async () => {
    const t = await initTestSuite();

    const { planPda } = await t.client.createPlan({
      owner: t.payerKeypair,
      planId: 1n,
      mint: t.tokenMint,
      amount: 500_000n,
      periodHours: 1n,
      endTs: 0n,
      destinations: [],
      pullers: [],
      metadataUri: 'https://example.com/plan.json',
    });

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

    const merchantAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      0n,
    );

    const { signature: chargeSig } = await t.client.transferSubscription({
      caller: t.payerKeypair,
      delegator: subscriber.address,
      tokenMint: t.tokenMint,
      subscriptionPda,
      planPda,
      amount: 100_000n,
      receiverAta: merchantAta,
      tokenProgram: t.tokenProgram,
    });
    expect(chargeSig).toBeDefined();

    await t.client.closeSubscriptionAuthority({
      user: subscriber,
      tokenMint: t.tokenMint,
    });

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
      SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
    );

    await t.client.initSubscriptionAuthority({
      owner: subscriber,
      tokenMint: t.tokenMint,
      userAta: subscriberAta,
      tokenProgram: t.tokenProgram,
    });

    const trustedDelegatee = await t.createFundedKeypair();
    const trustedAta = await t.createAtaWithBalance(
      t.tokenMint,
      trustedDelegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    await t.client.createFixedDelegation({
      delegator: subscriber,
      tokenMint: t.tokenMint,
      delegatee: trustedDelegatee.address,
      nonce: 0n,
      amount: 200_000n,
      expiryTs: currentTs + 3600n,
    });

    const [mdPda] = await getSubscriptionAuthorityPDA(subscriber.address, t.tokenMint);
    const [delegPda] = await getDelegationPDA(
      mdPda,
      subscriber.address,
      trustedDelegatee.address,
      0n,
    );

    const { signature: newTransferSig } = await t.client.transferFixed({
      delegatee: trustedDelegatee,
      delegator: subscriber.address,
      delegatorAta: subscriberAta,
      tokenMint: t.tokenMint,
      delegationPda: delegPda,
      amount: 50_000n,
      receiverAta: trustedAta,
      tokenProgram: t.tokenProgram,
    });
    expect(newTransferSig).toBeDefined();
  });

  test('multi-mint kill-switch isolation', async () => {
    const t = await initTestSuite();

    const mintB = await t.createTokenMint(6);

    const userAtaA = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );
    const userAtaB = await t.createAtaWithBalance(
      mintB,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta: userAtaA,
      tokenProgram: t.tokenProgram,
    });
    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: mintB,
      userAta: userAtaB,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAtaA = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );
    const delegateeAtaB = await t.createAtaWithBalance(
      mintB,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + 3600n,
    });

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: mintB,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + 3600n,
    });

    const [mdPdaA] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [mdPdaB] = await getSubscriptionAuthorityPDA(t.payerKeypair.address, mintB);
    const [delegPdaA] = await getDelegationPDA(
      mdPdaA,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );
    const [delegPdaB] = await getDelegationPDA(
      mdPdaB,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    await t.client.closeSubscriptionAuthority({
      user: t.payerKeypair,
      tokenMint: t.tokenMint,
    });

    await expectProgramError(
      t.client.transferFixed({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAtaA,
        tokenMint: t.tokenMint,
        delegationPda: delegPdaA,
        amount: 50_000n,
        receiverAta: delegateeAtaA,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
    );

    const { signature } = await t.client.transferFixed({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAtaB,
      tokenMint: mintB,
      delegationPda: delegPdaB,
      amount: 50_000n,
      receiverAta: delegateeAtaB,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });
});
