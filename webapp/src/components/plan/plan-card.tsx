import { useEffect, useMemo, useState } from 'react';
import {
    ExternalLink,
    Clock,
    Infinity as InfinityIcon,
    Pencil,
    Trash2,
    Sunset,
    ChevronDown,
    Lock,
    Star,
    Plus,
    X,
} from 'lucide-react';
import { Badge, Select, SelectItem, TextInput } from '@solana/design-system';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { ZERO_ADDRESS, PlanStatus } from '@subscriptions/client';
import { cn, ellipsify, USDC_MULTIPLIER, fmtDate, fmtDateTime, formatPeriod, formatPeriodLabel } from '@/lib/utils';
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations';
import { useSubscriptionAuthorityStatus } from '@/hooks/use-subscription-authority-status';
import { useTimeTravel } from '@/hooks/use-time-travel';
import { useWallet } from '@solana/connector/react';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import type { PlanItem } from '@/hooks/use-plans';
import { useMySubscriptions, useSubscriberCount } from '@/hooks/use-subscriptions';
import { PLAN_ICONS, ICON_MAP, parsePlanMeta, type PlanMeta } from '@/lib/plan-constants';
import { ExplorerLink } from '@/components/cluster/cluster-ui';

function ImmutableField({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid gap-2">
            <Label className="flex items-center gap-1.5 text-muted-foreground">
                <Lock className="h-3 w-3" />
                {label}
            </Label>
            <TextInput value={value} disabled />
        </div>
    );
}

function EditPlanDialog({
    plan,
    meta,
    open,
    onOpenChange,
}: {
    plan: PlanItem;
    meta: PlanMeta;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { updatePlan } = useSubscriptionsMutations();
    const { getCurrentTimestamp } = useTimeTravel();
    const isSunset = plan.status === PlanStatus.Sunset;
    const [blockTime, setBlockTime] = useState<number | undefined>();

    useEffect(() => {
        if (open)
            getCurrentTimestamp()
                .then(setBlockTime)
                .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [open, getCurrentTimestamp]);

    const [planName, setPlanName] = useState(meta.n || '');
    const [description, setDescription] = useState(meta.d || '');
    const [selectedIcon, setSelectedIcon] = useState(meta.i || '');
    const [website, setWebsite] = useState(meta.w || '');
    const [endDate, setEndDate] = useState(() => {
        const ts = Number(plan.data.endTs);
        if (ts === 0) return '';
        return new Date(ts * 1000).toISOString().slice(0, 10);
    });
    const [endHour, setEndHour] = useState(() => {
        const ts = Number(plan.data.endTs);
        if (ts === 0) return '12';
        return new Date(ts * 1000).getHours().toString();
    });
    const [sunsetMode, setSunsetMode] = useState(false);
    const [pullers, setPullers] = useState<string[]>(() => plan.data.pullers.filter(p => p !== ZERO_ADDRESS));

    const addPuller = () => {
        if (pullers.length < 4) setPullers([...pullers, '']);
    };
    const removePuller = (idx: number) => {
        setPullers(pullers.filter((_, i) => i !== idx));
    };
    const updatePuller = (idx: number, val: string) => {
        const next = [...pullers];
        next[idx] = val;
        setPullers(next);
    };

    const amount = Number(plan.data.terms.amount) / USDC_MULTIPLIER;
    const activeDestinations = plan.data.destinations.filter(d => d !== ZERO_ADDRESS);

    const metadataJson = useMemo(() => {
        const m: Record<string, string> = { n: planName, d: description };
        if (selectedIcon) m.i = selectedIcon;
        if (website) m.w = website;
        return JSON.stringify(m);
    }, [planName, description, selectedIcon, website]);

    const metadataBytes = useMemo(() => new TextEncoder().encode(metadataJson).length, [metadataJson]);

    const endTsComputed = endDate
        ? Math.floor(new Date(`${endDate}T${endHour.padStart(2, '0')}:00:00`).getTime() / 1000)
        : 0;
    const minEndTs = (blockTime ?? 0) + Number(plan.data.terms.periodHours) * 3600;
    const isEndDateValid = endTsComputed === 0 || endTsComputed > minEndTs;

    const handleUpdate = () => {
        const endTs = endTsComputed;
        const status = sunsetMode ? PlanStatus.Sunset : PlanStatus.Active;

        const filteredPullers = pullers.filter(p => p.length > 0);

        updatePlan.mutate(
            {
                planPda: plan.address,
                status,
                endTs,
                metadataUri: metadataJson,
                pullers: filteredPullers,
            },
            { onSuccess: () => onOpenChange(false) },
        );
    };

    const isFormValid =
        planName.length > 0 &&
        description.length > 0 &&
        metadataBytes <= 128 &&
        !(sunsetMode && !endDate) &&
        isEndDateValid &&
        (endTsComputed === 0 || blockTime !== undefined);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[750px] border-emerald-500/30">
                <DialogHeader>
                    <DialogTitle>Edit Plan: {meta.n || 'Unnamed'}</DialogTitle>
                    <DialogDescription>
                        Editable fields are highlighted. Greyed out fields are immutable on-chain.
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-[70vh] overflow-y-auto pr-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                        <div className="sm:col-span-2">
                            <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">
                                Metadata (editable)
                            </p>
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="edit-name">Plan Name</Label>
                            <TextInput
                                id="edit-name"
                                value={planName}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPlanName(e.target.value)}
                                disabled={isSunset}
                            />
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="edit-desc">Description</Label>
                            <TextInput
                                id="edit-desc"
                                value={description}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
                                disabled={isSunset}
                            />
                        </div>

                        <div className="grid gap-2">
                            <Label>Icon</Label>
                            <Select
                                value={selectedIcon || null}
                                onValueChange={value => setSelectedIcon(value ?? '')}
                                placeholder="Select an icon"
                                disabled={isSunset}
                            >
                                {PLAN_ICONS.map(({ name, label, icon: Icon }) => (
                                    <SelectItem key={name} value={name} icon={<Icon />}>
                                        {label}
                                    </SelectItem>
                                ))}
                            </Select>
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="edit-website">Website URL</Label>
                            <TextInput
                                id="edit-website"
                                value={website}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWebsite(e.target.value)}
                                placeholder="https://example.com"
                                disabled={isSunset}
                            />
                        </div>

                        <div className="sm:col-span-2">
                            <p
                                className={cn(
                                    'text-xs text-right',
                                    metadataBytes > 128 ? 'text-destructive' : 'text-muted-foreground',
                                )}
                            >
                                {metadataBytes}/128 bytes
                            </p>
                        </div>

                        <div className="sm:col-span-2 h-px bg-border" />

                        <div className="sm:col-span-2">
                            <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">
                                Plan Parameters
                            </p>
                        </div>

                        <ImmutableField label="Amount (USDC)" value={`$${amount}`} />
                        <ImmutableField label="Billing Period" value={formatPeriodLabel(plan.data.terms.periodHours)} />

                        <div className="sm:col-span-2 grid gap-2">
                            <Label>End Date/Time</Label>
                            <div className="flex gap-2">
                                <TextInput
                                    type="date"
                                    value={endDate}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
                                    min={new Date(minEndTs * 1000).toLocaleDateString('en-CA')}
                                    className="flex-1"
                                    disabled={isSunset}
                                />
                                <Select
                                    value={endHour}
                                    disabled={isSunset}
                                    onValueChange={value => {
                                        if (value) setEndHour(value);
                                    }}
                                    className="w-28 shrink-0"
                                >
                                    {Array.from({ length: 24 }, (_, i) => (
                                        <SelectItem key={i} value={i.toString()}>
                                            {i.toString().padStart(2, '0')}:00
                                        </SelectItem>
                                    ))}
                                </Select>
                            </div>
                            {endDate && !isEndDateValid && (
                                <p className="text-xs text-destructive">
                                    End date must be at least one billing period from now
                                </p>
                            )}
                            <p className="text-xs text-muted-foreground">Leave empty for no end date</p>
                        </div>

                        <div className="sm:col-span-2 grid gap-2">
                            <Label className="flex items-center gap-1.5 text-muted-foreground">
                                <Lock className="h-3 w-3" />
                                Destinations
                            </Label>
                            {activeDestinations.length > 0 ? (
                                activeDestinations.map((d, i) => (
                                    <TextInput key={i} value={ellipsify(d, 8)} disabled inputClassName="font-mono" />
                                ))
                            ) : (
                                <p className="text-sm text-muted-foreground/60 italic">
                                    Any destination (not restricted)
                                </p>
                            )}
                        </div>

                        <div className="sm:col-span-2 grid gap-2">
                            <Label>
                                Pullers <span className="text-muted-foreground font-normal">(optional, max 4)</span>
                            </Label>
                            {pullers.map((addr, i) => (
                                <div key={i} className="flex gap-2">
                                    <TextInput
                                        value={addr}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                            updatePuller(i, e.target.value)
                                        }
                                        placeholder="Solana address"
                                        className="flex-1"
                                        inputClassName="font-mono"
                                        disabled={isSunset}
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removePuller(i)}
                                        disabled={isSunset}
                                        className="shrink-0 text-muted-foreground hover:text-destructive"
                                    >
                                        <X className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                            {pullers.length < 4 && !isSunset && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={addPuller}
                                    className="w-fit gap-1"
                                >
                                    <Plus className="h-3 w-3" /> Add
                                </Button>
                            )}
                            <p className="text-xs text-muted-foreground">
                                Addresses allowed to pull from this plan (empty = owner only)
                            </p>
                        </div>

                        <div className="sm:col-span-2 h-px bg-border" />

                        {!isSunset && (
                            <div className="sm:col-span-2 flex items-center gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                                <input
                                    type="checkbox"
                                    id="sunset-check"
                                    checked={sunsetMode}
                                    onChange={e => setSunsetMode(e.target.checked)}
                                    className="accent-amber-500"
                                />
                                <Label htmlFor="sunset-check" className="text-amber-400 text-sm cursor-pointer">
                                    Sunset this plan (terminal, stops new subscriptions)
                                </Label>
                            </div>
                        )}
                        {sunsetMode && !endDate && (
                            <div className="sm:col-span-2">
                                <p className="text-xs text-red-400">Sunset requires an end date.</p>
                            </div>
                        )}
                        {isSunset && (
                            <div className="sm:col-span-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                                <p className="text-sm text-amber-400">
                                    This plan is in Sunset status. No further edits are allowed.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleUpdate}
                        disabled={updatePlan.isPending || isSunset || !isFormValid}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                        {updatePlan.isPending ? 'Updating...' : 'Update Plan'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DeletePlanDialog({
    plan,
    meta,
    open,
    onOpenChange,
}: {
    plan: PlanItem;
    meta: PlanMeta;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { deletePlan } = useSubscriptionsMutations();
    const { getCurrentTimestamp } = useTimeTravel();
    const endTs = Number(plan.data.endTs);
    const [canDelete, setCanDelete] = useState(false);

    useEffect(() => {
        if (!open || endTs === 0) return;
        getCurrentTimestamp()
            .then(bt => {
                setCanDelete(bt > endTs);
            })
            .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [open, endTs, getCurrentTimestamp]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-red-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-red-400">Delete Plan: {meta.n || 'Unnamed'}</DialogTitle>
                    <DialogDescription>
                        {canDelete
                            ? 'This plan has expired. Deleting will close the account and return rent to your wallet.'
                            : 'This plan cannot be deleted yet. A plan must have an end date that has passed before it can be deleted.'}
                    </DialogDescription>
                </DialogHeader>
                {!canDelete && (
                    <div className="text-sm text-gray-400 space-y-1 p-3 rounded-lg border border-gray-700 bg-gray-900/50">
                        {endTs === 0 ? (
                            <p>This plan has no expiry. Set an end date via Edit first, then wait for it to expire.</p>
                        ) : (
                            <p>This plan expires on {fmtDateTime(endTs)}. You can delete it after that.</p>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={() =>
                            deletePlan.mutate({ planPda: plan.address }, { onSuccess: () => onOpenChange(false) })
                        }
                        disabled={!canDelete || deletePlan.isPending}
                    >
                        {deletePlan.isPending ? 'Deleting...' : 'Delete Plan'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SubscribeDialog({
    plan,
    meta,
    open,
    onOpenChange,
}: {
    plan: PlanItem;
    meta: PlanMeta;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { subscribe, initSubscriptionAuthority } = useSubscriptionsMutations();
    const {
        isInitialized,
        isLoading: statusLoading,
        refetch: refetchStatus,
    } = useSubscriptionAuthorityStatus(plan.data.mint);
    const { account } = useWallet();
    const amount = Number(plan.data.terms.amount) / USDC_MULTIPLIER;

    const handleInit = async () => {
        if (!account) return;
        const mint = address(plan.data.mint);
        const [userAta] = await findAssociatedTokenPda({
            mint,
            owner: address(account),
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        initSubscriptionAuthority.mutate(
            {
                tokenMint: plan.data.mint,
                userAta: userAta,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            },
            { onSuccess: () => refetchStatus() },
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="border-emerald-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-emerald-400">Subscribe to: {meta.n || 'Unnamed'}</DialogTitle>
                    <DialogDescription>
                        ${amount} / {formatPeriod(plan.data.terms.periodHours)} from merchant {ellipsify(plan.owner, 4)}
                    </DialogDescription>
                </DialogHeader>

                {statusLoading ? (
                    <div className="text-sm text-muted-foreground animate-pulse py-4 text-center">
                        Checking wallet status...
                    </div>
                ) : !isInitialized ? (
                    <div className="space-y-3">
                        <div className="text-sm text-amber-400 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                            Your SubscriptionAuthority account must be initialized for this token before subscribing.
                        </div>
                        <Button
                            onClick={handleInit}
                            disabled={initSubscriptionAuthority.isPending}
                            className="w-full bg-amber-600 hover:bg-amber-500 text-white"
                        >
                            {initSubscriptionAuthority.isPending
                                ? 'Initializing...'
                                : 'Initialize SubscriptionAuthority'}
                        </Button>
                    </div>
                ) : (
                    <DialogFooter>
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() =>
                                subscribe.mutate(
                                    {
                                        merchant: plan.owner,
                                        planId: plan.data.planId,
                                        tokenMint: plan.data.mint,
                                        expectedAmount: plan.data.terms.amount,
                                        expectedPeriodHours: plan.data.terms.periodHours,
                                        expectedCreatedAt: plan.data.terms.createdAt,
                                    },
                                    { onSuccess: () => onOpenChange(false) },
                                )
                            }
                            disabled={subscribe.isPending}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white"
                        >
                            {subscribe.isPending ? 'Subscribing...' : 'Subscribe'}
                        </Button>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}

function PlanExpandedDetails({ plan, isExpanded }: { plan: PlanItem; isExpanded: boolean }) {
    const activeDestinations = plan.data.destinations.filter(d => d !== ZERO_ADDRESS);
    const activePullers = plan.data.pullers.filter(p => p !== ZERO_ADDRESS);

    return (
        <div
            className="overflow-hidden transition-all ease-[cubic-bezier(0.4,0,0.2,1)]"
            style={{
                maxHeight: isExpanded ? 600 : 0,
                opacity: isExpanded ? 1 : 0,
                transitionDuration: isExpanded ? '700ms' : '500ms',
            }}
        >
            <div
                className="h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent my-5 transition-all duration-1000 ease-out"
                style={{ width: isExpanded ? '100%' : '0%', opacity: isExpanded ? 1 : 0 }}
            />

            <div
                className={cn(
                    'transition-all duration-700 delay-150 ease-out',
                    isExpanded ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
                )}
            >
                <p className="text-[11px] font-semibold text-emerald-400/60 uppercase tracking-[0.15em] mb-2.5">
                    Destinations
                </p>
                {activeDestinations.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {activeDestinations.map(d => (
                            <ExplorerLink
                                key={d}
                                address={d}
                                label={ellipsify(d, 6)}
                                className="bg-emerald-500/8 hover:bg-emerald-500/15 border border-emerald-500/20 hover:border-emerald-500/40 px-3 py-1.5 rounded-lg font-mono text-xs text-emerald-300 hover:text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0)] hover:shadow-[0_0_8px_rgba(16,185,129,0.15)] transition-all duration-300 no-underline"
                            />
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-gray-500/70 italic pl-1">Any destination (unrestricted)</p>
                )}
            </div>

            <div
                className={cn(
                    'transition-all duration-700 delay-300 ease-out mt-4',
                    isExpanded ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
                )}
            >
                <p className="text-[11px] font-semibold text-emerald-400/60 uppercase tracking-[0.15em] mb-2.5">
                    Pullers
                </p>
                {activePullers.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {activePullers.map(p => (
                            <ExplorerLink
                                key={p}
                                address={p}
                                label={ellipsify(p, 6)}
                                className="bg-emerald-500/8 hover:bg-emerald-500/15 border border-emerald-500/20 hover:border-emerald-500/40 px-3 py-1.5 rounded-lg font-mono text-xs text-emerald-300 hover:text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0)] hover:shadow-[0_0_8px_rgba(16,185,129,0.15)] transition-all duration-300 no-underline"
                            />
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-gray-500/70 italic pl-1">Owner only</p>
                )}
            </div>

            <div
                className={cn(
                    'transition-all duration-700 delay-[450ms] ease-out mt-4',
                    isExpanded ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
                )}
            >
                <p className="text-[11px] font-semibold text-emerald-400/60 uppercase tracking-[0.15em] mb-2.5">
                    On-chain Details
                </p>
                <div className="grid grid-cols-1 gap-2.5">
                    <div className="flex items-center justify-between bg-slate-800/40 rounded-lg px-3 py-2 border border-emerald-500/8 hover:border-emerald-500/20 transition-colors">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider">Plan ID</p>
                        <p className="font-mono text-sm text-white">{Number(plan.data.planId)}</p>
                    </div>
                    <div className="flex items-center justify-between bg-slate-800/40 rounded-lg px-3 py-2 border border-emerald-500/8 hover:border-emerald-500/20 transition-colors">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider">Token Mint</p>
                        <ExplorerLink
                            address={plan.data.mint}
                            label={ellipsify(plan.data.mint, 4)}
                            className="font-mono text-sm text-emerald-300 hover:text-emerald-200 no-underline"
                        />
                    </div>
                    <div className="flex items-center justify-between bg-slate-800/40 rounded-lg px-3 py-2 border border-emerald-500/8 hover:border-emerald-500/20 transition-colors">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider">Period</p>
                        <p className="font-mono text-sm text-white">{formatPeriodLabel(plan.data.terms.periodHours)}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function PlanCard({
    plan,
    variant = 'owner',
    isExpanded = false,
    onToggleExpand,
}: {
    plan: PlanItem;
    variant?: 'owner' | 'marketplace';
    isExpanded?: boolean;
    onToggleExpand?: () => void;
}) {
    const [editOpen, setEditOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [subscribeOpen, setSubscribeOpen] = useState(false);
    const { data: mySubscriptions } = useMySubscriptions();
    const matchingSub = useMemo(
        () => mySubscriptions?.find(s => s.subscription.header.delegatee === plan.address) ?? null,
        [mySubscriptions, plan.address],
    );
    const isSubscribed = !!matchingSub;
    const subExpiresAtTs = matchingSub ? Number(matchingSub.subscription.expiresAtTs) : 0;
    const isCancelledSub = isSubscribed && subExpiresAtTs > 0;
    const [subDaysLeft, setSubDaysLeft] = useState<number | null>(null);

    const meta = useMemo(() => parsePlanMeta(plan.data.metadataUri), [plan.data.metadataUri]);

    const Icon = (meta.i && ICON_MAP[meta.i]) || Star;
    const amount = Number(plan.data.terms.amount) / USDC_MULTIPLIER;
    const period = formatPeriod(plan.data.terms.periodHours);
    const activeDestinations = plan.data.destinations.filter(d => d !== ZERO_ADDRESS).length;
    const activePullers = plan.data.pullers.filter(p => p !== ZERO_ADDRESS).length;
    const { data: subscriberCount } = useSubscriberCount(variant === 'owner' ? plan.address : null);
    const { getCurrentTimestamp } = useTimeTravel();
    const hasExpiry = Number(plan.data.endTs) > 0;
    const isSunset = plan.status === PlanStatus.Sunset;
    const [planExpired, setIsExpired] = useState(false);

    const [sunsetIntensity, setSunsetIntensity] = useState(0);

    useEffect(() => {
        if (!hasExpiry) return;
        const endTs = Number(plan.data.endTs);
        getCurrentTimestamp()
            .then(blockTime => {
                setIsExpired(blockTime > endTs);
                if (isSunset) {
                    const totalWindow = 30 * 24 * 3600;
                    const remaining = endTs - blockTime;
                    setSunsetIntensity(remaining <= 0 ? 1 : Math.max(0, Math.min(1, 1 - remaining / totalWindow)));
                }
            })
            .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [hasExpiry, isSunset, plan.data.endTs, getCurrentTimestamp]);

    useEffect(() => {
        if (!isCancelledSub) return;
        getCurrentTimestamp()
            .then(bt => {
                const secsLeft = subExpiresAtTs - bt;
                setSubDaysLeft(secsLeft <= 0 ? 0 : Math.ceil(secsLeft / 86400));
            })
            .catch(err => console.error('Failed to fetch block timestamp:', err));
    }, [isCancelledSub, subExpiresAtTs, getCurrentTimestamp]);

    const overlayStyle = planExpired
        ? {
              background:
                  'linear-gradient(to bottom, rgba(239, 68, 68, 0.18) 0%, rgba(185, 28, 28, 0.10) 40%, transparent 75%)',
          }
        : isSunset
          ? {
                background: `linear-gradient(to bottom, rgba(245, 158, 11, ${0.08 + sunsetIntensity * 0.2}) 0%, rgba(234, 88, 12, ${sunsetIntensity * 0.12}) 40%, transparent 75%)`,
            }
          : undefined;

    const borderClass = planExpired
        ? 'border-red-500/40 hover:border-red-500/60 shadow-red-500/10'
        : isSunset
          ? sunsetIntensity > 0.6
              ? 'border-orange-500/40 hover:border-orange-500/60 shadow-orange-500/10'
              : 'border-amber-500/30 hover:border-amber-500/50 shadow-amber-500/5'
          : 'border-emerald-500/25 hover:border-emerald-500/45 shadow-emerald-500/5';

    return (
        <>
            <Card
                className={cn(
                    'w-full bg-gradient-to-br from-slate-900/80 via-emerald-900/20 to-slate-900/80 backdrop-blur-xl shadow-xl hover:shadow-2xl transition-all duration-500 rounded-2xl relative overflow-hidden',
                    borderClass,
                )}
            >
                {overlayStyle && (
                    <div className="absolute inset-0 pointer-events-none rounded-2xl" style={overlayStyle} />
                )}
                <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 to-transparent pointer-events-none" />
                <CardContent className="p-6 space-y-5 relative z-10">
                    <div
                        className={cn(variant === 'owner' && onToggleExpand && 'cursor-pointer')}
                        onClick={variant === 'owner' ? onToggleExpand : undefined}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-3.5 min-w-0">
                                <div className="rounded-xl bg-emerald-500/15 p-3 shrink-0 ring-1 ring-emerald-500/20">
                                    <Icon className="h-6 w-6 text-emerald-400" />
                                </div>
                                <div className="min-w-0">
                                    <p className="font-bold text-lg text-white tracking-tight truncate">
                                        {meta.n || 'Unnamed Plan'}
                                    </p>
                                    <p className="text-sm text-gray-400 truncate mt-0.5">
                                        {meta.d || 'No description'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {isSunset && (
                                    <Badge variant="warning" className="shrink-0">
                                        <Sunset className="h-3 w-3 mr-1" />
                                        Sunset
                                    </Badge>
                                )}
                                {variant === 'owner' && onToggleExpand && (
                                    <ChevronDown
                                        className={cn(
                                            'h-4 w-4 text-gray-500 transition-transform duration-500 ease-out shrink-0',
                                            isExpanded && 'rotate-180',
                                        )}
                                    />
                                )}
                            </div>
                        </div>

                        <div>
                            <div className="flex items-baseline gap-1.5">
                                <span className="text-xl sm:text-2xl lg:text-3xl font-black text-emerald-400 tracking-tight">
                                    ${amount}
                                </span>
                                <span className="text-base font-medium text-emerald-400/60">/{period}</span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-2">
                                {hasExpiry ? (
                                    planExpired ? (
                                        <div className="flex items-center gap-1.5 text-sm text-red-300 bg-red-500/10 px-3 py-1 rounded-lg border border-red-500/25">
                                            <Clock className="h-3.5 w-3.5 text-red-400" />
                                            <span>Expired {fmtDate(Number(plan.data.endTs))}</span>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1.5 text-sm text-gray-300 bg-slate-800/60 px-3 py-1 rounded-lg border border-emerald-500/15">
                                            <Clock className="h-3.5 w-3.5 text-emerald-400/70" />
                                            <span>Expires {fmtDate(Number(plan.data.endTs))}</span>
                                        </div>
                                    )
                                ) : (
                                    <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-lg border border-emerald-500/20">
                                        <InfinityIcon className="h-4 w-4" />
                                        <span>No expiry</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {variant === 'owner' && (
                            <div className="flex items-center gap-4 text-sm text-gray-400">
                                <span>
                                    <span className="font-semibold text-emerald-300">{subscriberCount ?? 0}</span>{' '}
                                    subscriber{subscriberCount !== 1 ? 's' : ''}
                                </span>
                                <span className="text-emerald-800">|</span>
                                <span>
                                    <span className="font-semibold text-emerald-300">{activeDestinations}</span> dest.
                                </span>
                                <span className="text-emerald-800">|</span>
                                <span>
                                    <span className="font-semibold text-emerald-300">{activePullers}</span> puller
                                    {activePullers !== 1 ? 's' : ''}
                                </span>
                            </div>
                        )}
                    </div>

                    {variant === 'owner' && <PlanExpandedDetails plan={plan} isExpanded={isExpanded} />}

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-emerald-500/10">
                        <span className="font-mono text-xs text-gray-500 break-all leading-relaxed">
                            {plan.address}
                        </span>
                        {variant === 'marketplace' && meta.w && (
                            <a
                                href={meta.w}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300 transition-colors shrink-0"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Website
                            </a>
                        )}
                    </div>

                    {variant === 'marketplace' && (
                        <div className="flex justify-center pt-2 border-t border-emerald-500/10">
                            {isCancelledSub ? (
                                <Badge variant="danger" className="w-full justify-center" style={{ height: '2.25rem' }}>
                                    Cancelled{' '}
                                    {subDaysLeft !== null && subDaysLeft > 0
                                        ? `\u2014 ${subDaysLeft} days until revoke`
                                        : ''}
                                </Badge>
                            ) : isSubscribed ? (
                                <Badge
                                    variant="warning"
                                    className="w-full justify-center"
                                    style={{ height: '2.25rem' }}
                                >
                                    Already Subscribed
                                </Badge>
                            ) : (
                                <Button
                                    size="sm"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        setSubscribeOpen(true);
                                    }}
                                    disabled={isSunset || planExpired}
                                    className="w-full h-9 bg-emerald-600 hover:bg-emerald-500 text-white"
                                >
                                    Subscribe
                                </Button>
                            )}
                        </div>
                    )}

                    {variant === 'owner' && (
                        <div className="flex items-center gap-2 pt-2 border-t border-emerald-500/10">
                            {!planExpired && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        setEditOpen(true);
                                    }}
                                    disabled={isSunset}
                                    className="flex-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                                >
                                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                                    Edit
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setDeleteOpen(true);
                                }}
                                className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            >
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                Delete
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {variant === 'owner' && (
                <>
                    <EditPlanDialog plan={plan} meta={meta} open={editOpen} onOpenChange={setEditOpen} />
                    <DeletePlanDialog plan={plan} meta={meta} open={deleteOpen} onOpenChange={setDeleteOpen} />
                </>
            )}
            {variant === 'marketplace' && (
                <SubscribeDialog plan={plan} meta={meta} open={subscribeOpen} onOpenChange={setSubscribeOpen} />
            )}
        </>
    );
}
