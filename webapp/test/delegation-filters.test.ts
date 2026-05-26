import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    filterDelegationsByMint,
    groupDelegationsByMint,
    type DelegationFilterItem,
} from '../src/lib/delegation-filters.ts';

function delegation(
    mint: string,
    type: 'Fixed' | 'Recurring',
    initId: bigint,
): DelegationFilterItem & { initId: bigint } {
    return {
        data: { mint },
        initId,
        type,
    };
}

describe('delegation filters', () => {
    test('filters delegations by their own mint before stale checks', () => {
        const usdcMint = 'USDC1111111111111111111111111111111111111';
        const altMint = 'Alt11111111111111111111111111111111111111';
        const delegations = [
            delegation(usdcMint, 'Fixed', 10n),
            delegation(altMint, 'Fixed', 20n),
            delegation(altMint, 'Recurring', 20n),
        ];

        const usdcDelegations = filterDelegationsByMint(delegations, usdcMint);
        const staleForUsdc = usdcDelegations.filter(item => item.initId !== 10n);

        assert.deepEqual(usdcDelegations, [delegations[0]]);
        assert.deepEqual(staleForUsdc, []);
    });

    test('groups only delegations for the selected mint', () => {
        const usdcMint = 'USDC1111111111111111111111111111111111111';
        const altMint = 'Alt11111111111111111111111111111111111111';
        const delegations = [
            delegation(usdcMint, 'Fixed', 10n),
            delegation(usdcMint, 'Recurring', 10n),
            delegation(altMint, 'Fixed', 20n),
        ];

        const grouped = groupDelegationsByMint(delegations, usdcMint);

        assert.equal(grouped.all.length, 2);
        assert.equal(grouped.fixed.length, 1);
        assert.equal(grouped.recurring.length, 1);
        assert.equal(
            grouped.all.every(item => item.data.mint === usdcMint),
            true,
        );
    });
});
