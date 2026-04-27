import { useQuery } from '@tanstack/react-query'
import { useWalletUi } from '@wallet-ui/react'
import { createSolanaRpc, address } from 'gill'
import { fetchPlansForOwner } from '@subscriptions/client'
import type { PlanData } from '@subscriptions/client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'

export interface PlanItem {
  address: string
  owner: string
  status: number
  data: PlanData
}

async function fetchPlansByMerchant(rpcUrl: string, merchantAddress: string, progAddr: string): Promise<PlanItem[]> {
  const rpc = createSolanaRpc(rpcUrl)
  const plans = await fetchPlansForOwner(rpc, address(merchantAddress), address(progAddr))

  return plans.map((p) => ({
    address: p.address,
    owner: p.data.owner,
    status: p.data.status,
    data: p.data.data,
  }))
}

export function useMerchantPlans(merchantAddress: string | null) {
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()

  return useQuery({
    queryKey: ['plans', merchantAddress, clusterConfig.id],
    queryFn: () => fetchPlansByMerchant(clusterConfig.url, merchantAddress!, progAddr!),
    enabled: !!merchantAddress && merchantAddress.length > 30 && !!progAddr,
  })
}

export function useMyPlans() {
  const { account } = useWalletUi()
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()

  return useQuery({
    queryKey: ['plans', 'my', account?.address, clusterConfig.id],
    queryFn: () => fetchPlansByMerchant(clusterConfig.url, account!.address, progAddr!),
    enabled: !!account?.address && !!progAddr,
  })
}
