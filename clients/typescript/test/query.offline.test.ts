import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, test } from 'vitest';
import type { Delegation } from '../src/types/delegation.ts';
import { DEFAULT_TEST_BALANCE, initTestSuite, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from './setup.ts';

describe('Subscriptions Query Tests', () => {
    test('get delegations for wallet', async () => {
        const testSuite = await initTestSuite();

        const userAta = await testSuite.createAtaWithBalance(
            testSuite.tokenMint,
            testSuite.payerKeypair.address,
            DEFAULT_TEST_BALANCE,
        );

        await testSuite.client.subscriptions.instructions
            .initSubscriptionAuthority({
                owner: testSuite.payerKeypair,
                tokenMint: testSuite.tokenMint,
                userAta,
                tokenProgram: testSuite.tokenProgram,
            })
            .sendTransaction();

        const delegatee1 = await generateKeyPairSigner();
        const delegatee2 = await generateKeyPairSigner();

        const currentTs = await testSuite.getValidatorTime();

        await testSuite.client.subscriptions.instructions
            .createFixedDelegation({
                delegator: testSuite.payerKeypair,
                tokenMint: testSuite.tokenMint,
                delegatee: delegatee1.address,
                nonce: 0n,
                amount: 100_000n,
                expiryTs: currentTs + BigInt(ONE_HOUR_IN_SECONDS),
            })
            .sendTransaction();

        await testSuite.client.subscriptions.instructions
            .createRecurringDelegation({
                delegator: testSuite.payerKeypair,
                tokenMint: testSuite.tokenMint,
                delegatee: delegatee2.address,
                nonce: 1n,
                amountPerPeriod: 50_000n,
                periodLengthS: BigInt(ONE_DAY_IN_SECONDS),
                startTs: currentTs,
                expiryTs: currentTs + BigInt(ONE_DAY_IN_SECONDS * 30),
            })
            .sendTransaction();

        const delegations = await testSuite.client.subscriptions.queries.delegationsByDelegator(
            testSuite.payerKeypair.address,
        );

        expect(delegations.length).toBe(2);

        const fixedDelegations = delegations.filter((d): d is Delegation & { kind: 'fixed' } => d.kind === 'fixed');
        const recurringDelegations = delegations.filter(
            (d): d is Delegation & { kind: 'recurring' } => d.kind === 'recurring',
        );

        expect(fixedDelegations.length).toBe(1);
        expect(recurringDelegations.length).toBe(1);

        expect(fixedDelegations[0].data.header.delegatee).toBe(delegatee1.address);
        expect(fixedDelegations[0].data.amount).toBe(100_000n);

        expect(recurringDelegations[0].data.header.delegatee).toBe(delegatee2.address);
        expect(recurringDelegations[0].data.amountPerPeriod).toBe(50_000n);
    });
});
