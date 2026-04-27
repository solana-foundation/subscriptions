import { Route, Routes, Navigate, useLocation } from 'react-router'
import { AppProviders } from '@/components/app-providers'
import { AppLayout } from '@/components/app-layout'
import { Dashboard } from '@/routes/dashboard'
import { Marketplace } from '@/routes/marketplace'
import { Faucet } from '@/routes/faucet'
import { Delegations } from '@/routes/delegations'
import { Subscriptions } from '@/routes/subscriptions'
import { Plans } from '@/routes/plans'
import { CollectPayments } from '@/routes/collect-payments'
import { Program } from '@/routes/program'
import { Setup } from '@/routes/setup'
import { useNetworkConfig } from '@/hooks/use-token-config'
import { clusterIdToNetwork } from '@/lib/api-client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useQuery } from '@tanstack/react-query'
import { createSolanaRpc } from '@solana/kit'

function useRpcReachable() {
  const { id, url } = useClusterConfig()
  const isLocalnet = id === 'solana:localnet'

  return useQuery({
    queryKey: ['rpc-health', id],
    queryFn: async () => {
      try {
        const rpc = createSolanaRpc(url)
        await rpc.getVersion().send()
        return true
      } catch {
        return false
      }
    },
    enabled: isLocalnet,
    staleTime: 10_000,
    retry: false,
  })
}

function useIsSetupValid(): { ready: boolean; loading: boolean } {
  const { id } = useClusterConfig()
  const network = clusterIdToNetwork(id)
  const isLocalnet = id === 'solana:localnet'
  const lsComplete = localStorage.getItem(`setup-complete-${network}`) === 'true'
  const { data, isLoading } = useNetworkConfig()
  const { data: rpcReachable, isLoading: rpcLoading } = useRpcReachable()

  if (!lsComplete) return { ready: false, loading: false }
  if (isLoading || (isLocalnet && rpcLoading)) return { ready: true, loading: true }

  if (isLocalnet && rpcReachable === false) {
    localStorage.removeItem(`setup-complete-${network}`)
    return { ready: false, loading: false }
  }

  const hasProgram = !!data?.programAddress
  const hasTokens = (data?.tokens?.length ?? 0) > 0
  if (!hasProgram || !hasTokens) {
    localStorage.removeItem(`setup-complete-${network}`)
    return { ready: false, loading: false }
  }

  return { ready: true, loading: false }
}

function SetupGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { ready } = useIsSetupValid()
  if (!ready && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <AppProviders>
      <SetupGuard>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route element={<AppLayout><Dashboard /></AppLayout>} path="/" />
          <Route element={<AppLayout><Marketplace /></AppLayout>} path="/marketplace" />
          <Route element={<AppLayout><Delegations /></AppLayout>} path="/delegations" />
          <Route element={<AppLayout><Subscriptions /></AppLayout>} path="/subscriptions" />
          <Route element={<AppLayout><Plans /></AppLayout>} path="/plans" />
          <Route element={<AppLayout><CollectPayments /></AppLayout>} path="/plans/collect" />
          <Route element={<AppLayout><Faucet /></AppLayout>} path="/faucet" />
          <Route element={<AppLayout><Program /></AppLayout>} path="/program" />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SetupGuard>
    </AppProviders>
  )
}
