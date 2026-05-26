import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatPlanTokenAmount, formatTokenAmount, resolvePlanTokenDisplay } from '../src/lib/token-display.ts';

describe('token display', () => {
    test('formats known token amounts using configured decimals and symbol', () => {
        const token = resolvePlanTokenDisplay('Mint1111111111111111111111111111111111111', [
            {
                decimals: 6,
                mint: 'Mint1111111111111111111111111111111111111',
                name: 'USD Coin',
                symbol: 'USDC',
            },
        ]);

        assert.equal(token.supported, true);
        assert.equal(formatPlanTokenAmount(5_250_000n, token), '5.25 USDC');
    });

    test('does not apply configured token decimals to unknown mints', () => {
        const token = resolvePlanTokenDisplay('Alt11111111111111111111111111111111111111', [
            {
                decimals: 6,
                mint: 'Mint1111111111111111111111111111111111111',
                name: 'USD Coin',
                symbol: 'USDC',
            },
        ]);

        assert.equal(token.supported, false);
        assert.equal(formatPlanTokenAmount(5_250_000n, token), '5,250,000 raw units');
    });

    test('trims insignificant decimal zeroes', () => {
        assert.equal(formatTokenAmount(1_230_000n, 6), '1.23');
        assert.equal(formatTokenAmount(1_000_000n, 6), '1');
    });
});
