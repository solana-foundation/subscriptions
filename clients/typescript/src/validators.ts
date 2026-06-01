import type { Address } from '@solana/kit';

import { MAX_PLAN_DESTINATIONS, MAX_PLAN_PULLERS, METADATA_URI_LEN, ZERO_ADDRESS } from './constants.js';

const textEncoder = new TextEncoder();

/** Client-side validation failure (e.g. max destinations exceeded). */
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

export function assertPositive(value: bigint | number, name: string): void {
    if (BigInt(value) <= 0n) throw new ValidationError(`${name} must be greater than zero`);
}

export function assertSafeU64(value: bigint | number, name: string): void {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new ValidationError(`${name} must be a bigint or a safe integer (numbers above 2^53-1 lose precision)`);
}

export function assertMetadataUri(metadataUri: string): void {
    if (textEncoder.encode(metadataUri).length > METADATA_URI_LEN)
        throw new ValidationError(`metadataUri exceeds ${METADATA_URI_LEN} bytes`);
}

export function assertMaxLen(arr: unknown[], max: number, name: string): void {
    if (arr.length > max) throw new ValidationError(`${name} must have at most ${max} entries`);
}

export function padAddresses(addresses: Address[], maxLen: number): Address[] {
    return Array.from({ length: maxLen }, (_, i) => addresses[i] ?? ZERO_ADDRESS);
}

export function padPlanDestinations(addresses: Address[]): Address[] {
    assertMaxLen(addresses, MAX_PLAN_DESTINATIONS, 'destinations');
    return padAddresses(addresses, MAX_PLAN_DESTINATIONS);
}

export function padPlanPullers(addresses: Address[]): [Address, Address, Address, Address] {
    assertMaxLen(addresses, MAX_PLAN_PULLERS, 'pullers');
    return padAddresses(addresses, MAX_PLAN_PULLERS) as [Address, Address, Address, Address];
}
