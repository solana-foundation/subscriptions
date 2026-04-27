'use client';

import type { Address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID as CLIENT_PROGRAM_ID } from '@subscriptions/client';

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const PROGRAM_ID_STORAGE_KEY = 'subscriptions-program-id';

export function getDefaultProgramAddress(): Address {
    return (process.env.NEXT_PUBLIC_PROGRAM_ID ?? CLIENT_PROGRAM_ID) as Address;
}

function isValidProgramAddress(value: string) {
    try {
        void new PublicKey(value);
        return true;
    } catch {
        return false;
    }
}

export function getStoredProgramAddress(): Address | null {
    if (typeof window === 'undefined') return null;
    const storedValue = window.localStorage.getItem(PROGRAM_ID_STORAGE_KEY)?.trim();
    if (!storedValue || !isValidProgramAddress(storedValue)) return null;
    return storedValue as Address;
}

export function setStoredProgramAddress(value: string): Address | null {
    const normalized = value.trim();
    if (!normalized || !isValidProgramAddress(normalized)) return null;
    window.localStorage.setItem(PROGRAM_ID_STORAGE_KEY, normalized);
    return normalized as Address;
}

export function clearStoredProgramAddress() {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(PROGRAM_ID_STORAGE_KEY);
}

export function getProgramAddress(): Address {
    return getStoredProgramAddress() ?? getDefaultProgramAddress();
}
