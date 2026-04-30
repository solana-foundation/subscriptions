import { useQuery } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { STATIC_NETWORKS, type NetworkConfig } from '@/config/networks';
import { clusterIdToNetwork } from '@/lib/cluster';
import { api } from '@/lib/api-client';

export function useNetworkConfig() {
    const { id } = useClusterConfig();
    const network = clusterIdToNetwork(id);

    return useQuery<NetworkConfig>({
        queryFn: async () => {
            if (import.meta.env.DEV) {
                try {
                    return await api.config.getNetworkConfig(network);
                } catch {
                    return STATIC_NETWORKS[network];
                }
            }
            return STATIC_NETWORKS[network];
        },
        queryKey: ['network-config', network, import.meta.env.DEV],
        retry: 2,
        staleTime: 30_000,
    });
}

export function useTokenConfig() {
    const { data, ...rest } = useNetworkConfig();
    return { data: data?.tokens, ...rest };
}

export function useProgramAddress(): string | null {
    const { data } = useNetworkConfig();
    return data?.programAddress ?? null;
}

export function useUsdcMintRaw() {
    const { data: tokens, isLoading } = useTokenConfig();
    return {
        isLoading,
        mint: tokens?.find(t => t.symbol === 'USDC')?.mint ?? null,
    };
}

export function useUsdcMint(): string | null {
    const { data: tokens } = useTokenConfig();
    return tokens?.find(t => t.symbol === 'USDC')?.mint ?? null;
}

export function useUsdcConfig() {
    const { data: tokens, ...rest } = useTokenConfig();
    const usdc = tokens?.find(t => t.symbol === 'USDC') ?? null;
    return { data: usdc, ...rest };
}
