import { describe, expect, test } from 'vitest';
import {
    fetchFixedDelegation,
    fetchMaybeSubscriptionAuthority,
    fetchSubscriptionAuthority,
    findFixedDelegationPda,
    findSubscriptionAuthorityPda,
} from '../src/generated/index.ts';
import { DEFAULT_TEST_BALANCE, getWalletProviders, initTestSuite, ONE_HOUR_IN_SECONDS } from './setup.ts';
import { addressAsSigner } from './utils/wallet.ts';

describe.each(getWalletProviders())('Fixed Delegation Lifecycle ($name)', ({ createWallet }) => {
    test('init → create → transfer → revoke → close', async () => {
        const t = await initTestSuite();
        const wallet = await createWallet(t);

        const userAta = await t.createAtaWithBalance(t.tokenMint, wallet.address, DEFAULT_TEST_BALANCE);

        // 1. Init subscription-authority
        const initIx = await t.client.subscriptions.instructions.initSubscriptionAuthority({
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

        const subscriptionAuthorityAccount = await fetchSubscriptionAuthority(t.rpc, subscriptionAuthorityPda);
        expect(subscriptionAuthorityAccount.data.user).toBe(wallet.address);
        expect(subscriptionAuthorityAccount.data.tokenMint).toBe(t.tokenMint);

        // 2. Create fixed delegation
        const delegatee = await t.createFundedKeypair();
        const nonce = 0n;
        const amount = 500_000n;
        const currentTs = await t.getValidatorTime();
        const expiryS = currentTs + BigInt(ONE_HOUR_IN_SECONDS);

        const createIx = await t.client.subscriptions.instructions.createFixedDelegation({
            delegator: addressAsSigner(wallet.address),
            tokenMint: t.tokenMint,
            delegatee: delegatee.address,
            nonce,
            amount,
            expiryTs: expiryS,
        });
        await wallet.sendInstructions([createIx]);

        const [delegationPda] = await findFixedDelegationPda({
            subscriptionAuthority: subscriptionAuthorityPda,
            delegator: wallet.address,
            delegatee: delegatee.address,
            nonce: nonce,
        });

        const delegationAccount = await fetchFixedDelegation(t.rpc, delegationPda);
        expect(delegationAccount.data.amount).toBe(amount);
        expect(delegationAccount.data.expiryTs).toBe(expiryS);

        // 3. Transfer 100k (delegatee signs, not the wallet)
        const delegateeAta = await t.createAtaWithBalance(t.tokenMint, delegatee.address, 0n);

        const transferAmount = 100_000n;
        await t.client.subscriptions.instructions
            .transferFixed({
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

        const delegationAfterTransfer = await fetchFixedDelegation(t.rpc, delegationPda);
        expect(delegationAfterTransfer.data.amount).toBe(amount - transferAmount);

        // 4. Revoke delegation
        const revokeIx = t.client.subscriptions.instructions.revokeDelegation({
            authority: addressAsSigner(wallet.address),
            delegationAccount: delegationPda,
        });
        await wallet.sendInstructions([revokeIx]);
        await expect(fetchFixedDelegation(t.rpc, delegationPda)).rejects.toThrow();

        // 5. Close subscription-authority
        const balanceBefore = await t.rpc.getBalance(wallet.address).send();

        const closeIx = await t.client.subscriptions.instructions.closeSubscriptionAuthority({
            user: addressAsSigner(wallet.address),
            tokenMint: t.tokenMint,
        });
        await wallet.sendInstructions([closeIx]);

        const accountAfter = await fetchMaybeSubscriptionAuthority(t.rpc, subscriptionAuthorityPda);
        expect(accountAfter.exists).toBe(false);

        const balanceAfter = await t.rpc.getBalance(wallet.address).send();
        expect(balanceAfter.value).toBeGreaterThan(balanceBefore.value);
    });
});
