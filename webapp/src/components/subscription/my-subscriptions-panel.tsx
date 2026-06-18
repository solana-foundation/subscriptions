import { useState, useEffect, useMemo } from 'react';
import { CalendarCheck, Trash2, Clock, RotateCcw } from 'lucide-react';
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
import { useTokenConfig } from '@/hooks/use-token-config';
import { useTimeTravel } from '@/hooks/use-time-travel';
import { cn, ellipsify, fmtDate, fmtDateTime, formatPeriod } from '@/lib/utils';
import { formatPlanTokenAmount, resolvePlanTokenDisplay } from '@/lib/token-display';
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
            <DialogContent className="border-amber-300 bg-bg1">
                <DialogHeader>
                    <DialogTitle className="text-amber-600">Unsubscribe</DialogTitle>
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
                        className="border-red-300 text-red-600 hover:bg-red-100 hover:text-red-700"
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
            <DialogContent className="border-red-300 bg-bg1">
                <DialogHeader>
                    <DialogTitle className="text-red-600">Delete Subscription</DialogTitle>
                    <DialogDescription>
                        {canRevoke
                            ? 'This subscription has expired. Deleting will close the account and return rent to your wallet.'
                            : 'This subscription cannot be deleted yet.'}
                    </DialogDescription>
                </DialogHeader>
                {!canRevoke && (
                    <div className="text-sm text-sand-1100 p-3 rounded-lg border border-sand-300 bg-sand-100">
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

function ResumeSubscriptionDialog({
    item,
    open,
    onOpenChange,
}: {
    item: EnrichedSubscription;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { resumeSubscription } = useSubscriptionsMutations();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-teal-300 bg-bg1">
                <DialogHeader>
                    <DialogTitle className="text-teal-700">Resume Subscription</DialogTitle>
                    <DialogDescription>
                        Resuming clears the pending cancellation and lets authorized plan pullers collect future
                        payments automatically.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Keep Cancelled
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() =>
                            resumeSubscription.mutate(
                                {
                                    planPda: item.subscription.header.delegatee,
                                    subscriptionPda: item.address,
                                    tokenMint: item.mint ?? '',
                                },
                                { onSuccess: () => onOpenChange(false) },
                            )
                        }
                        disabled={resumeSubscription.isPending}
                        className="border-teal-300 text-teal-700 hover:bg-teal-100 hover:text-teal-800"
                    >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        {resumeSubscription.isPending ? 'Resuming...' : 'Resume'}
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
            <DialogContent className="border-red-300 bg-bg1">
                <DialogHeader>
                    <DialogTitle className="text-red-600">Unsubscribe & Delete</DialogTitle>
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

function SubscriptionCard({ item }: { item: EnrichedSubscription }) {
    const [cancelOpen, setCancelOpen] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [resumeOpen, setResumeOpen] = useState(false);
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

    const { data: tokens } = useTokenConfig();
    const planDeleted = !item.plan;
    const planName = meta.n || 'Unknown Plan';
    const tokenDisplay = resolvePlanTokenDisplay(item.mint ?? '', tokens);
    const amount = formatPlanTokenAmount(item.subscription.terms.amount, tokenDisplay);
    const period = formatPeriod(item.subscription.terms.periodHours);
    const isGhostPlan =
        item.plan != null &&
        (item.plan.data.terms.amount !== item.subscription.terms.amount ||
            item.plan.data.terms.periodHours !== item.subscription.terms.periodHours ||
            item.plan.data.terms.createdAt !== item.subscription.terms.createdAt);
    const pulled = formatPlanTokenAmount(item.subscription.amountPulledInPeriod, tokenDisplay);
    const subInitId = item.subscription.header.initId;
    const isStale = item.authorityInitId != null && subInitId !== item.authorityInitId;
    const canResume = isCancelled && daysLeft !== null && daysLeft > 0 && !planDeleted && !isGhostPlan && !isStale;

    return (
        <>
            <Card
                className={cn(
                    'rounded-xl relative overflow-hidden transition-all duration-300',
                    planDeleted
                        ? 'border-red-200 bg-gradient-to-br from-red-100 via-sand-100 to-sand-200 opacity-80'
                        : isCancelled
                          ? 'border-sand-300 bg-gradient-to-br from-sand-200 via-sand-100 to-sand-200 opacity-70'
                          : 'border-0 border-all-dashed-medium bg-card hover:bg-sand-100',
                )}
            >
                {!isCancelled && !planDeleted && (
                    <div className="absolute inset-0 bg-gradient-to-r from-teal-500/5 to-transparent pointer-events-none" />
                )}
                <CardContent className="p-4 space-y-3 relative z-10">
                    <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-foreground truncate">{planName}</p>
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
                        <span className="text-base sm:text-lg lg:text-xl font-semibold text-foreground">{amount}</span>
                        <span className="text-sm text-sand-1000">/{period.toLowerCase()}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sand-1100">
                        <span className="font-mono">{ellipsify(item.address, 4)}</span>
                        <span className="text-sand-900">|</span>
                        <span className="font-semibold text-sand-1000">V{item.subscription.header.version}</span>
                        <span className="text-sand-900">|</span>
                        <span className="font-semibold text-sand-1000">ID: {subInitId.toString()}</span>
                        {isStale && (
                            <>
                                <span className="text-sand-900">|</span>
                                <span className="font-semibold text-amber-600">Stale</span>
                            </>
                        )}
                        <span className="text-sand-900">|</span>
                        <span>Pulled: {pulled}</span>
                        {isCancelled && !planDeleted && (
                            <>
                                <span className="text-sand-900">|</span>
                                <span className="flex items-center gap-1 text-red-600">
                                    <Clock className="h-3 w-3" />
                                    Expires: {fmtDate(revokedTs)}
                                </span>
                            </>
                        )}
                    </div>

                    <div className={cn('pt-2 border-t', planDeleted ? 'border-red-200' : 'border-sand-200')}>
                        {(planDeleted || isGhostPlan) && isActive ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCancelAndRevokeOpen(true)}
                                className="w-full border-red-300 text-red-600 hover:bg-red-100 hover:text-red-700"
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
                                className="w-full border-amber-300 text-amber-600 hover:bg-amber-100 hover:text-amber-700"
                            >
                                {cancelSubscription.isPending ? 'Unsubscribing...' : 'Unsubscribe'}
                            </Button>
                        ) : canResume ? (
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setResumeOpen(true)}
                                    className="w-full border-teal-300 text-teal-700 hover:bg-teal-100 hover:text-teal-800"
                                >
                                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                    Resume
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setRevokeOpen(true)}
                                    disabled={!isExpired}
                                    className={cn(
                                        'w-full',
                                        isExpired
                                            ? 'border-red-300 text-red-600 hover:bg-red-100 hover:text-red-700'
                                            : 'border-gray-600/30 text-sand-1000 cursor-not-allowed',
                                    )}
                                >
                                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                    {isExpired ? 'Delete' : `${daysLeft ?? '?'}d`}
                                </Button>
                            </div>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRevokeOpen(true)}
                                disabled={!isExpired}
                                className={cn(
                                    'w-full',
                                    isExpired
                                        ? 'border-red-300 text-red-600 hover:bg-red-100 hover:text-red-700'
                                        : 'border-gray-600/30 text-sand-1000 cursor-not-allowed',
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
            <ResumeSubscriptionDialog item={item} open={resumeOpen} onOpenChange={setResumeOpen} />
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

    if (isLoading) {
        return (
            <Card className="border-0 border-all-dashed-medium bg-card">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-pulse text-muted-foreground">Loading subscriptions...</div>
                </CardContent>
            </Card>
        );
    }

    const hasSubs = subscriptions && subscriptions.length > 0;

    return (
        <Card className="relative overflow-hidden border-0 border-all-dashed-medium bg-card transition-all duration-300">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <CalendarCheck className="h-5 w-5 text-foreground" />
                        <CardTitle>My Subscriptions</CardTitle>
                    </div>
                    {hasSubs && <Badge variant="info">{subscriptions.length}</Badge>}
                </div>
            </CardHeader>
            <CardContent>
                {hasSubs ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {subscriptions.map(item => (
                            <SubscriptionCard key={item.address} item={item} />
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
