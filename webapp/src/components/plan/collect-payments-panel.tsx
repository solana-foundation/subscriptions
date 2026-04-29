import { useState, useMemo, useCallback } from 'react'
import { Banknote, ChevronDown, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, USDC_MULTIPLIER, ellipsify, fmtDateTime } from '@/lib/utils'
import { ExplorerLink } from '@/components/cluster/cluster-ui'
import { useMyPlans, type PlanItem } from '@/hooks/use-plans'
import { useSubscriberCounts, fetchPlanSubscriptions } from '@/hooks/use-subscriptions'
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'
import { getBlockTimestamp } from '@/hooks/use-time-travel'
import { computeEligibleSubscribers, hasMatchingPlanTerms } from '@/lib/collect-utils'
import {
  getCollectionHistory,
  addCollectionRecord,
  createSuccessRecord,
  createFailureRecord,
  getCollectionRecordTotalDisplayAmount,
  type CollectionRecord,
} from '@/lib/collection-history'
import { parsePlanMeta, ICON_MAP } from '@/lib/plan-constants'
import { Star } from 'lucide-react'

export function HistoryEntry({ record }: { record: CollectionRecord }) {
  const isSuccess = record.status === 'success' || record.status === 'partial'
  const totalAmount = getCollectionRecordTotalDisplayAmount(record, USDC_MULTIPLIER)

  return (
    <div className="flex items-center gap-3 bg-slate-800/50 border border-emerald-500/10 rounded-lg p-2 text-sm">
      {isSuccess ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-400 shrink-0" />
      )}
      <span className="text-slate-400 shrink-0">{fmtDateTime(record.timestamp)}</span>
      <span className="text-white">
        ${totalAmount.toFixed(2)} total from {record.subscribersCollected}/{record.subscribersTotal} subs
      </span>
      {isSuccess && record.signatures[0] && (
        <span className="ml-auto">
          <ExplorerLink
            transaction={record.signatures[0]}
            label="tx"
            className="text-emerald-400 hover:text-emerald-300 text-xs"
          />
        </span>
      )}
      {record.error && (
        <span className="ml-auto text-red-400 truncate max-w-[200px]">{record.error}</span>
      )}
    </div>
  )
}

function CollectPlanCard({ plan, subscriberCount, progAddr }: { plan: PlanItem; subscriberCount: number; progAddr: string }) {
  const [expanded, setExpanded] = useState(false)
  const [isCollecting, setIsCollecting] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const { url: rpcUrl } = useClusterConfig()
  const { collectSubscriptionPayments } = useSubscriptionsMutations()

  const meta = useMemo(() => parsePlanMeta(plan.data.metadataUri), [plan.data.metadataUri])
  const planName = meta.n || `Plan ${ellipsify(plan.address)}`
  const PlanIcon = (meta.i && ICON_MAP[meta.i]) || Star
  const amountUsd = Number(plan.data.terms.amount) / USDC_MULTIPLIER

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => getCollectionHistory(plan.address), [plan.address, historyVersion])

  const handleCollect = useCallback(async () => {
    setIsCollecting(true)
    try {
      const subscribers = await fetchPlanSubscriptions(rpcUrl, plan.address, progAddr)
      const ts = await getBlockTimestamp(rpcUrl)
      const eligible = computeEligibleSubscribers(
        subscribers,
        plan.data.terms,
        ts,
      )
      const currentSubscriberCount = subscribers.filter((sub) =>
        hasMatchingPlanTerms(sub, plan.data.terms),
      ).length

      if (eligible.length === 0) {
        toast.info(
          currentSubscriberCount === 0 && subscribers.length > 0
            ? 'Only stale subscriptions found for this plan'
            : 'All payments already collected this period',
        )
        setIsCollecting(false)
        return
      }

      collectSubscriptionPayments.mutate(
        {
          planAddress: plan.address,
          subscribers: eligible.map((e) => ({
            subscriptionAddress: e.subscriptionAddress,
            delegator: e.delegator,
            amount: e.collectAmount,
          })),
          mint: plan.data.mint,
          destinations: plan.data.destinations,
        },
        {
          onSuccess: (res) => {
            addCollectionRecord(createSuccessRecord(
              plan.address, planName, res.transfers, currentSubscriberCount, eligible.length,
            ))
            setHistoryVersion((v) => v + 1)
            setIsCollecting(false)
          },
          onError: (error) => {
            addCollectionRecord(createFailureRecord(
              plan.address, planName, currentSubscriberCount, error,
            ))
            setHistoryVersion((v) => v + 1)
            setIsCollecting(false)
          },
        },
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to collect')
      setIsCollecting(false)
    }
  }, [rpcUrl, plan, planName, collectSubscriptionPayments, progAddr])

  return (
    <div className="border border-emerald-500/15 bg-slate-900/60 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <PlanIcon className="h-5 w-5 text-emerald-400" />
          <div>
            <p className="text-white font-medium">{planName}</p>
            <p className="text-sm text-slate-400">
              ${amountUsd.toFixed(2)} / period - {subscriberCount} subscriber{subscriberCount !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            className="bg-emerald-600 hover:bg-emerald-500 text-white"
            size="sm"
            disabled={isCollecting}
            onClick={handleCollect}
          >
            {isCollecting && <Loader2 className="h-4 w-4 animate-spin" />}
            Collect Payments
          </Button>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
            </Button>
          )}
        </div>
      </div>

      {expanded && history.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-emerald-500/10">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Collection History</p>
          {history.slice(0, 10).map((record) => (
            <HistoryEntry key={record.id} record={record} />
          ))}
        </div>
      )}
    </div>
  )
}

export function CollectPaymentsPanel({ alwaysShow }: { alwaysShow?: boolean } = {}) {
  const { data: plans, isLoading } = useMyPlans()
  const planAddresses = useMemo(() => plans?.map((p) => p.address) ?? [], [plans])
  const { data: subCounts } = useSubscriberCounts(planAddresses)
  const progAddr = useProgramAddress()

  const plansWithSubs = useMemo(() => {
    if (!plans || !subCounts) return []
    return plans.filter((p) => (subCounts.get(p.address) ?? 0) > 0)
  }, [plans, subCounts])

  if (isLoading) {
    if (!alwaysShow) return null
    return (
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent">
        <CardContent className="flex items-center justify-center py-12">
          <div className="animate-pulse text-muted-foreground">Loading plans...</div>
        </CardContent>
      </Card>
    )
  }

  if (plansWithSubs.length === 0) {
    if (!alwaysShow) return null
    return (
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
          <Banknote className="h-8 w-8" />
          <p className="text-sm">No plans with active subscribers</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="relative overflow-hidden border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent hover:border-emerald-500/40 transition-all duration-300">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-emerald-400" />
          <CardTitle>Payment Collection</CardTitle>
          <Badge variant="outline" className="text-emerald-400 border-emerald-400/30">
            {plansWithSubs.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {plansWithSubs.map((plan) => (
          <CollectPlanCard
            key={plan.address}
            plan={plan}
            subscriberCount={subCounts?.get(plan.address) ?? 0}
            progAddr={progAddr!}
          />
        ))}
      </CardContent>
    </Card>
  )
}
