import { useWallet } from '@solana/connector/react';
import { address, createSolanaRpc } from '@solana/kit';
import type { Plan, SubscriptionDelegation } from '@solana/subscriptions';
import {
    decodeSubscriptionDelegation,
    DELEGATEE_OFFSET,
    fetchAllMaybePlan,
    fetchSubscriptionsForUser,
    type RawProgramAccount,
    SUBSCRIPTION_SIZE,
    toEncodedAccount,
} from '@solana/subscriptions';
import { useQuery } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';

export interface PlanSubscriber {
    amountPulledInPeriod: bigint;
    currentPeriodStartTs: bigint;
    delegator: string;
    expiresAtTs: bigint;
    subscriptionAddress: string;
    terms: { amount: bigint; createdAt: bigint; periodHours: bigint };
}

export interface EnrichedSubscription {
    address: string;
    plan: Plan | null;
    subscription: SubscriptionDelegation;
}

async function fetchMySubscriptions(
    rpcUrl: string,
    walletAddress: string,
    progAddr: string,
): Promise<EnrichedSubscription[]> {
    const rpc = createSolanaRpc(rpcUrl);
    const subs = await fetchSubscriptionsForUser(rpc, address(walletAddress), address(progAddr));
    if (subs.length === 0) return [];

    const planAddresses = [...new Set(subs.map(s => s.data.header.delegatee))];
    const maybePlans = await fetchAllMaybePlan(rpc, planAddresses);

    const planMap = new Map<string, Plan>();
    for (const mp of maybePlans) {
        if (mp.exists) planMap.set(mp.address, mp.data);
    }

    return subs.map(s => ({
        address: s.address,
        plan: planMap.get(s.data.header.delegatee) ?? null,
        subscription: s.data,
    }));
}

export async function fetchPlanSubscriptions(
    rpcUrl: string,
    planAddress: string,
    progAddr: string,
): Promise<PlanSubscriber[]> {
    const rpc = createSolanaRpc(rpcUrl);
    const programAddress = address(progAddr);

    const response = await rpc
        .getProgramAccounts(programAddress, {
            encoding: 'base64',
            filters: [
                { dataSize: BigInt(SUBSCRIPTION_SIZE) },
                {
                    memcmp: {
                        bytes: planAddress,
                        encoding: 'base58',
                        offset: BigInt(DELEGATEE_OFFSET),
                    },
                },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .send();

    const accounts = response as unknown as RawProgramAccount[];
    if (accounts.length === 0) return [];

    const subscribers: PlanSubscriber[] = [];

    for (const entry of accounts) {
        try {
            const encoded = toEncodedAccount(entry, programAddress);
            const decoded = decodeSubscriptionDelegation(encoded);
            const sub = decoded.data;
            subscribers.push({
                amountPulledInPeriod: sub.amountPulledInPeriod,
                currentPeriodStartTs: sub.currentPeriodStartTs,
                delegator: sub.header.delegator,
                expiresAtTs: sub.expiresAtTs,
                subscriptionAddress: entry.pubkey,
                terms: sub.terms,
            });
        } catch {
            console.warn('Failed to decode subscription account:', entry.pubkey);
        }
    }

    return subscribers;
}

export function useMySubscriptions() {
    const { account } = useWallet();
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();

    return useQuery({
        enabled: !!account && !!progAddr,
        queryFn: () => fetchMySubscriptions(clusterConfig.url, account!, progAddr!),
        queryKey: ['subscriptions', 'my', account, clusterConfig.id],
    });
}

async function fetchSubscriberCount(rpcUrl: string, planAddress: string, progAddr: string): Promise<number> {
    const rpc = createSolanaRpc(rpcUrl);

    const response = await rpc
        .getProgramAccounts(address(progAddr), {
            dataSlice: { length: 0, offset: 0 },
            encoding: 'base64',
            filters: [
                { dataSize: BigInt(SUBSCRIPTION_SIZE) },
                {
                    memcmp: {
                        bytes: planAddress,
                        encoding: 'base58',
                        offset: BigInt(DELEGATEE_OFFSET),
                    },
                },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .send();

    return (response as unknown as unknown[]).length;
}

export function useSubscriberCount(planAddress: string | null) {
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();

    return useQuery({
        enabled: !!planAddress && !!progAddr,
        queryFn: () => fetchSubscriberCount(clusterConfig.url, planAddress!, progAddr!),
        queryKey: ['subscriberCount', planAddress, clusterConfig.id],
    });
}

async function fetchSubscriberCounts(
    rpcUrl: string,
    planAddresses: string[],
    progAddr: string,
): Promise<Map<string, number>> {
    const counts = await Promise.all(planAddresses.map(addr => fetchSubscriberCount(rpcUrl, addr, progAddr)));
    const map = new Map<string, number>();
    planAddresses.forEach((addr, i) => map.set(addr, counts[i]));
    return map;
}

export function useSubscriberCounts(planAddresses: string[]) {
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();
    const key = planAddresses.slice().sort().join(',');

    return useQuery({
        enabled: planAddresses.length > 0 && !!progAddr,
        queryFn: () => fetchSubscriberCounts(clusterConfig.url, planAddresses, progAddr!),
        queryKey: ['subscriberCounts', key, clusterConfig.id],
    });
}
