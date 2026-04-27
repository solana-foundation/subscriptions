import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWalletUi } from '@wallet-ui/react'
import { createSolanaRpc, address } from 'gill'
import {
  fetchDelegationsByDelegator,
  fetchDelegationsByDelegatee,
  type Delegation,
} from '@subscriptions/client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'

export interface DelegationData {
  header: {
    delegator: string
    delegatee: string
    payer: string
    version: number
    initId: bigint
  }
  amount: bigint
  amountPerPeriod: bigint
  periodLengthS: bigint
  expiryTs: bigint
  amountPulledInPeriod: bigint
  currentPeriodStartTs: bigint | null
}

export interface DelegationItem {
  address: string
  type: 'Fixed' | 'Recurring'
  data: DelegationData
}

export interface GroupedDelegations {
  fixed: DelegationItem[]
  recurring: DelegationItem[]
  all: DelegationItem[]
}

export type DelegationRole = 'delegator' | 'delegatee'

function toDelegationItem(d: Delegation): DelegationItem | null {
  if (d.kind === 'fixed') {
    return {
      address: d.address,
      type: 'Fixed',
      data: { ...d.data, currentPeriodStartTs: null } as unknown as DelegationData,
    }
  }
  if (d.kind === 'recurring') {
    return {
      address: d.address,
      type: 'Recurring',
      data: d.data as unknown as DelegationData,
    }
  }
  return null
}

async function fetchDelegationsByRole(
  rpcUrl: string,
  walletAddress: string,
  role: DelegationRole,
  progAddr: string,
): Promise<GroupedDelegations> {
  const rpc = createSolanaRpc(rpcUrl)
  const fetchFn = role === 'delegator' ? fetchDelegationsByDelegator : fetchDelegationsByDelegatee
  const delegations = await fetchFn(rpc, address(walletAddress), address(progAddr))
  const all = delegations.map(toDelegationItem).filter((d): d is DelegationItem => d !== null)

  return {
    fixed: all.filter((d) => d.type === 'Fixed'),
    recurring: all.filter((d) => d.type === 'Recurring'),
    all,
  }
}

function useDelegationsByRole(role: DelegationRole) {
  const { account, cluster } = useWalletUi()
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['delegations', role, account?.address, cluster.id],
    queryFn: async (): Promise<GroupedDelegations> => {
      if (!account?.address) {
        return { fixed: [], recurring: [], all: [] }
      }
      return fetchDelegationsByRole(clusterConfig.url, account.address, role, progAddr!)
    },
    enabled: !!account?.address && !!progAddr,
    staleTime: 15_000,
    retry: 1,
  })

  const refetch = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['delegations', role, account?.address, cluster.id],
    })
    await query.refetch()
  }

  return {
    ...query,
    refetch,
    fixed: query.data?.fixed ?? [],
    recurring: query.data?.recurring ?? [],
    all: query.data?.all ?? [],
    isEmpty: (query.data?.all.length ?? 0) === 0,
  }
}

/**
 * Hook to fetch delegations where the connected wallet is the DELEGATOR.
 * These are delegations the user has created (outgoing).
 */
export function useDelegations() {
  return useDelegationsByRole('delegator')
}

/**
 * Hook to fetch delegations where the connected wallet is the DELEGATEE.
 * These are delegations others have created for the user (incoming).
 */
export function useIncomingDelegations() {
  return useDelegationsByRole('delegatee')
}
