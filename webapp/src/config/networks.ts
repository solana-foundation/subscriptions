import type { Network } from '@/lib/cluster';

export interface TokenConfig {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
}

export interface NetworkConfig {
    programAddress: string | null;
    tokens: TokenConfig[];
}

const PROGRAM_ID = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44';

const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const STATIC_NETWORKS: Record<Network, NetworkConfig> = {
    localnet: {
        programAddress: import.meta.env.VITE_LOCALNET_PROGRAM ?? PROGRAM_ID,
        tokens: import.meta.env.VITE_LOCALNET_USDC_MINT
            ? [
                  {
                      symbol: 'USDC',
                      name: 'USD Coin (mock)',
                      mint: import.meta.env.VITE_LOCALNET_USDC_MINT,
                      decimals: 6,
                  },
              ]
            : [],
    },
    devnet: {
        programAddress: PROGRAM_ID,
        tokens: [{ symbol: 'USDC', name: 'USD Coin', mint: DEVNET_USDC, decimals: 6 }],
    },
    testnet: {
        programAddress: PROGRAM_ID,
        tokens: [],
    },
    mainnet: {
        programAddress: PROGRAM_ID,
        tokens: [{ symbol: 'USDC', name: 'USD Coin', mint: MAINNET_USDC, decimals: 6 }],
    },
};
