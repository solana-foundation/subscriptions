import { AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { ActiveDelegations } from './active-delegations'
import { useUsdcMintRaw } from '@/hooks/use-token-config'
import { useSubscriptionAuthorityStatus } from '@/hooks/use-subscription-authority-status'

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-pulse text-muted-foreground">Loading delegation status...</div>
    </div>
  )
}

function TokenConfigError() {
  return (
    <Card className="border-destructive/20 bg-destructive/5">
      <CardContent className="flex items-center gap-3 py-6">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <div>
          <p className="font-medium text-destructive">Token Configuration Error</p>
          <p className="text-sm text-destructive/80">
            USDC token is not configured. Please ensure the API server is running.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="border-destructive/20 bg-destructive/5">
      <CardContent className="flex items-center justify-between py-6">
        <div className="flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Failed to load delegation status</p>
            <p className="text-sm text-destructive/80">
              Could not connect to the network. Check your connection.
            </p>
          </div>
        </div>
        <button onClick={onRetry} className="px-4 py-2 text-sm font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md transition-colors">
          Retry
        </button>
      </CardContent>
    </Card>
  )
}

export function DelegationManagementPanel() {
  const { mint: usdcMint, isLoading: isMintLoading } = useUsdcMintRaw()
  const {
    isLoading: statusLoading,
    isError,
    isInitialized,
    isApproved,
    data: statusData,
    refetch: refetchStatus,
  } = useSubscriptionAuthorityStatus(usdcMint)

  if (isMintLoading || statusLoading) {
    return <LoadingState />
  }

  if (isError) {
    return <StatusError onRetry={refetchStatus} />
  }

  if (!usdcMint) {
    return <TokenConfigError />
  }

  const subscriptionAuthorityInitId = statusData?.data?.initId ?? null
  const subscriptionAuthorityPayer = statusData?.data?.payer ?? null

  return (
    <div className="w-full">
      {subscriptionAuthorityInitId != null && (
        <div className="flex items-center gap-2 mb-4 text-xs text-gray-500 tracking-wide">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-700/40 to-transparent" />
          <span className="uppercase">Current Delegation ID</span>
          <span className="text-gray-400">{subscriptionAuthorityInitId.toString()}</span>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-700/40 to-transparent" />
        </div>
      )}
      <ActiveDelegations
        tokenMint={usdcMint}
        isInitialized={isInitialized}
        isApproved={isApproved}
        subscriptionAuthorityPayer={subscriptionAuthorityPayer}
        subscriptionAuthorityInitId={subscriptionAuthorityInitId}
        onInitSuccess={refetchStatus}
      />
    </div>
  )
}
