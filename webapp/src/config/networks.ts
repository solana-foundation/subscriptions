import type { Network } from '@/lib/cluster';

export interface TokenConfig {
    decimals: number;
    mint: string;
    name: string;
    symbol: string;
}

export interface NetworkConfig {
    programAddress: string | null;
    tokens: TokenConfig[];
}

const PROGRAM_ID = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44';

const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const STATIC_NETWORKS: Record<Network, NetworkConfig> = {
    devnet: {
        programAddress: PROGRAM_ID,
        tokens: [{ decimals: 6, mint: DEVNET_USDC, name: 'USD Coin', symbol: 'USDC' }],
    },
    localnet: {
        programAddress: import.meta.env.VITE_LOCALNET_PROGRAM ?? PROGRAM_ID,
        tokens: import.meta.env.VITE_LOCALNET_USDC_MINT
            ? [
                  {
                      decimals: 6,
                      mint: import.meta.env.VITE_LOCALNET_USDC_MINT,
                      name: 'USD Coin (mock)',
                      symbol: 'USDC',
                  },
              ]
            : [],
    },
    mainnet: {
        programAddress: PROGRAM_ID,
        tokens: [{ decimals: 6, mint: MAINNET_USDC, name: 'USD Coin', symbol: 'USDC' }],
    },
    testnet: {
        programAddress: PROGRAM_ID,
        tokens: [],
    },
};

export interface Features {
    revokeAbandonedDelegation: boolean;
    startNowRecurringDelegation: boolean;
}

const SOAK_FEATURES: Features = {
    revokeAbandonedDelegation: true,
    startNowRecurringDelegation: true,
};

const STABLE_FEATURES: Features = {
    revokeAbandonedDelegation: false,
    startNowRecurringDelegation: false,
};

export const FEATURES: Record<Network, Features> = {
    devnet: SOAK_FEATURES,
    localnet: SOAK_FEATURES,
    mainnet: STABLE_FEATURES,
    testnet: STABLE_FEATURES,
};
