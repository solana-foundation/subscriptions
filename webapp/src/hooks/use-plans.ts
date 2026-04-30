import { useWallet } from '@solana/connector/react';
import { address, createSolanaRpc } from '@solana/kit';
import type { PlanData } from '@subscriptions/client';
import { fetchPlansForOwner } from '@subscriptions/client';
import { useQuery } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';

export interface PlanItem {
    address: string;
    data: PlanData;
    owner: string;
    status: number;
}

async function fetchPlansByMerchant(rpcUrl: string, merchantAddress: string, progAddr: string): Promise<PlanItem[]> {
    const rpc = createSolanaRpc(rpcUrl);
    const plans = await fetchPlansForOwner(rpc, address(merchantAddress), address(progAddr));

    return plans.map(p => ({
        address: p.address,
        data: p.data.data,
        owner: p.data.owner,
        status: p.data.status,
    }));
}

export function useMerchantPlans(merchantAddress: string | null) {
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();

    return useQuery({
        enabled: !!merchantAddress && merchantAddress.length > 30 && !!progAddr,
        queryFn: () => fetchPlansByMerchant(clusterConfig.url, merchantAddress!, progAddr!),
        queryKey: ['plans', merchantAddress, clusterConfig.id],
    });
}

export function useMyPlans() {
    const { account } = useWallet();
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();

    return useQuery({
        enabled: !!account && !!progAddr,
        queryFn: () => fetchPlansByMerchant(clusterConfig.url, account!, progAddr!),
        queryKey: ['plans', 'my', account, clusterConfig.id],
    });
}
