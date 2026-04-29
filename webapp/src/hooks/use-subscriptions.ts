import { useQuery } from '@tanstack/react-query'
import { useWalletUi } from '@wallet-ui/react'
import { createSolanaRpc, address } from '@solana/kit'
import type { Address } from '@solana/kit'
import {
  SUBSCRIPTION_SIZE,
  DELEGATEE_OFFSET,
  fetchSubscriptionsForUser,
  fetchAllMaybePlan,
  decodeSubscriptionDelegation,
  toEncodedAccount,
  type RawProgramAccount,
} from '@subscriptions/client'
import type { SubscriptionDelegation, Plan } from '@subscriptions/client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'

export interface PlanSubscriber {
  subscriptionAddress: string
  delegator: string
  terms: { amount: bigint; periodHours: bigint; createdAt: bigint }
  amountPulledInPeriod: bigint
  currentPeriodStartTs: bigint
  expiresAtTs: bigint
}

export interface EnrichedSubscription {
  address: string
  subscription: SubscriptionDelegation
  plan: Plan | null
}

async function fetchMySubscriptions(rpcUrl: string, walletAddress: string, progAddr: string): Promise<EnrichedSubscription[]> {
  const rpc = createSolanaRpc(rpcUrl)
  const subs = await fetchSubscriptionsForUser(rpc, address(walletAddress), address(progAddr))
  if (subs.length === 0) return []

  const planAddresses = [...new Set(subs.map((s) => s.data.header.delegatee))]
  const maybePlans = await fetchAllMaybePlan(rpc, planAddresses as Address[])

  const planMap = new Map<string, Plan>()
  for (const mp of maybePlans) {
    if (mp.exists) planMap.set(mp.address, mp.data)
  }

  return subs.map((s) => ({
    address: s.address as string,
    subscription: s.data,
    plan: planMap.get(s.data.header.delegatee) ?? null,
  }))
}

export async function fetchPlanSubscriptions(rpcUrl: string, planAddress: string, progAddr: string): Promise<PlanSubscriber[]> {
  const rpc = createSolanaRpc(rpcUrl)
  const programAddress = address(progAddr)

  const response = await rpc
    .getProgramAccounts(programAddress, {
      filters: [
        { dataSize: BigInt(SUBSCRIPTION_SIZE) },
        {
          memcmp: {
            offset: BigInt(DELEGATEE_OFFSET),
            bytes: planAddress,
            encoding: 'base58',
          },
        },
      ],
      encoding: 'base64',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .send()

  const accounts = response as unknown as RawProgramAccount[]
  if (accounts.length === 0) return []

  const subscribers: PlanSubscriber[] = []

  for (const entry of accounts) {
    try {
      const encoded = toEncodedAccount(entry, programAddress)
      const decoded = decodeSubscriptionDelegation(encoded)
      const sub = decoded.data
      subscribers.push({
        subscriptionAddress: entry.pubkey as string,
        delegator: sub.header.delegator,
        terms: sub.terms,
        amountPulledInPeriod: sub.amountPulledInPeriod,
        currentPeriodStartTs: sub.currentPeriodStartTs,
        expiresAtTs: sub.expiresAtTs,
      })
    } catch {
      console.warn('Failed to decode subscription account:', entry.pubkey)
    }
  }

  return subscribers
}

export function useMySubscriptions() {
  const { account } = useWalletUi()
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()

  return useQuery({
    queryKey: ['subscriptions', 'my', account?.address, clusterConfig.id],
    queryFn: () => fetchMySubscriptions(clusterConfig.url, account!.address, progAddr!),
    enabled: !!account?.address && !!progAddr,
  })
}

async function fetchSubscriberCount(rpcUrl: string, planAddress: string, progAddr: string): Promise<number> {
  const rpc = createSolanaRpc(rpcUrl)

  const response = await rpc
    .getProgramAccounts(address(progAddr), {
      filters: [
        { dataSize: BigInt(SUBSCRIPTION_SIZE) },
        {
          memcmp: {
            offset: BigInt(DELEGATEE_OFFSET),
            bytes: planAddress,
            encoding: 'base58',
          },
        },
      ],
      dataSlice: { offset: 0, length: 0 },
      encoding: 'base64',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .send()

  return (response as unknown as unknown[]).length
}

export function useSubscriberCount(planAddress: string | null) {
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()

  return useQuery({
    queryKey: ['subscriberCount', planAddress, clusterConfig.id],
    queryFn: () => fetchSubscriberCount(clusterConfig.url, planAddress!, progAddr!),
    enabled: !!planAddress && !!progAddr,
  })
}

async function fetchSubscriberCounts(rpcUrl: string, planAddresses: string[], progAddr: string): Promise<Map<string, number>> {
  const counts = await Promise.all(
    planAddresses.map((addr) => fetchSubscriberCount(rpcUrl, addr, progAddr))
  )
  const map = new Map<string, number>()
  planAddresses.forEach((addr, i) => map.set(addr, counts[i]))
  return map
}

export function useSubscriberCounts(planAddresses: string[]) {
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()
  const key = planAddresses.slice().sort().join(',')

  return useQuery({
    queryKey: ['subscriberCounts', key, clusterConfig.id],
    queryFn: () => fetchSubscriberCounts(clusterConfig.url, planAddresses, progAddr!),
    enabled: planAddresses.length > 0 && !!progAddr,
  })
}
