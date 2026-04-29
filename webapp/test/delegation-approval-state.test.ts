import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getDelegationApprovalState } from '../src/lib/delegation-approval-state.ts';

describe('getDelegationApprovalState', () => {
    test('keeps cleanup visible when authority exists but token approval is off', () => {
        assert.deepEqual(
            getDelegationApprovalState({
                isInitialized: true,
                isApproved: false,
                outgoingDelegationCount: 2,
            }),
            {
                canCreateDelegations: false,
                canCloseSubscriptionAuthority: true,
                shouldShowOutgoingDelegations: true,
                shouldShowApprovalPromptAsContent: false,
                shouldShowApprovalRecoveryBanner: true,
            },
        );
    });

    test('shows setup as content only when there is no cleanup surface', () => {
        assert.equal(
            getDelegationApprovalState({
                isInitialized: false,
                isApproved: false,
                outgoingDelegationCount: 0,
            }).shouldShowApprovalPromptAsContent,
            true,
        );
    });

    test('shows old outgoing delegation accounts even after authority close', () => {
        const state = getDelegationApprovalState({
            isInitialized: false,
            isApproved: false,
            outgoingDelegationCount: 1,
        });

        assert.equal(state.canCloseSubscriptionAuthority, false);
        assert.equal(state.shouldShowOutgoingDelegations, true);
        assert.equal(state.shouldShowApprovalPromptAsContent, false);
        assert.equal(state.shouldShowApprovalRecoveryBanner, true);
    });

    test('allows creation only while token approval is active', () => {
        const state = getDelegationApprovalState({
            isInitialized: true,
            isApproved: true,
            outgoingDelegationCount: 0,
        });

        assert.equal(state.canCreateDelegations, true);
        assert.equal(state.canCloseSubscriptionAuthority, true);
        assert.equal(state.shouldShowApprovalRecoveryBanner, false);
    });
});
