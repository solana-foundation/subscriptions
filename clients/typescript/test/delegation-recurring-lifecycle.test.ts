import { describe, expect, test } from 'vitest';
import {
  fetchMaybeSubscriptionAuthority,
  fetchRecurringDelegation,
  fetchSubscriptionAuthority,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
} from '../src/generated/index.ts';
import {
  DEFAULT_TEST_BALANCE,
  getWalletProviders,
  initTestSuite,
  ONE_DAY_IN_SECONDS,
} from './setup.ts';
import { addressAsSigner } from './utils/wallet.ts';

describe.each(getWalletProviders())('Recurring Delegation Lifecycle ($name)', ({
  createWallet,
}) => {
  test('init → create → transfer → revoke → close', async () => {
    const t = await initTestSuite();
    const wallet = await createWallet(t);

    const userAta = await t.createAtaWithBalance(
      t.tokenMint,
      wallet.address,
      DEFAULT_TEST_BALANCE,
    );

    // 1. Init subscription-authority
    const initIx =
      await t.client.subscriptions.instructions.initSubscriptionAuthority({
        owner: addressAsSigner(wallet.address),
        tokenMint: t.tokenMint,
        userAta,
        tokenProgram: t.tokenProgram,
      });
    await wallet.sendInstructions([initIx]);

    const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda({
      user: wallet.address,
      tokenMint: t.tokenMint,
    });

    const subscriptionAuthorityAccount = await fetchSubscriptionAuthority(
      t.rpc,
      subscriptionAuthorityPda,
    );
    expect(subscriptionAuthorityAccount.data.user).toBe(wallet.address);

    // 2. Create recurring delegation
    const delegatee = await t.createFundedKeypair();
    const nonce = 0n;
    const amountPerPeriod = 100_000n;
    const periodLengthS = BigInt(ONE_DAY_IN_SECONDS);
    const currentTs = await t.getValidatorTime();
    const startTs = currentTs;
    const expiryS = currentTs + BigInt(ONE_DAY_IN_SECONDS * 30);

    const createIx =
      await t.client.subscriptions.instructions.createRecurringDelegation({
        delegator: addressAsSigner(wallet.address),
        tokenMint: t.tokenMint,
        delegatee: delegatee.address,
        nonce,
        amountPerPeriod,
        periodLengthS,
        startTs,
        expiryTs: expiryS,
      });
    await wallet.sendInstructions([createIx]);

    const [delegationPda] = await findFixedDelegationPda({
      subscriptionAuthority: subscriptionAuthorityPda,
      delegator: wallet.address,
      delegatee: delegatee.address,
      nonce: nonce,
    });

    const delegationAccount = await fetchRecurringDelegation(
      t.rpc,
      delegationPda,
    );
    expect(delegationAccount.data.expiryTs).toBe(expiryS);
    expect(delegationAccount.data.periodLengthS).toBe(periodLengthS);
    expect(delegationAccount.data.currentPeriodStartTs).toBe(startTs);
    expect(delegationAccount.data.amountPerPeriod).toBe(amountPerPeriod);
    expect(delegationAccount.data.amountPulledInPeriod).toBe(0n);

    // 3. Transfer 50k (delegatee signs, not the wallet)
    const delegateeAta = await t.createAtaWithBalance(
      t.tokenMint,
      delegatee.address,
      0n,
    );

    const transferAmount = 50_000n;
    await t.client.subscriptions.instructions
      .transferRecurring({
        delegatee,
        delegator: wallet.address,
        delegatorAta: userAta,
        tokenMint: t.tokenMint,
        delegationPda,
        amount: transferAmount,
        receiverAta: delegateeAta,
        tokenProgram: t.tokenProgram,
      })
      .sendTransaction();

    const balance = await t.rpc.getTokenAccountBalance(delegateeAta).send();
    expect(balance.value.amount).toBe(transferAmount.toString());

    const delegationAfterTransfer = await fetchRecurringDelegation(
      t.rpc,
      delegationPda,
    );
    expect(delegationAfterTransfer.data.amountPulledInPeriod).toBe(
      transferAmount,
    );

    // 4. Revoke delegation
    const revokeIx = t.client.subscriptions.instructions.revokeDelegation({
      authority: addressAsSigner(wallet.address),
      delegationAccount: delegationPda,
    });
    await wallet.sendInstructions([revokeIx]);
    await expect(
      fetchRecurringDelegation(t.rpc, delegationPda),
    ).rejects.toThrow();

    // 5. Close subscription-authority
    const closeIx =
      await t.client.subscriptions.instructions.closeSubscriptionAuthority({
        user: addressAsSigner(wallet.address),
        tokenMint: t.tokenMint,
      });
    await wallet.sendInstructions([closeIx]);

    const accountAfter = await fetchMaybeSubscriptionAuthority(
      t.rpc,
      subscriptionAuthorityPda,
    );
    expect(accountAfter.exists).toBe(false);
  });
});
