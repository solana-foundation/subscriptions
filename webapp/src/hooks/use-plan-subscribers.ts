import { useQuery } from '@tanstack/react-query'
import { useMyPlans, type PlanItem } from '@/hooks/use-plans'
import { useSubscriberCounts, fetchPlanSubscriptions, type PlanSubscriber } from '@/hooks/use-subscriptions'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'
import { getBlockTimestamp } from '@/hooks/use-time-travel'
import {
  computeEligibleSubscribers,
  getStalePlanSubscribers,
  hasMatchingPlanTerms,
  type EligibleSubscriber,
} from '@/lib/collect-utils'
import { useMemo } from 'react'

export interface PlanSubscriberData {
  plan: PlanItem
  subscribers: PlanSubscriber[]
  currentSubscribers: PlanSubscriber[]
  staleSubscribers: PlanSubscriber[]
  eligible: EligibleSubscriber[]
  totalPending: bigint
  activeCount: number
  cancelledCount: number
}

export interface AllPlanSubscriberData {
  plans: PlanSubscriberData[]
  totalPendingAmount: bigint
  totalActiveSubscribers: number
  plansWithPending: number
  blockTimestamp: number
}

export function useAllPlanSubscribers() {
  const { data: plans, isLoading: plansLoading } = useMyPlans()
  const planAddresses = useMemo(() => plans?.map((p) => p.address) ?? [], [plans])
  const { data: subCounts, isLoading: countsLoading } = useSubscriberCounts(planAddresses)
  const { url: rpcUrl } = useClusterConfig()
  const progAddr = useProgramAddress()

  const plansWithSubs = useMemo(() => {
    if (!plans || !subCounts) return []
    return plans.filter((p) => (subCounts.get(p.address) ?? 0) > 0)
  }, [plans, subCounts])

  const query = useQuery({
    queryKey: ['allPlanSubscribers', plansWithSubs.map((p) => p.address).join(',')],
    queryFn: async (): Promise<AllPlanSubscriberData> => {
      const blockTimestamp = await getBlockTimestamp(rpcUrl)

      const planDataArr = await Promise.all(
        plansWithSubs.map(async (plan): Promise<PlanSubscriberData> => {
          const subscribers = await fetchPlanSubscriptions(rpcUrl, plan.address, progAddr!)
          const staleSubscribers = getStalePlanSubscribers(subscribers, plan.data.terms)
          const currentSubscribers = subscribers.filter((sub) =>
            hasMatchingPlanTerms(sub, plan.data.terms),
          )
          const eligible = computeEligibleSubscribers(
            subscribers,
            plan.data.terms,
            blockTimestamp,
          )
          const totalPending = eligible.reduce((sum, e) => sum + e.collectAmount, 0n)
          const activeCount = currentSubscribers.filter((s) => s.expiresAtTs === 0n).length
          const cancelledCount = currentSubscribers.filter(
            (s) => s.expiresAtTs !== 0n && blockTimestamp < Number(s.expiresAtTs),
          ).length

          return {
            plan,
            subscribers,
            currentSubscribers,
            staleSubscribers,
            eligible,
            totalPending,
            activeCount,
            cancelledCount,
          }
        }),
      )

      const totalPendingAmount = planDataArr.reduce((sum, p) => sum + p.totalPending, 0n)
      const totalActiveSubscribers = planDataArr.reduce((sum, p) => sum + p.activeCount, 0)
      const plansWithPending = planDataArr.filter((p) => p.eligible.length > 0).length

      return { plans: planDataArr, totalPendingAmount, totalActiveSubscribers, plansWithPending, blockTimestamp }
    },
    enabled: plansWithSubs.length > 0 && !!progAddr,
    refetchInterval: 60_000,
  })

  return {
    ...query,
    isLoading: plansLoading || countsLoading || query.isLoading,
    allPlans: plans,
    subCounts,
    plansWithSubs,
  }
}
