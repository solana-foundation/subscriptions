import { useWallet } from '@solana/connector/react';
import { address, createSolanaRpc } from '@solana/kit';
import type { Plan, SubscriptionDelegation } from '@solana/subscriptions';
import {
    decodeSubscriptionDelegation,
    DELEGATEE_OFFSET,
    fetchAllMaybePlan,
    fetchAllMaybeSubscriptionAuthority,
    fetchSubscriptionsForUser,
    findSubscriptionAuthorityPda,
    type RawProgramAccount,
    SUBSCRIPTION_SIZE,
    toEncodedAccount,
} from '@solana/subscriptions';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { useQuery } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';
import type { PlanSubscriberAuthorityStatus } from '@/lib/plan-subscriber-authority';

export { getAuthorityStalePlanSubscribers, getLivePlanSubscribers } from '@/lib/plan-subscriber-authority';

export interface PlanSubscriber {
    amountPulledInPeriod: bigint;
    authorityStatus?: PlanSubscriberAuthorityStatus;
    currentPeriodStartTs: bigint;
    delegator: string;
    expiresAtTs: bigint;
    initId: bigint;
    subscriptionAddress: string;
    terms: { amount: bigint; createdAt: bigint; periodHours: bigint };
}

export interface EnrichedSubscription {
    address: string;
    authorityInitId: bigint | null;
    mint: string | null;
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

    const subMints = subs.map(s => planMap.get(s.data.header.delegatee)?.data.mint ?? null);
    const authorityInitIdByMint = await fetchAuthorityInitIdByMint(
        rpc,
        [...new Set(subMints.filter((m): m is string => m !== null))],
        address(walletAddress),
        address(progAddr),
    );

    return subs.map((s, i) => {
        const mint = subMints[i];
        return {
            address: s.address,
            authorityInitId: mint != null ? (authorityInitIdByMint.get(mint) ?? null) : null,
            mint,
            plan: planMap.get(s.data.header.delegatee) ?? null,
            subscription: s.data,
        };
    });
}

async function fetchAuthorityInitIdByMint(
    rpc: ReturnType<typeof createSolanaRpc>,
    mints: string[],
    user: ReturnType<typeof address>,
    programAddress: ReturnType<typeof address>,
): Promise<Map<string, bigint>> {
    const initIdByMint = new Map<string, bigint>();
    if (mints.length === 0) return initIdByMint;

    const authorityPdas = await Promise.all(
        mints.map(async mint => {
            const [pda] = await findSubscriptionAuthorityPda({ tokenMint: address(mint), user }, { programAddress });
            return pda;
        }),
    );
    const authorities = await fetchAllMaybeSubscriptionAuthority(rpc, authorityPdas);

    mints.forEach((mint, i) => {
        const authority = authorities[i];
        if (authority?.exists) initIdByMint.set(mint, authority.data.initId);
    });
    return initIdByMint;
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
                initId: sub.header.initId,
                subscriptionAddress: entry.pubkey,
                terms: sub.terms,
            });
        } catch {
            console.warn('Failed to decode subscription account:', entry.pubkey);
        }
    }

    return subscribers;
}

export async function resolvePlanSubscriberAuthorities(
    rpcUrl: string,
    subscribers: PlanSubscriber[],
    mint: string,
    progAddr: string,
): Promise<PlanSubscriber[]> {
    if (subscribers.length === 0) return [];

    const rpc = createSolanaRpc(rpcUrl);
    const programAddress = address(progAddr);
    const tokenMint = address(mint);
    const authorityAddresses = await Promise.all(
        subscribers.map(async subscriber => {
            const [authorityAddress] = await findSubscriptionAuthorityPda(
                { tokenMint, user: address(subscriber.delegator) },
                { programAddress },
            );
            return authorityAddress;
        }),
    );
    const authorities = await fetchAllMaybeSubscriptionAuthority(rpc, authorityAddresses);
    const ataDelegates = await fetchAtaDelegates(
        rpc,
        tokenMint,
        subscribers.map(s => address(s.delegator)),
    );

    return subscribers.map((subscriber, index) => {
        const authority = authorities[index];
        const isCurrentGeneration = authority?.exists && authority.data.initId === subscriber.initId;
        const isDelegatedToAuthority = ataDelegates[index] === String(authorityAddresses[index]);
        const authorityStatus: PlanSubscriberAuthorityStatus =
            isCurrentGeneration && isDelegatedToAuthority ? 'live' : authority?.exists ? 'rotated' : 'missing';
        return { ...subscriber, authorityStatus };
    });
}

async function fetchAtaDelegates(
    rpc: ReturnType<typeof createSolanaRpc>,
    mint: ReturnType<typeof address>,
    owners: ReturnType<typeof address>[],
): Promise<(string | null)[]> {
    if (owners.length === 0) return [];

    const mintInfo = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
    const tokenProgram =
        mintInfo.value?.owner === TOKEN_2022_PROGRAM_ADDRESS ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;

    const ataAddresses = await Promise.all(
        owners.map(async owner => {
            const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram });
            return ata;
        }),
    );

    const delegates: (string | null)[] = [];
    for (let i = 0; i < ataAddresses.length; i += 100) {
        const chunk = ataAddresses.slice(i, i + 100);
        const { value } = await rpc.getMultipleAccounts(chunk, { encoding: 'jsonParsed' }).send();
        for (const account of value) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delegates.push((account?.data as any)?.parsed?.info?.delegate ?? null);
        }
    }
    return delegates;
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
