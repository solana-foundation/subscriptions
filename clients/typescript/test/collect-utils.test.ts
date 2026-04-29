import { describe, expect, test } from 'vitest';
import {
    computeEligibleSubscribers,
    getStalePlanSubscribers,
    hasMatchingPlanTerms,
    type PlanSubscriberForCollection,
    type PlanTermsFingerprint,
} from '../../../webapp/src/lib/collect-utils.ts';

function createSubscriber(subscriptionAddress: string, terms: PlanTermsFingerprint): PlanSubscriberForCollection {
    return {
        subscriptionAddress,
        delegator: `${subscriptionAddress}-delegator`,
        terms,
        amountPulledInPeriod: 0n,
        currentPeriodStartTs: 0n,
        expiresAtTs: 0n,
    };
}

describe('computeEligibleSubscribers', () => {
    test('excludes same-amount same-period subscriptions from previous plan lifecycles', () => {
        const planTerms = {
            amount: 500_000n,
            periodHours: 1n,
            createdAt: 2_000n,
        };
        const staleSubscriber = createSubscriber('stale-subscription', {
            ...planTerms,
            createdAt: 1_000n,
        });
        const currentSubscriber = createSubscriber('current-subscription', planTerms);

        expect(hasMatchingPlanTerms(staleSubscriber, planTerms)).toBe(false);
        expect(hasMatchingPlanTerms(currentSubscriber, planTerms)).toBe(true);
        expect(
            getStalePlanSubscribers([staleSubscriber, currentSubscriber], planTerms).map(
                subscriber => subscriber.subscriptionAddress,
            ),
        ).toEqual(['stale-subscription']);

        expect(computeEligibleSubscribers([staleSubscriber, currentSubscriber], planTerms, 1_800)).toEqual([
            {
                subscriptionAddress: 'current-subscription',
                delegator: 'current-subscription-delegator',
                collectAmount: 500_000n,
            },
        ]);
    });
});
