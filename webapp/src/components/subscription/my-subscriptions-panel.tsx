import { useState, useEffect, useMemo } from 'react';
import { CalendarCheck, Trash2, Clock } from 'lucide-react';
import { Badge } from '@solana/design-system';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { useMySubscriptions, type EnrichedSubscription } from '@/hooks/use-subscriptions';
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations';
import { useSubscriptionAuthorityStatus } from '@/hooks/use-subscription-authority-status';
import { useUsdcMintRaw } from '@/hooks/use-token-config';
import { useTimeTravel } from '@/hooks/use-time-travel';
import { cn, USDC_MULTIPLIER, ellipsify, fmtDate, fmtDateTime, formatPeriod } from '@/lib/utils';
import { parsePlanMeta } from '@/lib/plan-constants';

function CancelSubscriptionDialog({
    item,
    open,
    onOpenChange,
}: {
    item: EnrichedSubscription;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { cancelSubscription } = useSubscriptionsMutations();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-amber-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-amber-400">Unsubscribe</DialogTitle>
                    <DialogDescription>
                        Are you sure you want to unsubscribe? Your subscription remains active until end of current
                        billing period.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Keep Subscription
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() =>
                            cancelSubscription.mutate(
                                {
                                    planPda: item.subscription.header.delegatee,
                                    subscriptionPda: item.address,
                                },
                                { onSuccess: () => onOpenChange(false) },
                            )
                        }
                        disabled={cancelSubscription.isPending}
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    >
                        {cancelSubscription.isPending ? 'Cancelling...' : 'Yes, Unsubscribe'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function RevokeSubscriptionDialog({
    item,
    open,
    onOpenChange,
}: {
    item: EnrichedSubscription;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { revokeSubscription } = useSubscriptionsMutations();
    const { getCurrentTimestamp } = useTimeTravel();
    const revokedTs = Number(item.subscription.expiresAtTs);
    const [canRevoke, setCanRevoke] = useState(false);

    useEffect(() => {
        if (!open || revokedTs === 0) return;
        getCurrentTimestamp()
            .then(bt => {
                setCanRevoke(bt >= revokedTs);
            })
            .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [open, revokedTs, getCurrentTimestamp]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-red-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-red-400">Delete Subscription</DialogTitle>
                    <DialogDescription>
                        {canRevoke
                            ? 'This subscription has expired. Deleting will close the account and return rent to your wallet.'
                            : 'This subscription cannot be deleted yet.'}
                    </DialogDescription>
                </DialogHeader>
                {!canRevoke && (
                    <div className="text-sm text-gray-400 p-3 rounded-lg border border-gray-700 bg-gray-900/50">
                        Expires on {fmtDateTime(revokedTs)}. You can delete after that.
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={() =>
                            revokeSubscription.mutate(
                                {
                                    subscriptionPda: item.address,
                                    planPda: item.subscription.header.delegatee,
                                    payer: item.subscription.header.payer,
                                },
                                { onSuccess: () => onOpenChange(false) },
                            )
                        }
                        disabled={!canRevoke || revokeSubscription.isPending}
                    >
                        {revokeSubscription.isPending ? 'Deleting...' : 'Delete Subscription'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CancelAndRevokeDialog({
    item,
    isGhostPlan,
    open,
    onOpenChange,
}: {
    item: EnrichedSubscription;
    isGhostPlan?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { cancelAndRevokeSubscription } = useSubscriptionsMutations();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-red-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-red-400">Unsubscribe & Delete</DialogTitle>
                    <DialogDescription>
                        {isGhostPlan
                            ? 'The plan terms have changed since you subscribed (ghost plan). Payments cannot be collected. This will cancel and immediately delete the subscription, returning rent to your wallet.'
                            : 'The plan for this subscription has been deleted. This will cancel and immediately delete the subscription, returning rent to your wallet.'}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Keep
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={() =>
                            cancelAndRevokeSubscription.mutate(
                                {
                                    planPda: item.subscription.header.delegatee,
                                    subscriptionPda: item.address,
                                    payer: item.subscription.header.payer,
                                },
                                { onSuccess: () => onOpenChange(false) },
                            )
                        }
                        disabled={cancelAndRevokeSubscription.isPending}
                    >
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                        {cancelAndRevokeSubscription.isPending ? 'Processing...' : 'Unsubscribe & Delete'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SubscriptionCard({
    item,
    subscriptionAuthorityInitId,
}: {
    item: EnrichedSubscription;
    subscriptionAuthorityInitId: bigint | null;
}) {
    const [cancelOpen, setCancelOpen] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [cancelAndRevokeOpen, setCancelAndRevokeOpen] = useState(false);
    const { cancelSubscription } = useSubscriptionsMutations();
    const { getCurrentTimestamp } = useTimeTravel();
    const isActive = Number(item.subscription.expiresAtTs) === 0;
    const isCancelled = !isActive;
    const revokedTs = Number(item.subscription.expiresAtTs);
    const [isExpired, setIsExpired] = useState(false);
    const [daysLeft, setDaysLeft] = useState<number | null>(null);
    const meta = useMemo(() => (item.plan ? parsePlanMeta(item.plan.data.metadataUri) : {}), [item.plan]);

    useEffect(() => {
        if (!isCancelled) return;
        getCurrentTimestamp()
            .then(bt => {
                if (bt >= revokedTs) {
                    setIsExpired(true);
                    setDaysLeft(0);
                } else {
                    setIsExpired(false);
                    const secsLeft = revokedTs - bt;
                    setDaysLeft(Math.ceil(secsLeft / 86400));
                }
            })
            .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [isCancelled, revokedTs, getCurrentTimestamp]);

    const planDeleted = !item.plan;
    const planName = meta.n || 'Unknown Plan';
    const amount = Number(item.subscription.terms.amount) / USDC_MULTIPLIER;
    const period = formatPeriod(item.subscription.terms.periodHours);
    const isGhostPlan =
        item.plan != null &&
        (item.plan.data.terms.amount !== item.subscription.terms.amount ||
            item.plan.data.terms.periodHours !== item.subscription.terms.periodHours ||
            item.plan.data.terms.createdAt !== item.subscription.terms.createdAt);
    const pulled = Number(item.subscription.amountPulledInPeriod) / USDC_MULTIPLIER;
    const subInitId = item.subscription.header.initId;
    const isStale = subscriptionAuthorityInitId != null && subInitId !== subscriptionAuthorityInitId;

    return (
        <>
            <Card
                className={cn(
                    'rounded-xl relative overflow-hidden transition-all duration-300',
                    planDeleted
                        ? 'border-red-500/15 bg-gradient-to-br from-red-950/30 via-gray-900/20 to-gray-950/60 opacity-80'
                        : isCancelled
                          ? 'border-gray-500/20 bg-gradient-to-br from-gray-950/60 via-gray-900/20 to-gray-950/60 opacity-70'
                          : 'border-teal-500/25 bg-gradient-to-br from-slate-900/80 via-teal-900/15 to-slate-900/80 hover:border-teal-500/45',
                )}
            >
                {!isCancelled && !planDeleted && (
                    <div className="absolute inset-0 bg-gradient-to-r from-teal-500/5 to-transparent pointer-events-none" />
                )}
                <CardContent className="p-4 space-y-3 relative z-10">
                    <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-white truncate">{planName}</p>
                        {planDeleted ? (
                            <Badge variant="danger" className="shrink-0">
                                Plan Deleted
                            </Badge>
                        ) : isGhostPlan ? (
                            <Badge variant="warning" className="shrink-0">
                                Ghost Plan
                            </Badge>
                        ) : isActive ? (
                            <Badge variant="info" className="shrink-0">
                                Active
                            </Badge>
                        ) : (
                            <Badge variant="danger" className="shrink-0">
                                Cancelled
                            </Badge>
                        )}
                    </div>

                    <div className="flex items-baseline gap-1.5">
                        <span className="text-base sm:text-lg lg:text-xl font-bold text-teal-400">${amount}</span>
                        <span className="text-sm text-teal-400/60">/{period.toLowerCase()}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                        <span className="font-mono">{ellipsify(item.address, 4)}</span>
                        <span className="text-teal-800">|</span>
                        <span className="font-bold text-blue-400/50">V{item.subscription.header.version}</span>
                        <span className="text-teal-800">|</span>
                        <span className="font-bold text-teal-400/40">ID: {subInitId.toString()}</span>
                        {isStale && (
                            <>
                                <span className="text-teal-800">|</span>
                                <span className="font-semibold text-amber-400">Stale</span>
                            </>
                        )}
                        <span className="text-teal-800">|</span>
                        <span>Pulled: ${pulled.toFixed(2)}</span>
                        {isCancelled && !planDeleted && (
                            <>
                                <span className="text-teal-800">|</span>
                                <span className="flex items-center gap-1 text-red-400">
                                    <Clock className="h-3 w-3" />
                                    Expires: {fmtDate(revokedTs)}
                                </span>
                            </>
                        )}
                    </div>

                    <div className={cn('pt-2 border-t', planDeleted ? 'border-red-500/10' : 'border-teal-500/10')}>
                        {(planDeleted || isGhostPlan) && isActive ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCancelAndRevokeOpen(true)}
                                className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            >
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                Unsubscribe & Delete
                            </Button>
                        ) : isActive ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    isStale
                                        ? cancelSubscription.mutate({
                                              planPda: item.subscription.header.delegatee,
                                              subscriptionPda: item.address,
                                          })
                                        : setCancelOpen(true)
                                }
                                disabled={cancelSubscription.isPending}
                                className="w-full border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                            >
                                {cancelSubscription.isPending ? 'Unsubscribing...' : 'Unsubscribe'}
                            </Button>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRevokeOpen(true)}
                                disabled={!isExpired}
                                className={cn(
                                    'w-full',
                                    isExpired
                                        ? 'border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300'
                                        : 'border-gray-600/30 text-gray-500 cursor-not-allowed',
                                )}
                            >
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                {isExpired ? 'Delete' : `${daysLeft ?? '?'} days left`}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>
            <CancelSubscriptionDialog item={item} open={cancelOpen} onOpenChange={setCancelOpen} />
            <RevokeSubscriptionDialog item={item} open={revokeOpen} onOpenChange={setRevokeOpen} />
            <CancelAndRevokeDialog
                item={item}
                isGhostPlan={isGhostPlan}
                open={cancelAndRevokeOpen}
                onOpenChange={setCancelAndRevokeOpen}
            />
        </>
    );
}

export function MySubscriptionsPanel() {
    const { data: subscriptions, isLoading } = useMySubscriptions();
    const { mint: usdcMint } = useUsdcMintRaw();
    const { data: statusData } = useSubscriptionAuthorityStatus(usdcMint);
    const subscriptionAuthorityInitId = statusData?.data?.initId ?? null;

    if (isLoading) {
        return (
            <Card className="border-teal-500/20 bg-gradient-to-br from-teal-950/40 via-teal-900/20 to-transparent">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-pulse text-muted-foreground">Loading subscriptions...</div>
                </CardContent>
            </Card>
        );
    }

    const hasSubs = subscriptions && subscriptions.length > 0;

    return (
        <Card className="relative overflow-hidden border-teal-500/20 bg-gradient-to-br from-teal-950/40 via-teal-900/20 to-transparent hover:border-teal-500/40 transition-all duration-300">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <CalendarCheck className="h-5 w-5 text-teal-400" />
                        <CardTitle>My Subscriptions</CardTitle>
                    </div>
                    {hasSubs && <Badge variant="info">{subscriptions.length}</Badge>}
                </div>
            </CardHeader>
            <CardContent>
                {hasSubs ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {subscriptions.map(item => (
                            <SubscriptionCard
                                key={item.address}
                                item={item}
                                subscriptionAuthorityInitId={subscriptionAuthorityInitId}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                        <CalendarCheck className="h-8 w-8" />
                        <p className="text-sm">No subscriptions yet</p>
                        <p className="text-xs">Subscribe to plans from the Marketplace</p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
