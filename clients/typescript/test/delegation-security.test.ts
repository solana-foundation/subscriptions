import { describe, expect, test } from 'vitest';
import {
  SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
  SUBSCRIPTIONS_ERROR__DELEGATION_ALREADY_EXISTS,
  SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
  SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED,
  SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
  SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
  SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
} from '../src/generated/errors/subscriptions.ts';
import {
  buildCloseSubscriptionAuthority,
  buildCreateFixedDelegation,
  buildCreateRecurringDelegation,
  buildRevokeDelegation,
} from '../src/instructions/delegation.ts';
import { getDelegationPDA, getSubscriptionAuthorityPDA } from '../src/pdas.ts';
import { addressAsSigner } from '../src/wallet.ts';
import {
  DEFAULT_TEST_BALANCE,
  expectProgramError,
  initTestSuite,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
} from './setup.ts';

describe('Delegation Security', () => {
  test('stale delegation after re-init is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
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
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    const [oldDelegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    await t.client.transferFixed({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda: oldDelegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });

    const { instructions: closeIxs } = await buildCloseSubscriptionAuthority({
      user: addressAsSigner(t.payerKeypair.address),
      tokenMint: t.tokenMint,
    });
    await t.payer.sendInstructions(closeIxs);

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    await expectProgramError(
      t.client.transferFixed({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda: oldDelegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
    );

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 1n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    const [newDelegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      1n,
    );

    const { signature } = await t.client.transferFixed({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda: newDelegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('close SubscriptionAuthority kills all transfers', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE * 2n,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );

    const delegatee1 = await t.createFundedKeypair();
    const delegatee1Ata = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee1.address,
      0n,
    );
    const delegatee2 = await t.createFundedKeypair();
    const delegatee2Ata = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee2.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee1.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee2.address,
      nonce: 0n,
      amountPerPeriod: 100_000n,
      periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
      startTs: currentTs,
      expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
    });

    const [fixedPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee1.address,
      0n,
    );
    const [recurringPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee2.address,
      0n,
    );

    await t.client.transferFixed({
      delegatee: delegatee1,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda: fixedPda,
      amount: 50_000n,
      receiverAta: delegatee1Ata,
      tokenProgram: t.tokenProgram,
    });

    await t.client.transferRecurring({
      delegatee: delegatee2,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda: recurringPda,
      amount: 50_000n,
      receiverAta: delegatee2Ata,
      tokenProgram: t.tokenProgram,
    });

    const { instructions: closeIxs } = await buildCloseSubscriptionAuthority({
      user: addressAsSigner(t.payerKeypair.address),
      tokenMint: t.tokenMint,
    });
    await t.payer.sendInstructions(closeIxs);

    await expectProgramError(
      t.client.transferFixed({
        delegatee: delegatee1,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda: fixedPda,
        amount: 50_000n,
        receiverAta: delegatee1Ata,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
    );

    await expectProgramError(
      t.client.transferRecurring({
        delegatee: delegatee2,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda: recurringPda,
        amount: 50_000n,
        receiverAta: delegatee2Ata,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA,
    );
  });

  test('expired fixed delegation transfer is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs,
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    const { signature } = await t.client.transferFixed({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();

    await t.timeTravel(Number(expiryTs) + 200);

    await expectProgramError(
      t.client.transferFixed({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
    );
  });

  test('expired recurring delegation transfer is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amountPerPeriod: 100_000n,
      periodLengthS: BigInt(ONE_HOUR_IN_SECONDS),
      startTs: currentTs,
      expiryTs,
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    const { signature } = await t.client.transferRecurring({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();

    await t.timeTravel(Number(expiryTs) + 200);

    await expectProgramError(
      t.client.transferRecurring({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
    );
  });

  test('wrong signer rejected on fixed delegation', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const legitimateDelegatee = await t.createFundedKeypair();
    const attacker = await t.createFundedKeypair();
    const attackerAta = await t.createAtaWithBalance(
      t.tokenMint,
      attacker.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: legitimateDelegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      legitimateDelegatee.address,
      0n,
    );

    await expectProgramError(
      t.client.transferFixed({
        delegatee: attacker,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: attackerAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );

    const legitimateAta = await t.createAtaWithBalance(
      t.tokenMint,
      legitimateDelegatee.address,
      0n,
    );
    const { signature } = await t.client.transferFixed({
      delegatee: legitimateDelegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: legitimateAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('wrong signer rejected on recurring delegation', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const legitimateDelegatee = await t.createFundedKeypair();
    const attacker = await t.createFundedKeypair();
    const attackerAta = await t.createAtaWithBalance(
      t.tokenMint,
      attacker.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: legitimateDelegatee.address,
      nonce: 0n,
      amountPerPeriod: 100_000n,
      periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
      startTs: currentTs,
      expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      legitimateDelegatee.address,
      0n,
    );

    await expectProgramError(
      t.client.transferRecurring({
        delegatee: attacker,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: attackerAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );

    const legitimateAta = await t.createAtaWithBalance(
      t.tokenMint,
      legitimateDelegatee.address,
      0n,
    );
    const { signature } = await t.client.transferRecurring({
      delegatee: legitimateDelegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: legitimateAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('skipped periods do not accumulate allowance', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    const periodS = BigInt(ONE_DAY_IN_SECONDS);
    const amountPerPeriod = 100_000n;

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amountPerPeriod,
      periodLengthS: periodS,
      startTs: currentTs,
      expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    await t.timeTravel(Number(currentTs) + ONE_DAY_IN_SECONDS * 3 + 60);

    await expectProgramError(
      t.client.transferRecurring({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: amountPerPeriod * 3n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
    );

    const { signature } = await t.client.transferRecurring({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: amountPerPeriod,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('exceed per-period limit is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    const amountPerPeriod = 100_000n;

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amountPerPeriod,
      periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
      startTs: currentTs,
      expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    await t.client.transferRecurring({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 60_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });

    await expectProgramError(
      t.client.transferRecurring({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
    );

    const { signature } = await t.client.transferRecurring({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 40_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('transfer before recurring start time is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const currentTs = await t.getValidatorTime();
    const startTs = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

    await t.client.createRecurringDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amountPerPeriod: 100_000n,
      periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
      startTs,
      expiryTs: startTs + BigInt(ONE_DAY_IN_SECONDS * 30),
    });

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      t.payerKeypair.address,
      t.tokenMint,
    );
    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      t.payerKeypair.address,
      delegatee.address,
      0n,
    );

    await expectProgramError(
      t.client.transferRecurring({
        delegatee,
        delegator: t.payerKeypair.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
      SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED,
    );

    await t.timeTravel(Number(startTs) + 60);

    const { signature } = await t.client.transferRecurring({
      delegatee,
      delegator: t.payerKeypair.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('cross-type nonce collision: fixed then recurring same nonce', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    await expectProgramError(
      t.client.createRecurringDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amountPerPeriod: 100_000n,
        periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
        startTs: currentTs,
        expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
      }),
      SUBSCRIPTIONS_ERROR__DELEGATION_ALREADY_EXISTS,
    );
  });

  test('SPL token delegate revocation and recovery', async () => {
    const t = await initTestSuite();

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

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      subscriber.address,
      t.tokenMint,
    );

    const delegatee = await t.createFundedKeypair();
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );
    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: subscriber,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      subscriber.address,
      delegatee.address,
      0n,
    );

    const { getRevokeInstruction } = await import('@solana-program/token');
    const revokeIx = getRevokeInstruction({
      source: subscriberAta,
      owner: subscriber,
    });
    await t.payer.sendInstructions([revokeIx]);

    // Fails at SPL Token program level (not a subscriptions error),
    // so we assert the generic rejection rather than a specific program error code
    await expect(
      t.client.transferFixed({
        delegatee,
        delegator: subscriber.address,
        delegatorAta: subscriberAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: 50_000n,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      }),
    ).rejects.toThrow(/simulation failed/i);

    const { getApproveInstruction } = await import('@solana-program/token');
    const approveIx = getApproveInstruction({
      source: subscriberAta,
      delegate: subscriptionAuthorityPda,
      owner: subscriber,
      amount: BigInt('18446744073709551615'),
    });
    await t.payer.sendInstructions([approveIx]);

    const { signature } = await t.client.transferFixed({
      delegatee,
      delegator: subscriber.address,
      delegatorAta: subscriberAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: 50_000n,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });
    expect(signature).toBeDefined();
  });

  test('nonce collision is blocked', async () => {
    const t = await initTestSuite();

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();

    await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 0n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });

    await expectProgramError(
      t.client.createFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
      }),
      SUBSCRIPTIONS_ERROR__DELEGATION_ALREADY_EXISTS,
    );

    const { signature } = await t.client.createFixedDelegation({
      delegator: t.payerKeypair,
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce: 1n,
      amount: 500_000n,
      expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
    });
    expect(signature).toBeDefined();
  });
});

describe('Sponsor Revoke', () => {
  test('sponsor can revoke expired fixed delegation', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);
    const sponsorWallet = await t.createFundedWallet(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

    const { instructions: createIxs, delegationPda } =
      await buildCreateFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    await t.timeTravel(Number(expiryTs) + 200);

    const { instructions: revokeIxs } = buildRevokeDelegation({
      authority: sponsor,
      delegationAccount: delegationPda,
    });
    await sponsorWallet.sendInstructions(revokeIxs);

    const { fetchMaybeFixedDelegation } = await import(
      '../src/generated/index.ts'
    );
    const account = await fetchMaybeFixedDelegation(t.rpc, delegationPda);
    expect(account.exists).toBe(false);
  });

  test('sponsor can revoke expired recurring delegation', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);
    const sponsorWallet = await t.createFundedWallet(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(2 * ONE_DAY_IN_SECONDS);

    const { instructions: createIxs, delegationPda } =
      await buildCreateRecurringDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amountPerPeriod: 100_000n,
        periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
        startTs: currentTs,
        expiryTs,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    await t.timeTravel(Number(expiryTs) + 200);

    const { instructions: revokeIxs } = buildRevokeDelegation({
      authority: sponsor,
      delegationAccount: delegationPda,
    });
    await sponsorWallet.sendInstructions(revokeIxs);

    const { fetchMaybeRecurringDelegation } = await import(
      '../src/generated/index.ts'
    );
    const account = await fetchMaybeRecurringDelegation(t.rpc, delegationPda);
    expect(account.exists).toBe(false);
  });

  test('sponsor cannot revoke non-expired delegation', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(2 * ONE_HOUR_IN_SECONDS);

    const { instructions: createIxs, delegationPda } =
      await buildCreateFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    await expectProgramError(
      t.client.revokeDelegation({
        authority: sponsor,
        delegationAccount: delegationPda,
      }),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );
  });

  test('sponsor cannot revoke delegation with no expiry', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();

    const { instructions: createIxs, delegationPda } =
      await buildCreateFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs: 0n,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    await expectProgramError(
      t.client.revokeDelegation({
        authority: sponsor,
        delegationAccount: delegationPda,
      }),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );
  });

  test('delegator can revoke sponsor-funded delegation before expiry', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(2 * ONE_HOUR_IN_SECONDS);

    const { instructions: createIxs, delegationPda } =
      await buildCreateFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    const { instructions: revokeIxs } = buildRevokeDelegation({
      authority: t.payerKeypair,
      delegationAccount: delegationPda,
      receiver: sponsor.address,
    });
    await t.payer.sendInstructions(revokeIxs);

    const { fetchMaybeFixedDelegation } = await import(
      '../src/generated/index.ts'
    );
    const account = await fetchMaybeFixedDelegation(t.rpc, delegationPda);
    expect(account.exists).toBe(false);
  });

  test('random account cannot revoke delegation', async () => {
    const t = await initTestSuite();
    const sponsor = await t.createFundedKeypair(5_000_000_000n);
    const attacker = await t.createFundedKeypair(5_000_000_000n);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      t.payerKeypair.address,
      DEFAULT_TEST_BALANCE,
    );

    await t.client.initSubscriptionAuthority({
      owner: t.payerKeypair,
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });

    const delegatee = await t.createFundedKeypair();
    const currentTs = await t.getValidatorTime();
    const expiryTs = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

    const { instructions: createIxs, delegationPda } =
      await buildCreateFixedDelegation({
        delegator: t.payerKeypair,
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce: 0n,
        amount: 500_000n,
        expiryTs,
        payer: sponsor,
      });
    await t.payer.sendInstructions(createIxs);

    await t.timeTravel(Number(expiryTs) + 200);

    await expectProgramError(
      t.client.revokeDelegation({
        authority: attacker,
        delegationAccount: delegationPda,
      }),
      SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
    );
  });
});
