import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { type PlanItem, useMyPlans } from '@/hooks/use-plans';
import {
    fetchPlanSubscriptions,
    getAuthorityStalePlanSubscribers,
    getLivePlanSubscribers,
    type PlanSubscriber,
    resolvePlanSubscriberAuthorities,
    useSubscriberCounts,
} from '@/hooks/use-subscriptions';
import { getBlockTimestamp } from '@/hooks/use-time-travel';
import { useProgramAddress } from '@/hooks/use-token-config';
import {
    computeEligibleSubscribers,
    type EligibleSubscriber,
    getStalePlanSubscribers,
    hasMatchingPlanTerms,
} from '@/lib/collect-utils';

export interface PlanSubscriberData {
    activeCount: number;
    cancelledCount: number;
    currentSubscribers: PlanSubscriber[];
    eligible: EligibleSubscriber[];
    plan: PlanItem;
    staleAuthoritySubscribers: PlanSubscriber[];
    staleSubscribers: PlanSubscriber[];
    subscribers: PlanSubscriber[];
    totalPending: bigint;
}

export interface AllPlanSubscriberData {
    blockTimestamp: number;
    plans: PlanSubscriberData[];
    plansWithPending: number;
    totalActiveSubscribers: number;
    totalPendingAmount: bigint;
}

export function useAllPlanSubscribers() {
    const { data: plans, isLoading: plansLoading } = useMyPlans();
    const planAddresses = useMemo(() => plans?.map(p => p.address) ?? [], [plans]);
    const { data: subCounts, isLoading: countsLoading } = useSubscriberCounts(planAddresses);
    const { url: rpcUrl } = useClusterConfig();
    const progAddr = useProgramAddress();

    const plansWithSubs = useMemo(() => {
        if (!plans || !subCounts) return [];
        return plans.filter(p => (subCounts.get(p.address) ?? 0) > 0);
    }, [plans, subCounts]);

    const query = useQuery({
        enabled: plansWithSubs.length > 0 && !!progAddr,
        queryFn: async (): Promise<AllPlanSubscriberData> => {
            const blockTimestamp = await getBlockTimestamp(rpcUrl);

            const planDataArr = await Promise.all(
                plansWithSubs.map(async (plan): Promise<PlanSubscriberData> => {
                    const subscribers = await resolvePlanSubscriberAuthorities(
                        rpcUrl,
                        await fetchPlanSubscriptions(rpcUrl, plan.address, progAddr!),
                        plan.data.mint,
                        progAddr!,
                    );
                    const liveSubscribers = getLivePlanSubscribers(subscribers);
                    const staleAuthoritySubscribers = getAuthorityStalePlanSubscribers(subscribers);
                    const staleSubscribers = getStalePlanSubscribers(liveSubscribers, plan.data.terms);
                    const currentSubscribers = liveSubscribers.filter(sub =>
                        hasMatchingPlanTerms(sub, plan.data.terms),
                    );
                    const eligible = computeEligibleSubscribers(liveSubscribers, plan.data.terms, blockTimestamp);
                    const totalPending = eligible.reduce((sum, e) => sum + e.collectAmount, 0n);
                    const activeCount = currentSubscribers.filter(s => s.expiresAtTs === 0n).length;
                    const cancelledCount = currentSubscribers.filter(
                        s => s.expiresAtTs !== 0n && blockTimestamp < Number(s.expiresAtTs),
                    ).length;

                    return {
                        activeCount,
                        cancelledCount,
                        currentSubscribers,
                        eligible,
                        plan,
                        staleAuthoritySubscribers,
                        staleSubscribers,
                        subscribers,
                        totalPending,
                    };
                }),
            );

            const totalPendingAmount = planDataArr.reduce((sum, p) => sum + p.totalPending, 0n);
            const totalActiveSubscribers = planDataArr.reduce((sum, p) => sum + p.activeCount, 0);
            const plansWithPending = planDataArr.filter(p => p.eligible.length > 0).length;

            return { blockTimestamp, plans: planDataArr, plansWithPending, totalActiveSubscribers, totalPendingAmount };
        },
        queryKey: ['allPlanSubscribers', plansWithSubs.map(p => p.address).join(',')],
        refetchInterval: 60_000,
    });

    return {
        ...query,
        allPlans: plans,
        isLoading: plansLoading || countsLoading || query.isLoading,
        plansWithSubs,
        subCounts,
    };
}
