export type Network = 'localnet' | 'devnet' | 'testnet' | 'mainnet' | 'custom';

export function clusterIdToNetwork(id: string): Network {
    if (id === 'solana:custom') return 'custom';
    if (id.includes('devnet')) return 'devnet';
    if (id.includes('testnet')) return 'testnet';
    if (id.includes('mainnet')) return 'mainnet';
    return 'localnet';
}
