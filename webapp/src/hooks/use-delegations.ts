import { useCluster, useWallet } from '@solana/connector/react';
import { address, createSolanaRpc } from '@solana/kit';
import { type Delegation, fetchDelegationsByDelegatee, fetchDelegationsByDelegator } from '@solana/subscriptions';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';
import { groupDelegations } from '@/lib/delegation-filters';

export interface DelegationData {
    amount: bigint;
    amountPerPeriod: bigint;
    amountPulledInPeriod: bigint;
    currentPeriodStartTs: bigint | null;
    expiryTs: bigint;
    header: {
        delegatee: string;
        delegator: string;
        initId: bigint;
        payer: string;
        version: number;
    };
    mint: string;
    periodLengthS: bigint;
}

export interface DelegationItem {
    address: string;
    data: DelegationData;
    type: 'Fixed' | 'Recurring';
}

export interface GroupedDelegations {
    all: DelegationItem[];
    fixed: DelegationItem[];
    recurring: DelegationItem[];
}

export type DelegationRole = 'delegatee' | 'delegator';

function toDelegationItem(d: Delegation): DelegationItem | null {
    if (d.kind === 'fixed') {
        return {
            address: d.address,
            data: { ...d.data, currentPeriodStartTs: null } as unknown as DelegationData,
            type: 'Fixed',
        };
    }
    if (d.kind === 'recurring') {
        return {
            address: d.address,
            data: d.data as unknown as DelegationData,
            type: 'Recurring',
        };
    }
    return null;
}

async function fetchDelegationsByRole(
    rpcUrl: string,
    walletAddress: string,
    role: DelegationRole,
    progAddr: string,
): Promise<GroupedDelegations> {
    const rpc = createSolanaRpc(rpcUrl);
    const fetchFn = role === 'delegator' ? fetchDelegationsByDelegator : fetchDelegationsByDelegatee;
    const delegations = await fetchFn(rpc, address(walletAddress), address(progAddr));
    const all = delegations.map(toDelegationItem).filter((d): d is DelegationItem => d !== null);

    return groupDelegations(all);
}

function useDelegationsByRole(role: DelegationRole) {
    const { account } = useWallet();
    const { cluster } = useCluster();
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();
    const queryClient = useQueryClient();

    const query = useQuery({
        enabled: !!account && !!progAddr,
        queryFn: async (): Promise<GroupedDelegations> => {
            if (!account) {
                return { all: [], fixed: [], recurring: [] };
            }
            return await fetchDelegationsByRole(clusterConfig.url, account, role, progAddr!);
        },
        queryKey: ['delegations', role, account, cluster?.id],
        retry: 1,
        staleTime: 15_000,
    });

    const refetch = async () => {
        await queryClient.invalidateQueries({
            queryKey: ['delegations', role, account, cluster?.id],
        });
        await query.refetch();
    };

    return {
        ...query,
        all: query.data?.all ?? [],
        fixed: query.data?.fixed ?? [],
        isEmpty: (query.data?.all.length ?? 0) === 0,
        recurring: query.data?.recurring ?? [],
        refetch,
    };
}

/**
 * Hook to fetch delegations where the connected wallet is the DELEGATOR.
 * These are delegations the user has created (outgoing).
 */
export function useDelegations() {
    return useDelegationsByRole('delegator');
}

/**
 * Hook to fetch delegations where the connected wallet is the DELEGATEE.
 * These are delegations others have created for the user (incoming).
 */
export function useIncomingDelegations() {
    return useDelegationsByRole('delegatee');
}
