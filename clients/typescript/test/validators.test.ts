import { describe, expect, test } from 'vitest';

import { assertSafeU64, ValidationError } from '../src/validators.ts';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

describe('assertSafeU64', () => {
    test('accepts any bigint, including values above 2^53-1', () => {
        expect(() => assertSafeU64(MAX_SAFE + 1n, 'planId')).not.toThrow();
        expect(() => assertSafeU64(18_446_744_073_709_551_615n, 'planId')).not.toThrow();
    });

    test('accepts numbers at or below 2^53-1', () => {
        expect(() => assertSafeU64(Number.MAX_SAFE_INTEGER, 'planId')).not.toThrow();
        expect(() => assertSafeU64(0, 'planId')).not.toThrow();
    });

    test('rejects unsafe numbers that silently round', () => {
        const rounded = JSON.parse('{"planId":9007199254740995}').planId as number;
        expect(rounded).toBe(9007199254740996);
        expect(() => assertSafeU64(rounded, 'planId')).toThrow(ValidationError);
    });
});
