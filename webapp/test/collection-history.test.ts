import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeEligibleSubscribers } from '../src/lib/collect-utils.ts';
import { createSuccessRecord, getCollectionRecordTotalDisplayAmount } from '../src/lib/collection-history.ts';

const USDC = 1_000_000n;
const USDC_MULTIPLIER = Number(USDC);

describe('collection history', () => {
    test('records same-period partial pulls using the actual remaining transfer amount', () => {
        const planAmount = 10n * USDC;
        const currentTs = 1_700_000_000;
        const planTerms = { amount: planAmount, periodHours: 24n, createdAt: BigInt(currentTs - 3600) };
        const subscriptionAddress = 'Sub111111111111111111111111111111111111111';

        const eligible = computeEligibleSubscribers(
            [
                {
                    subscriptionAddress,
                    delegator: 'Delegator1111111111111111111111111111111111',
                    terms: planTerms,
                    amountPulledInPeriod: 9n * USDC,
                    currentPeriodStartTs: BigInt(currentTs - 3600),
                    expiresAtTs: 0n,
                },
            ],
            planTerms,
            currentTs,
        );
        const transfer = eligible[0];

        assert.ok(transfer);
        assert.equal(transfer.collectAmount, 1n * USDC);

        const record = createSuccessRecord(
            'Plan111111111111111111111111111111111111111',
            'Partial Plan',
            [
                {
                    subscriptionAddress: transfer.subscriptionAddress,
                    amount: transfer.collectAmount,
                    signature: 'signature',
                },
            ],
            1,
            eligible.length,
        );

        assert.equal(record.totalAmount, (1n * USDC).toString());
        assert.equal(record.amountPerSubscriber, undefined);
        assert.deepEqual(record.transfers, [
            {
                subscriptionAddress,
                amount: (1n * USDC).toString(),
                signature: 'signature',
            },
        ]);
        assert.equal(getCollectionRecordTotalDisplayAmount(record, USDC_MULTIPLIER), 1);
        assert.equal(record.status, 'success');
    });

    test('marks partially completed collection attempts without counting uncollected subscribers', () => {
        const record = createSuccessRecord(
            'Plan111111111111111111111111111111111111111',
            'Partial Batch Plan',
            [
                {
                    subscriptionAddress: 'Sub111111111111111111111111111111111111111',
                    amount: 3n * USDC,
                    signature: 'signature-1',
                },
            ],
            2,
            2,
        );

        assert.equal(record.subscribersCollected, 1);
        assert.equal(record.totalAmount, (3n * USDC).toString());
        assert.equal(getCollectionRecordTotalDisplayAmount(record, USDC_MULTIPLIER), 3);
        assert.equal(record.status, 'partial');
    });

    test('keeps all collected transfers when a stale total is too low', () => {
        const record = createSuccessRecord(
            'Plan111111111111111111111111111111111111111',
            'Growing Batch Plan',
            [
                {
                    subscriptionAddress: 'Sub111111111111111111111111111111111111111',
                    amount: 1n * USDC,
                    signature: 'signature-1',
                },
                {
                    subscriptionAddress: 'Sub222222222222222222222222222222222222222',
                    amount: 2n * USDC,
                    signature: 'signature-2',
                },
                {
                    subscriptionAddress: 'Sub333333333333333333333333333333333333333',
                    amount: 3n * USDC,
                    signature: 'signature-2',
                },
            ],
            2,
            3,
        );

        assert.equal(record.subscribersCollected, 3);
        assert.equal(record.subscribersTotal, 3);
        assert.equal(record.totalAmount, (6n * USDC).toString());
        assert.equal(record.transfers?.length, 3);
        assert.deepEqual(record.signatures, ['signature-1', 'signature-2']);
        assert.equal(record.status, 'success');
    });
});
