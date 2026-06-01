import { useState, useMemo, useCallback } from 'react';
import { DollarSign, Users, ClipboardPen, Clock, Star, Banknote, RefreshCw } from 'lucide-react';
import {
    Badge,
    Button as SolanaButton,
    SegmentedControl,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@solana/design-system';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExplorerLink } from '@/components/cluster/cluster-ui';
import { HistoryEntry } from '@/components/plan/collect-payments-panel';
import { useAllPlanSubscribers, type PlanSubscriberData } from '@/hooks/use-plan-subscribers';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';
import {
    fetchPlanSubscriptions,
    getLivePlanSubscribers,
    resolvePlanSubscriberAuthorities,
} from '@/hooks/use-subscriptions';
import { getBlockTimestamp } from '@/hooks/use-time-travel';
import { computeEligibleSubscribers, hasMatchingPlanTerms } from '@/lib/collect-utils';
import {
    getCollectionHistory,
    addCollectionRecord,
    createSuccessRecord,
    createFailureRecord,
    clearCollectionHistory,
} from '@/lib/collection-history';
import { parsePlanMeta, ICON_MAP } from '@/lib/plan-constants';
import { ellipsify, fmtDateShort } from '@/lib/utils';
import { useTokenConfig } from '@/hooks/use-token-config';
import { resolvePlanTokenDisplay } from '@/lib/token-display';
import type { TokenConfig } from '@/config/networks';

interface PendingTokenTotal {
    symbol: string;
    amount: number;
}

function sumPendingByToken(plans: PlanSubscriberData[], tokens: TokenConfig[] | undefined): PendingTokenTotal[] {
    const byMint = new Map<string, { symbol: string; decimals: number; raw: bigint }>();
    for (const p of plans) {
        if (p.totalPending <= 0n) continue;
        const t = resolvePlanTokenDisplay(p.plan.data.mint, tokens);
        const existing = byMint.get(p.plan.data.mint);
        if (existing) existing.raw += p.totalPending;
        else byMint.set(p.plan.data.mint, { symbol: t.symbol, decimals: t.decimals ?? 0, raw: p.totalPending });
    }
    return [...byMint.values()].map(v => ({ symbol: v.symbol, amount: Number(v.raw) / 10 ** v.decimals }));
}

function formatPendingTotals(totals: PendingTokenTotal[]): string {
    if (totals.length === 0) return '0';
    return totals
        .map(
            t =>
                `${t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t.symbol}`,
        )
        .join(' · ');
}

function CollectSummaryCards({
    pendingByToken,
    activeSubscribers,
    cancelledCount,
    plansWithPending,
    totalPlans,
}: {
    pendingByToken: PendingTokenTotal[];
    activeSubscribers: number;
    cancelledCount: number;
    plansWithPending: number;
    totalPlans: number;
}) {
    const pendingValue =
        pendingByToken.length === 0 ? (
            <span>0</span>
        ) : (
            <div className="flex flex-col items-end">
                {pendingByToken.map(t => (
                    <span key={t.symbol}>
                        {t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                        {t.symbol}
                    </span>
                ))}
            </div>
        );

    const cards = [
        {
            icon: DollarSign,
            title: 'Total Pending',
            row1Label: 'Amount',
            row1Value: pendingValue,
            row2Label: 'Across',
            row2Value: `${activeSubscribers + cancelledCount} subscribers`,
        },
        {
            icon: Users,
            title: 'Active Subscribers',
            row1Label: 'Active',
            row1Value: `${activeSubscribers}`,
            row2Label: 'Cancelled',
            row2Value: `${cancelledCount}`,
        },
        {
            icon: ClipboardPen,
            title: 'Plans Collecting',
            row1Label: 'With pending',
            row1Value: `${plansWithPending}`,
            row2Label: 'Total plans',
            row2Value: `${totalPlans}`,
        },
    ];

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6">
            {cards.map(card => (
                <div
                    key={card.title}
                    className="flex flex-col relative overflow-hidden border-0 border-all-dashed-medium bg-card rounded-2xl transition-all hover:bg-sand-100"
                >
                    <div className="p-5 flex-grow">
                        <div className="flex items-center gap-2 mb-6">
                            <card.icon className="h-5 w-5 text-foreground" />
                            <h3 className="text-[17px] font-semibold text-foreground tracking-tight">{card.title}</h3>
                        </div>
                        <div className="space-y-4">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-sand-1100">{card.row1Label}</span>
                                <div className="font-bold text-foreground text-base">{card.row1Value}</div>
                            </div>
                            <div className="h-px w-full bg-sand-100" />
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-sand-1100">{card.row2Label}</span>
                                <span className="font-bold text-foreground text-base">{card.row2Value}</span>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

function CollectAllButton({
    plansData,
    pendingByToken,
    onComplete,
}: {
    plansData: PlanSubscriberData[];
    pendingByToken: PendingTokenTotal[];
    onComplete?: () => void;
}) {
    const [collecting, setCollecting] = useState(false);
    const [progress, setProgress] = useState('');
    const { url: rpcUrl } = useClusterConfig();
    const progAddr = useProgramAddress();
    const { collectAllPlanPayments } = useSubscriptionsMutations();

    const eligiblePlans = useMemo(() => plansData.filter(p => p.eligible.length > 0), [plansData]);

    const handleCollectAll = useCallback(async () => {
        setCollecting(true);
        setProgress('Fetching subscribers...');

        const plans: Array<{
            planAddress: string;
            subscribers: Array<{ subscriptionAddress: string; delegator: string; amount: bigint }>;
            mint: string;
            destinations: string[];
        }> = [];
        let submittedPlans: typeof plans = [];
        const planDataByAddress = new Map(eligiblePlans.map(pd => [pd.plan.address, pd]));

        try {
            const ts = await getBlockTimestamp(rpcUrl);

            for (const pd of eligiblePlans) {
                const subscribers = getLivePlanSubscribers(
                    await resolvePlanSubscriberAuthorities(
                        rpcUrl,
                        await fetchPlanSubscriptions(rpcUrl, pd.plan.address, progAddr!),
                        pd.plan.data.mint,
                        progAddr!,
                    ),
                );
                const eligible = computeEligibleSubscribers(subscribers, pd.plan.data.terms, ts);
                if (eligible.length === 0) continue;
                plans.push({
                    planAddress: pd.plan.address,
                    subscribers: eligible.map(e => ({
                        subscriptionAddress: e.subscriptionAddress,
                        delegator: e.delegator,
                        amount: e.collectAmount,
                    })),
                    mint: pd.plan.data.mint,
                    destinations: pd.plan.data.destinations,
                });
            }

            if (plans.length === 0) {
                toast.info('No eligible subscribers found');
                setCollecting(false);
                setProgress('');
                return;
            }

            const totalIxs = plans.reduce((sum, p) => sum + p.subscribers.length, 0);
            setProgress(`Batching ${totalIxs} transfers across ${plans.length} plans...`);

            submittedPlans = plans;
            const res = await collectAllPlanPayments.mutateAsync({ plans });

            for (const plan of plans) {
                const pd = planDataByAddress.get(plan.planAddress);
                const planResult = res.plans[plan.planAddress];
                if (!pd || !planResult) continue;

                const meta = parsePlanMeta(pd.plan.data.metadataUri);
                const planName = meta.n || `Plan ${ellipsify(pd.plan.address)}`;
                const planTransfers = planResult.transfers.map(({ subscriptionAddress, amount, signature }) => ({
                    subscriptionAddress,
                    amount,
                    signature,
                }));
                addCollectionRecord(
                    createSuccessRecord(pd.plan.address, planName, planTransfers, planResult.total, planResult.total),
                );
            }

            toast.success(`Collected ${res.collected}/${res.total} payments`);
        } catch (err) {
            for (const plan of submittedPlans) {
                const pd = planDataByAddress.get(plan.planAddress);
                if (!pd) continue;

                const meta = parsePlanMeta(pd.plan.data.metadataUri);
                const planName = meta.n || `Plan ${ellipsify(pd.plan.address)}`;
                addCollectionRecord(createFailureRecord(pd.plan.address, planName, pd.currentSubscribers.length, err));
            }
            toast.error('Failed to collect payments');
        }

        onComplete?.();
        setCollecting(false);
        setProgress('');
    }, [eligiblePlans, rpcUrl, progAddr, collectAllPlanPayments, onComplete]);

    return (
        <SolanaButton
            disabled={eligiblePlans.length === 0 || collecting}
            loading={collecting}
            onClick={handleCollectAll}
        >
            {collecting ? progress || 'Collecting...' : `Collect All Pending (${formatPendingTotals(pendingByToken)})`}
        </SolanaButton>
    );
}

function EnhancedPlanCard({ planData, blockTs }: { planData: PlanSubscriberData; blockTs: number }) {
    const [view, setView] = useState<'subscribers' | 'history'>('subscribers');
    const [expanded, setExpanded] = useState(true);
    const [isCollecting, setIsCollecting] = useState(false);
    const [historyVersion, setHistoryVersion] = useState(0);
    const { url: rpcUrl } = useClusterConfig();
    const progAddr = useProgramAddress();
    const { collectSubscriptionPayments } = useSubscriptionsMutations();

    const { plan, subscribers, currentSubscribers, staleAuthoritySubscribers, staleSubscribers, eligible } = planData;
    const { data: tokens } = useTokenConfig();
    const token = resolvePlanTokenDisplay(plan.data.mint, tokens);
    const decimals = token.decimals ?? 0;
    const meta = useMemo(() => parsePlanMeta(plan.data.metadataUri), [plan.data.metadataUri]);
    const planName = meta.n || `Plan ${ellipsify(plan.address)}`;
    const PlanIcon = (meta.i && ICON_MAP[meta.i]) || Star;
    const amountUsd = Number(plan.data.terms.amount) / 10 ** decimals;
    const pendingUsd = Number(planData.totalPending) / 10 ** decimals;
    const staleSubscriberAddresses = useMemo(
        () => new Set(staleSubscribers.map(sub => sub.subscriptionAddress)),
        [staleSubscribers],
    );
    const staleAuthoritySubscriberAddresses = useMemo(
        () => new Set(staleAuthoritySubscribers.map(sub => sub.subscriptionAddress)),
        [staleAuthoritySubscribers],
    );

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const history = useMemo(() => getCollectionHistory(plan.address), [plan.address, historyVersion]);

    const handleCollect = useCallback(async () => {
        setIsCollecting(true);
        try {
            const subs = await resolvePlanSubscriberAuthorities(
                rpcUrl,
                await fetchPlanSubscriptions(rpcUrl, plan.address, progAddr!),
                plan.data.mint,
                progAddr!,
            );
            const liveSubs = getLivePlanSubscribers(subs);
            const ts = await getBlockTimestamp(rpcUrl);
            const elig = computeEligibleSubscribers(liveSubs, plan.data.terms, ts);
            const currentSubscriberCount = liveSubs.filter(sub => hasMatchingPlanTerms(sub, plan.data.terms)).length;

            if (elig.length === 0) {
                toast.info(
                    currentSubscriberCount === 0 && subs.length > 0
                        ? 'Only stale subscriptions found for this plan'
                        : 'All payments already collected this period',
                );
                setIsCollecting(false);
                return;
            }

            collectSubscriptionPayments.mutate(
                {
                    planAddress: plan.address,
                    subscribers: elig.map(e => ({
                        subscriptionAddress: e.subscriptionAddress,
                        delegator: e.delegator,
                        amount: e.collectAmount,
                    })),
                    mint: plan.data.mint,
                    destinations: plan.data.destinations,
                },
                {
                    onSuccess: res => {
                        addCollectionRecord(
                            createSuccessRecord(
                                plan.address,
                                planName,
                                res.transfers,
                                currentSubscriberCount,
                                elig.length,
                            ),
                        );
                        setHistoryVersion(v => v + 1);
                        setIsCollecting(false);
                    },
                    onError: error => {
                        addCollectionRecord(createFailureRecord(plan.address, planName, currentSubscriberCount, error));
                        setHistoryVersion(v => v + 1);
                        setIsCollecting(false);
                    },
                },
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to collect');
            setIsCollecting(false);
        }
    }, [rpcUrl, progAddr, plan, planName, collectSubscriptionPayments]);

    const periodHoursSec = Number(plan.data.terms.periodHours) * 3600;

    return (
        <div className="border border-sand-200 bg-sand-200 rounded-xl overflow-hidden">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-sand-100 transition-colors"
                onClick={() => setExpanded(!expanded)}
                onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(!expanded);
                    }
                }}
            >
                <div className="flex items-center gap-3">
                    <PlanIcon className="h-5 w-5 text-foreground" />
                    <div className="text-left">
                        <p className="text-foreground font-medium">{planName}</p>
                        <p className="text-sm text-slate-400">
                            {amountUsd.toFixed(2)} {token.symbol}/period &middot; {eligible.length}/
                            {currentSubscribers.length} eligible
                            {staleSubscribers.length + staleAuthoritySubscribers.length > 0 &&
                                ` / ${staleSubscribers.length + staleAuthoritySubscribers.length} stale`}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {pendingUsd > 0 && (
                        <span className="text-foreground font-medium text-sm">
                            {pendingUsd.toFixed(2)} {token.symbol} pending
                        </span>
                    )}
                    <SolanaButton
                        size="sm"
                        disabled={isCollecting || eligible.length === 0}
                        loading={isCollecting}
                        onClick={e => {
                            e.stopPropagation();
                            handleCollect();
                        }}
                    >
                        Collect {pendingUsd.toFixed(2)} {token.symbol}
                    </SolanaButton>
                </div>
            </div>

            {expanded && (
                <div className="border-t border-sand-200">
                    <div className="p-2 border-b border-sand-200">
                        <SegmentedControl
                            aria-label="Collection detail view"
                            value={view}
                            onValueChange={value => setView(value as typeof view)}
                            items={[
                                { value: 'subscribers', label: 'Subscribers' },
                                { value: 'history', label: 'History' },
                            ]}
                        />
                    </div>

                    <div className="p-3">
                        {view === 'subscribers' ? (
                            subscribers.length === 0 ? (
                                <p className="text-sm text-slate-400 text-center py-4">No subscribers</p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-sand-200 hover:bg-transparent">
                                            <TableHead className="text-slate-400">Subscriber</TableHead>
                                            <TableHead className="text-slate-400">Status</TableHead>
                                            <TableHead className="text-slate-400">Period</TableHead>
                                            <TableHead className="text-slate-400 text-right">Collectible</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {subscribers.map(sub => {
                                            const isActive = sub.expiresAtTs === 0n;
                                            const isCancelled =
                                                sub.expiresAtTs !== 0n && blockTs < Number(sub.expiresAtTs);
                                            const periodEnd = Number(sub.currentPeriodStartTs) + periodHoursSec;
                                            const eligEntry = eligible.find(
                                                e => e.subscriptionAddress === sub.subscriptionAddress,
                                            );
                                            const isStale = staleSubscriberAddresses.has(sub.subscriptionAddress);
                                            const isAuthorityStale = staleAuthoritySubscriberAddresses.has(
                                                sub.subscriptionAddress,
                                            );
                                            const collectibleUsd = eligEntry
                                                ? Number(eligEntry.collectAmount) / 10 ** decimals
                                                : null;

                                            return (
                                                <TableRow key={sub.subscriptionAddress} className="border-sand-200">
                                                    <TableCell>
                                                        <ExplorerLink
                                                            address={sub.delegator}
                                                            label={ellipsify(sub.delegator)}
                                                            className="text-foreground hover:text-sand-1100 text-xs font-mono"
                                                        />
                                                    </TableCell>
                                                    <TableCell>
                                                        {isAuthorityStale ? (
                                                            <Badge variant="warning">Stale Authority</Badge>
                                                        ) : isStale ? (
                                                            <Badge variant="warning">Stale Terms</Badge>
                                                        ) : isActive ? (
                                                            <Badge variant="success">Active</Badge>
                                                        ) : isCancelled ? (
                                                            <Badge variant="danger">Cancelled</Badge>
                                                        ) : (
                                                            <Badge>Expired</Badge>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-slate-300 text-xs">
                                                        {fmtDateShort(Number(sub.currentPeriodStartTs))} -{' '}
                                                        {fmtDateShort(periodEnd)}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        {isAuthorityStale || isStale ? (
                                                            <span className="text-amber-600">Excluded</span>
                                                        ) : collectibleUsd !== null ? (
                                                            <span className="text-foreground font-medium">
                                                                {collectibleUsd.toFixed(2)} {token.symbol}
                                                            </span>
                                                        ) : (
                                                            <span className="text-slate-500">Collected</span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            )
                        ) : history.length === 0 ? (
                            <p className="text-sm text-slate-400 text-center py-4">No collection history</p>
                        ) : (
                            <div className="space-y-2">
                                {history.slice(0, 10).map(record => (
                                    <HistoryEntry
                                        key={record.id}
                                        record={record}
                                        decimals={decimals}
                                        symbol={token.symbol}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function RecentCollections({ version, onClear }: { version: number; onClear: () => void }) {
    const { data: tokens } = useTokenConfig();
    const primary = tokens?.[0];
    const decimals = primary?.decimals ?? 0;
    const symbol = primary?.symbol ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const history = useMemo(() => getCollectionHistory(), [version]);

    if (history.length === 0) {
        return (
            <Card className="border-0 border-all-dashed-medium bg-card">
                <CardHeader className="pb-4">
                    <div className="flex items-center gap-2">
                        <Clock className="h-5 w-5 text-sand-1100" />
                        <CardTitle>Recent Collections</CardTitle>
                    </div>
                </CardHeader>
                <CardContent className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                    <Banknote className="h-6 w-6" />
                    <p className="text-sm">No collections yet</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="border-0 border-all-dashed-medium bg-card">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Clock className="h-5 w-5 text-sand-1100" />
                        <CardTitle>Recent Collections</CardTitle>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            clearCollectionHistory();
                            onClear();
                        }}
                        className="text-xs text-muted-foreground hover:text-red-600"
                    >
                        Clear all
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-2">
                {history.slice(0, 15).map(record => (
                    <div key={record.id} className="flex items-center gap-2">
                        <Badge variant="success" className="shrink-0">
                            {record.planName}
                        </Badge>
                        <div className="flex-1 min-w-0">
                            <HistoryEntry record={record} decimals={decimals} symbol={symbol} />
                        </div>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

export function EnhancedCollectPayments() {
    const { data, isLoading, allPlans, plansWithSubs, refetch } = useAllPlanSubscribers();
    const { data: tokens } = useTokenConfig();
    const queryClient = useQueryClient();
    const [spinning, setSpinning] = useState(false);
    const [historyVersion, setHistoryVersion] = useState(0);

    const handleRefresh = async () => {
        setSpinning(true);
        const minSpin = new Promise(r => setTimeout(r, 600));
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['plans'] }),
            queryClient.invalidateQueries({ queryKey: ['subscriberCounts'] }),
            queryClient.invalidateQueries({ queryKey: ['allPlanSubscribers'] }),
            refetch(),
            minSpin,
        ]);
        setHistoryVersion(v => v + 1);
        setSpinning(false);
    };

    if (isLoading) {
        return (
            <Card className="border-0 border-all-dashed-medium bg-card">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-pulse text-muted-foreground">Loading plans...</div>
                </CardContent>
            </Card>
        );
    }

    if (!allPlans || allPlans.length === 0 || plansWithSubs.length === 0) {
        return (
            <div className="space-y-6">
                <Card className="border-0 border-all-dashed-medium bg-card">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                        <Banknote className="h-8 w-8" />
                        <p className="text-sm">No plans with active subscribers</p>
                    </CardContent>
                </Card>
                <RecentCollections version={historyVersion} onClear={() => setHistoryVersion(v => v + 1)} />
            </div>
        );
    }

    const pendingByToken = sumPendingByToken(data?.plans ?? [], tokens);
    const totalActive = data?.totalActiveSubscribers ?? 0;
    const totalCancelled = data?.plans.reduce((sum, p) => sum + p.cancelledCount, 0) ?? 0;
    const plansWithPending = data?.plansWithPending ?? 0;
    const blockTs = data?.blockTimestamp ?? 0;

    return (
        <div className="space-y-6">
            <CollectSummaryCards
                pendingByToken={pendingByToken}
                activeSubscribers={totalActive}
                cancelledCount={totalCancelled}
                plansWithPending={plansWithPending}
                totalPlans={allPlans.length}
            />

            <div className="flex items-center justify-end gap-2">
                <SolanaButton
                    variant="secondary"
                    size="sm"
                    iconOnly
                    iconLeft={<RefreshCw className={spinning ? 'animate-spin' : ''} />}
                    aria-label="Refresh collections"
                    onClick={handleRefresh}
                    disabled={spinning}
                />
                <CollectAllButton
                    plansData={data?.plans ?? []}
                    pendingByToken={pendingByToken}
                    onComplete={() => setHistoryVersion(v => v + 1)}
                />
            </div>

            <div className="space-y-4">
                {(data?.plans ?? []).map(pd => (
                    <EnhancedPlanCard key={pd.plan.address} planData={pd} blockTs={blockTs} />
                ))}
            </div>

            <RecentCollections version={historyVersion} onClear={() => setHistoryVersion(v => v + 1)} />
        </div>
    );
}
