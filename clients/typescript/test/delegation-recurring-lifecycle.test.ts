import { describe, expect, test } from 'vitest';
import {
  fetchMaybeSubscriptionAuthority,
  fetchRecurringDelegation,
  fetchSubscriptionAuthority,
} from '../src/generated/index.ts';
import {
  buildCloseSubscriptionAuthority,
  buildCreateRecurringDelegation,
  buildInitSubscriptionAuthority,
  buildRevokeDelegation,
} from '../src/instructions/delegation.ts';
import { getDelegationPDA, getSubscriptionAuthorityPDA } from '../src/pdas.ts';
import { addressAsSigner } from '../src/wallet.ts';
import {
  DEFAULT_TEST_BALANCE,
  getWalletProviders,
  initTestSuite,
  ONE_DAY_IN_SECONDS,
} from './setup.ts';

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
    const { instructions: initIxs } = await buildInitSubscriptionAuthority({
      owner: addressAsSigner(wallet.address),
      tokenMint: t.tokenMint,
      userAta,
      tokenProgram: t.tokenProgram,
    });
    await wallet.sendInstructions(initIxs);

    const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
      wallet.address,
      t.tokenMint,
    );

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

    const { instructions: createIxs } = await buildCreateRecurringDelegation({
      delegator: addressAsSigner(wallet.address),
      tokenMint: t.tokenMint,
      delegatee: delegatee.address,
      nonce,
      amountPerPeriod,
      periodLengthS,
      startTs,
      expiryTs: expiryS,
    });
    await wallet.sendInstructions(createIxs);

    const [delegationPda] = await getDelegationPDA(
      subscriptionAuthorityPda,
      wallet.address,
      delegatee.address,
      nonce,
    );

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
    await t.client.transferRecurring({
      delegatee,
      delegator: wallet.address,
      delegatorAta: userAta,
      tokenMint: t.tokenMint,
      delegationPda,
      amount: transferAmount,
      receiverAta: delegateeAta,
      tokenProgram: t.tokenProgram,
    });

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
    const { instructions: revokeIxs } = buildRevokeDelegation({
      authority: addressAsSigner(wallet.address),
      delegationAccount: delegationPda,
    });
    await wallet.sendInstructions(revokeIxs);
    await expect(
      fetchRecurringDelegation(t.rpc, delegationPda),
    ).rejects.toThrow();

    // 5. Close subscription-authority
    const { instructions: closeIxs } = await buildCloseSubscriptionAuthority({
      user: addressAsSigner(wallet.address),
      tokenMint: t.tokenMint,
    });
    await wallet.sendInstructions(closeIxs);

    const accountAfter = await fetchMaybeSubscriptionAuthority(
      t.rpc,
      subscriptionAuthorityPda,
    );
    expect(accountAfter.exists).toBe(false);
  });
});
