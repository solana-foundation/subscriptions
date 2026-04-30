import { RefreshCw, FileX, Coins, ShieldAlert, Power, Trash2 } from 'lucide-react';
import {
    Button as SolanaButton,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TextInput,
} from '@solana/design-system';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { useDelegations, useIncomingDelegations, type DelegationItem } from '@/hooks/use-delegations';
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations';
import { useGetTokenAccountsQuery } from '@/components/account/account-data-access';
import { useWallet } from '@solana/connector/react';
import { address } from '@solana/kit';
import { useMemo, useState } from 'react';
import {
    USDC_MULTIPLIER,
    isExpired,
    invalidateWithDelay,
    recurringAvailable,
    fmtDateTime,
    fmtDateShort,
} from '@/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreateDelegationDialog } from './create-delegation-dialog';
import type { TokenAccountEntry } from '@/lib/types';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { getBlockTimestamp } from '@/hooks/use-time-travel';
import { useMySubscriptions } from '@/hooks/use-subscriptions';
import { getDelegationApprovalState } from '@/lib/delegation-approval-state';

interface ActiveDelegationsProps {
    tokenMint: string;
    isInitialized: boolean;
    isApproved: boolean;
    subscriptionAuthorityPayer?: string | null;
    subscriptionAuthorityInitId?: bigint | null;
    onInitSuccess?: () => void;
}

type TabType = 'outgoing' | 'incoming';
type OutgoingSubTab = 'active' | 'expired';

const ADDRESS_TRUNCATE_THRESHOLD = 12;
const ADDRESS_VISIBLE_CHARS = 4;

function formatAddress(addr: string): string {
    if (addr.length <= ADDRESS_TRUNCATE_THRESHOLD) return addr;
    return `${addr.slice(0, ADDRESS_VISIBLE_CHARS)}...${addr.slice(-ADDRESS_VISIBLE_CHARS)}`;
}

function formatDelegationDateTime(ts: bigint | number): string {
    return fmtDateTime(Number(ts));
}

function formatDuration(seconds: bigint | number): string {
    const s = Number(seconds);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
    if (hours > 0) return `${hours}h`;
    return `${Math.floor(s / 60)}m`;
}

function formatTimeRemaining(expiryTs: bigint, blockTime?: number): string | null {
    if (blockTime == null) return null;
    const remaining = Number(expiryTs) - blockTime;
    if (remaining <= 0) return null;
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h left`;
    return `${Math.floor(remaining / 60)}m left`;
}

function formatAmount(amount: bigint | number): string {
    const num = Number(amount) / USDC_MULTIPLIER;
    return num.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
}

interface RevokeDelegationButtonProps {
    delegation: DelegationItem;
}

function RevokeDelegationButton({ delegation }: RevokeDelegationButtonProps) {
    const [open, setOpen] = useState(false);
    const { revokeDelegation } = useSubscriptionsMutations();

    const handleRevoke = async () => {
        try {
            await revokeDelegation.mutateAsync({
                delegationAccount: delegation.address,
                payer: delegation.data.header.payer,
            });
            setOpen(false);
        } catch {
            // wallet rejection or tx failure - button resets via isPending
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="bg-[#2d1b1b] hover:bg-[#3a2020] text-[#f87171] border-[#ef4444]/20 shadow-[0_0_15px_rgba(239,68,68,0.1)] hover:shadow-[0_0_20px_rgba(239,68,68,0.2)] transition-all rounded-full px-6"
                >
                    Revoke
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Revoke Delegation</DialogTitle>
                    <DialogDescription>
                        Are you sure you want to revoke this delegation? This action cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <div className="py-4">
                    <p className="text-sm text-muted-foreground">
                        Delegatee: <span className="font-mono">{formatAddress(delegation.data.header.delegatee)}</span>
                    </p>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleRevoke} disabled={revokeDelegation.isPending}>
                        {revokeDelegation.isPending ? 'Revoking...' : 'Revoke'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface TransferDelegationButtonProps {
    delegation: DelegationItem;
    tokenMint: string;
    disabled?: boolean;
    blockTime?: number;
}

function TransferDelegationButton({ delegation, tokenMint, disabled, blockTime }: TransferDelegationButtonProps) {
    const [open, setOpen] = useState(false);
    const [amount, setAmount] = useState('');
    const { transferFixed, transferRecurring } = useSubscriptionsMutations();

    const isFixed = delegation.type === 'Fixed';
    const availableRaw = isFixed
        ? delegation.data.amount
        : recurringAvailable(
              delegation.data.amountPerPeriod,
              delegation.data.amountPulledInPeriod,
              delegation.data.currentPeriodStartTs,
              delegation.data.periodLengthS,
              blockTime,
          );
    const availableAmount = formatAmount(availableRaw);

    const handleTransfer = async () => {
        try {
            const amountBigInt = BigInt(Math.floor(parseFloat(amount) * USDC_MULTIPLIER));
            const mutation = isFixed ? transferFixed : transferRecurring;

            await mutation.mutateAsync({
                tokenMint,
                delegationAccount: delegation.address,
                delegator: delegation.data.header.delegator,
                amount: amountBigInt,
            });

            setOpen(false);
            setAmount('');
        } catch {
            // wallet rejection or tx failure - button resets via isPending
        }
    };

    const isPending = transferFixed.isPending || transferRecurring.isPending;

    if (disabled) {
        return (
            <Button variant="outline" size="sm" disabled className="text-muted-foreground">
                Expired
            </Button>
        );
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="bg-green-500/10 hover:bg-green-500/20 text-green-400 border-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.15)] hover:shadow-[0_0_20px_rgba(34,197,94,0.3)] transition-all rounded-full px-5"
                >
                    Transfer
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Transfer</DialogTitle>
                    <DialogDescription>Enter the amount you want to transfer from this delegation.</DialogDescription>
                </DialogHeader>
                <div className="py-4 space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Amount (USDC)</label>
                        <TextInput
                            type="number"
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                            placeholder="0.00"
                        />
                        <p className="text-xs text-muted-foreground">Available: {availableAmount} USDC</p>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        <p>
                            Delegator:{' '}
                            <span className="font-mono">{formatAddress(delegation.data.header.delegator)}</span>
                        </p>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>
                    <SolanaButton
                        onClick={handleTransfer}
                        disabled={isPending || !amount || parseFloat(amount) <= 0}
                        loading={isPending}
                    >
                        Transfer
                    </SolanaButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function formatPeriodRange(startTs: bigint | null, periodLengthS: bigint, blockTime?: number): string {
    if (startTs == null) return 'Not started';
    const start = Number(startTs);
    const period = Number(periodLengthS);
    const end = start + period;
    if (blockTime != null && blockTime >= end) {
        const elapsed = Math.floor((blockTime - start) / period);
        const currentStart = start + elapsed * period;
        const currentEnd = currentStart + period;
        return `${fmtDateShort(currentStart)} - ${fmtDateShort(currentEnd)}`;
    }
    return `${fmtDateShort(start)} - ${fmtDateShort(end)}`;
}

interface DelegationTableProps {
    delegations: DelegationItem[];
    mode: TabType;
    showExpired?: boolean;
    tokenMint: string;
    blockTime?: number;
    subscriptionAuthorityInitId?: bigint | null;
}

function FixedDelegationTable({
    delegations,
    mode,
    showExpired,
    tokenMint,
    blockTime,
    subscriptionAuthorityInitId,
}: DelegationTableProps) {
    if (delegations.length === 0) return null;
    const isOutgoing = mode === 'outgoing';
    const partyLabel = isOutgoing ? 'Delegatee' : 'Delegator';

    return (
        <div className="space-y-2 w-full">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground px-1">
                <Coins className="h-4 w-4" />
                <span>Fixed</span>
                <span className="px-1.5 py-0.5 rounded-full bg-muted text-xs">{delegations.length}</span>
            </div>
            <div className="w-full rounded-2xl overflow-hidden bg-gradient-to-br from-[#121629]/80 to-black/60 backdrop-blur-xl shadow-[0_8px_30px_rgba(0,0,0,0.4)] border border-blue-500/15 overflow-x-auto">
                <Table className="min-w-[650px] rounded-none border-0 bg-transparent [&_table]:table-fixed">
                    <TableHeader className="bg-blue-900/30 backdrop-blur-md">
                        <TableRow className="border-none hover:bg-blue-900/30 border-b border-white/5">
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '18%' }}>
                                {partyLabel}
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '20%' }}>
                                Amount
                            </TableHead>
                            <TableHead
                                className="text-white/40 font-semibold py-4 text-center"
                                style={{ width: '22%' }}
                            >
                                &mdash;
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '28%' }}>
                                Expiry
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '12%' }}>
                                Action
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {delegations.map(d => {
                            const rowExpired = showExpired || (!isOutgoing && isExpired(d.data.expiryTs, blockTime));
                            const isStale =
                                subscriptionAuthorityInitId != null &&
                                d.data.header.initId !== subscriptionAuthorityInitId;
                            return (
                                <TableRow
                                    key={d.address}
                                    className={`border-none hover:bg-white/[0.03] transition-colors ${rowExpired || isStale ? 'opacity-60' : ''}`}
                                >
                                    <TableCell className="py-5 text-center">
                                        <div className="font-mono text-[15px] text-gray-300">
                                            {formatAddress(
                                                isOutgoing ? d.data.header.delegatee : d.data.header.delegator,
                                            )}
                                        </div>
                                        <div className="flex items-center justify-center gap-2 mt-0.5 text-[11px] font-sans">
                                            <span className="text-blue-400/50 font-bold">V{d.data.header.version}</span>
                                            <span className="text-gray-700">|</span>
                                            <span className="text-teal-400/40 font-bold">
                                                ID: {d.data.header.initId.toString()}
                                            </span>
                                            {isStale && (
                                                <>
                                                    <span className="text-gray-700">|</span>
                                                    <span className="text-amber-400 font-semibold">Stale</span>
                                                </>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-emerald-400 py-5 font-medium text-[15px] text-center">
                                        {formatAmount(d.data.amount)} USDC
                                    </TableCell>
                                    <TableCell className="py-5" />
                                    <TableCell className="py-5 text-gray-300 text-[15px] text-center">
                                        {rowExpired ? (
                                            <span className="text-red-400 font-medium">Expired</span>
                                        ) : d.data.expiryTs === 0n ? (
                                            <span className="text-gray-500 text-sm">No expiry</span>
                                        ) : (
                                            <div>
                                                <div>{formatDelegationDateTime(d.data.expiryTs)}</div>
                                                {formatTimeRemaining(d.data.expiryTs, blockTime) && (
                                                    <div className="text-xs text-blue-400/70 mt-0.5">
                                                        {formatTimeRemaining(d.data.expiryTs, blockTime)}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="py-5 text-center">
                                        {isOutgoing ? (
                                            <RevokeDelegationButton delegation={d} />
                                        ) : (
                                            <TransferDelegationButton
                                                delegation={d}
                                                tokenMint={tokenMint}
                                                disabled={rowExpired || isStale}
                                                blockTime={blockTime}
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

function RecurringDelegationTable({
    delegations,
    mode,
    showExpired,
    tokenMint,
    blockTime,
    subscriptionAuthorityInitId,
}: DelegationTableProps) {
    if (delegations.length === 0) return null;
    const isOutgoing = mode === 'outgoing';
    const partyLabel = isOutgoing ? 'Delegatee' : 'Delegator';

    return (
        <div className="space-y-2 w-full">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground px-1">
                <RefreshCw className="h-4 w-4" />
                <span>Recurring</span>
                <span className="px-1.5 py-0.5 rounded-full bg-muted text-xs">{delegations.length}</span>
            </div>
            <div className="w-full rounded-2xl overflow-hidden bg-gradient-to-br from-[#121629]/80 to-black/60 backdrop-blur-xl shadow-[0_8px_30px_rgba(0,0,0,0.4)] border border-blue-500/15 overflow-x-auto">
                <Table className="min-w-[650px] rounded-none border-0 bg-transparent [&_table]:table-fixed">
                    <TableHeader className="bg-blue-900/30 backdrop-blur-md">
                        <TableRow className="border-none hover:bg-blue-900/30 border-b border-white/5">
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '18%' }}>
                                {partyLabel}
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '20%' }}>
                                Amount
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '22%' }}>
                                Current Period
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '28%' }}>
                                Expiry
                            </TableHead>
                            <TableHead className="text-white font-semibold py-4 text-center" style={{ width: '12%' }}>
                                Action
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {delegations.map(d => {
                            const rowExpired = showExpired || (!isOutgoing && isExpired(d.data.expiryTs, blockTime));
                            const isStale =
                                subscriptionAuthorityInitId != null &&
                                d.data.header.initId !== subscriptionAuthorityInitId;
                            const available = recurringAvailable(
                                d.data.amountPerPeriod,
                                d.data.amountPulledInPeriod,
                                d.data.currentPeriodStartTs,
                                d.data.periodLengthS,
                                blockTime,
                            );
                            return (
                                <TableRow
                                    key={d.address}
                                    className={`border-none hover:bg-white/[0.03] transition-colors ${rowExpired || isStale ? 'opacity-60' : ''}`}
                                >
                                    <TableCell className="py-5 text-center">
                                        <div className="font-mono text-[15px] text-gray-300">
                                            {formatAddress(
                                                isOutgoing ? d.data.header.delegatee : d.data.header.delegator,
                                            )}
                                        </div>
                                        <div className="flex items-center justify-center gap-2 mt-0.5 text-[11px] font-sans">
                                            <span className="text-blue-400/50 font-bold">V{d.data.header.version}</span>
                                            <span className="text-gray-700">|</span>
                                            <span className="text-teal-400/40 font-bold">
                                                ID: {d.data.header.initId.toString()}
                                            </span>
                                            {isStale && (
                                                <>
                                                    <span className="text-gray-700">|</span>
                                                    <span className="text-amber-400 font-semibold">Stale</span>
                                                </>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-emerald-400 py-5 font-medium text-[15px] text-center">
                                        {formatAmount(available)} USDC
                                        <span className="text-xs text-emerald-400/60 ml-1">
                                            / {formatDuration(d.data.periodLengthS)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="py-5 text-sm text-center font-bold text-white">
                                        {formatPeriodRange(
                                            d.data.currentPeriodStartTs,
                                            d.data.periodLengthS,
                                            blockTime,
                                        )}
                                    </TableCell>
                                    <TableCell className="py-5 text-gray-300 text-[15px] text-center">
                                        {rowExpired ? (
                                            <span className="text-red-400 font-medium">Expired</span>
                                        ) : d.data.expiryTs === 0n ? (
                                            <span className="text-gray-500 text-sm">No expiry</span>
                                        ) : (
                                            <div>
                                                <div>{formatDelegationDateTime(d.data.expiryTs)}</div>
                                                {formatTimeRemaining(d.data.expiryTs, blockTime) && (
                                                    <div className="text-xs text-blue-400/70 mt-0.5">
                                                        {formatTimeRemaining(d.data.expiryTs, blockTime)}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="py-5 text-center">
                                        {isOutgoing ? (
                                            <RevokeDelegationButton delegation={d} />
                                        ) : (
                                            <TransferDelegationButton
                                                delegation={d}
                                                tokenMint={tokenMint}
                                                disabled={rowExpired || isStale}
                                                blockTime={blockTime}
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

function EmptyState({ mode, isExpiredTab }: { mode: TabType; isExpiredTab?: boolean }) {
    const isOutgoing = mode === 'outgoing';

    if (isExpiredTab) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <FileX className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium text-muted-foreground">No expired delegations</h3>
                <p className="text-sm text-muted-foreground/70 mt-1">All your delegations are still active</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileX className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium text-muted-foreground">
                {isOutgoing ? 'No active delegations' : 'No delegations received'}
            </h3>
            <p className="text-sm text-muted-foreground/70 mt-1">
                {isOutgoing
                    ? 'Create your first delegation to get started'
                    : 'No one has delegated active tokens to you yet'}
            </p>
        </div>
    );
}

interface FilterCardProps {
    active: boolean;
    onClick: () => void;
    label: string;
    count: number | string;
    subLabel: string;
    isActiveCard?: boolean;
}

function FilterCard({ active, onClick, label, count, subLabel, isActiveCard = true }: FilterCardProps) {
    const borderColors = active
        ? isActiveCard
            ? 'border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.2)]'
            : 'border-gray-500/50 shadow-[0_0_20px_rgba(107,114,128,0.2)]'
        : 'border-white/5 hover:border-white/10';

    const textGlow = active && isActiveCard ? 'drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]' : '';

    return (
        <button
            onClick={onClick}
            className={`flex flex-col flex-1 p-4 rounded-xl bg-gradient-to-br from-[#1c2136]/80 to-[#121629]/90 backdrop-blur-md border transition-all duration-300 text-left ${borderColors}`}
        >
            <span className="text-sm text-gray-400 mb-1">{label}</span>
            <div className="flex items-baseline gap-1">
                <span className={`text-base sm:text-lg lg:text-xl font-semibold text-white ${textGlow}`}>{count}</span>
                <span className="text-sm font-medium text-white">{subLabel}</span>
            </div>
        </button>
    );
}

function InitPrompt({
    tokenMint,
    onSuccess,
    isReapproval = false,
    subscriptionAuthorityInitId,
    compact = false,
}: {
    tokenMint: string;
    onSuccess?: () => void;
    isReapproval?: boolean;
    subscriptionAuthorityInitId?: bigint | null;
    compact?: boolean;
}) {
    const { account } = useWallet();
    const { initSubscriptionAuthority } = useSubscriptionsMutations();
    const queryClient = useQueryClient();

    const walletAddress = account;
    const { data: tokenAccounts, isLoading: tokenAccountsLoading } = useGetTokenAccountsQuery({
        address: walletAddress ? address(walletAddress) : address('11111111111111111111111111111111'),
    });

    if (!walletAddress) {
        return (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                <ShieldAlert className="h-10 w-10 text-amber-500/60" />
                <div>
                    <p className="text-sm font-medium text-muted-foreground">
                        Connect your wallet to manage delegations
                    </p>
                </div>
            </div>
        );
    }

    const userAta = (tokenAccounts as TokenAccountEntry[] | undefined)?.find(entry => {
        return entry.account?.data?.parsed?.info?.mint === tokenMint;
    });
    const userAtaAddress = userAta?.pubkey ?? null;
    const tokenProgram = userAta?.account?.owner ?? null;

    const handleInitialize = async () => {
        if (!userAtaAddress || !tokenProgram) return;
        await initSubscriptionAuthority.mutateAsync(
            { tokenMint, userAta: userAtaAddress, tokenProgram },
            {
                onSuccess: () => {
                    invalidateWithDelay(queryClient, [['subscriptionAuthorityStatus'], ['get-token-accounts']]);
                    onSuccess?.();
                },
            },
        );
    };

    const hasAta = !!userAtaAddress;

    const containerClass = compact
        ? 'flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20'
        : 'flex flex-col items-center justify-center py-8 text-center space-y-3';
    const iconClass = compact ? 'h-5 w-5 text-amber-500 shrink-0' : 'h-10 w-10 text-amber-500/60';
    const reapprovalText =
        subscriptionAuthorityInitId == null
            ? 'Enabling Delegations reapproves this authority and can reactivate existing grants that match its current delegation ID. Revoke or disable first if you do not want those grants usable.'
            : `Enabling Delegations reapproves this authority and can reactivate existing grants with delegation ID ${subscriptionAuthorityInitId.toString()}. Revoke or disable first if you do not want those grants usable.`;

    return (
        <div className={containerClass}>
            <div className={compact ? 'flex items-start gap-2' : 'flex flex-col items-center gap-3'}>
                <ShieldAlert className={iconClass} />
                <div>
                    <p className="text-sm font-medium text-muted-foreground">
                        {isReapproval ? 'Token approval is off' : 'Approval required to create delegations'}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                        {isReapproval ? reapprovalText : 'One-time setup to enable the delegation program'}
                    </p>
                </div>
            </div>
            {!hasAta && !tokenAccountsLoading && (
                <p className="text-xs text-destructive">No token account found. Get some USDC first.</p>
            )}
            <SolanaButton
                onClick={handleInitialize}
                disabled={initSubscriptionAuthority.isPending || !hasAta || tokenAccountsLoading}
                size="sm"
                loading={initSubscriptionAuthority.isPending}
            >
                {initSubscriptionAuthority.isPending
                    ? 'Initializing...'
                    : tokenAccountsLoading
                      ? 'Loading...'
                      : 'Enable Delegations'}
            </SolanaButton>
        </div>
    );
}

function CloseSubscriptionAuthorityDialog({
    tokenMint,
    payer,
    open,
    onOpenChange,
}: {
    tokenMint: string;
    payer?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { closeSubscriptionAuthority } = useSubscriptionsMutations();
    const outgoing = useDelegations();
    const { data: subscriptions } = useMySubscriptions();
    const { url: rpcUrl } = useClusterConfig();
    const { data: blockTime } = useQuery({
        queryKey: ['blockTime', 'closeDialog', rpcUrl],
        queryFn: () => getBlockTimestamp(rpcUrl),
        enabled: open,
    });
    const [confirmText, setConfirmText] = useState('');

    const activeFixed = outgoing.fixed.filter(d => !isExpired(d.data.expiryTs, blockTime)).length;
    const activeRecurring = outgoing.recurring.filter(d => !isExpired(d.data.expiryTs, blockTime)).length;
    const activeSubscriptions = subscriptions?.filter(s => Number(s.subscription.expiresAtTs) === 0).length ?? 0;
    const totalActive = activeFixed + activeRecurring + activeSubscriptions;
    const hasActive = totalActive > 0;

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) setConfirmText('');
        onOpenChange(nextOpen);
    };

    const handleClose = async () => {
        try {
            await closeSubscriptionAuthority.mutateAsync({ tokenMint, payer: payer ?? undefined });
            handleOpenChange(false);
        } catch {
            // error handled by toast
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="border-red-500/30 bg-slate-950">
                <DialogHeader>
                    <DialogTitle className="text-red-400">Disable Delegations</DialogTitle>
                    <DialogDescription>
                        {hasActive
                            ? 'You have active outgoing delegations. Closing the SubscriptionAuthority account will invalidate them.'
                            : 'Close your SubscriptionAuthority account and return the rent to your wallet.'}
                    </DialogDescription>
                </DialogHeader>
                {hasActive && (
                    <div className="space-y-2 text-sm">
                        <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 space-y-1">
                            {activeFixed > 0 && (
                                <p className="text-amber-400">
                                    {activeFixed} outgoing fixed delegation{activeFixed > 1 ? 's' : ''}
                                </p>
                            )}
                            {activeRecurring > 0 && (
                                <p className="text-amber-400">
                                    {activeRecurring} outgoing recurring delegation{activeRecurring > 1 ? 's' : ''}
                                </p>
                            )}
                            {activeSubscriptions > 0 && (
                                <p className="text-amber-400">
                                    {activeSubscriptions} active subscription{activeSubscriptions > 1 ? 's' : ''}
                                </p>
                            )}
                        </div>
                        <p className="text-gray-400 text-xs">
                            Delegatees will no longer be able to transfer from your outgoing delegations. Incoming
                            delegations from others are not affected. If you re-initialize later, old delegations will
                            remain stale.
                        </p>
                        <div className="space-y-1 pt-2">
                            <label className="text-xs text-gray-400">Type CLOSE to confirm</label>
                            <TextInput
                                value={confirmText}
                                onChange={e => setConfirmText(e.target.value)}
                                placeholder="CLOSE"
                            />
                        </div>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={handleClose}
                        disabled={closeSubscriptionAuthority.isPending || (hasActive && confirmText !== 'CLOSE')}
                    >
                        {closeSubscriptionAuthority.isPending ? 'Closing...' : 'Disable Delegations'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function ActiveDelegations({
    tokenMint,
    isInitialized,
    isApproved,
    subscriptionAuthorityPayer,
    subscriptionAuthorityInitId,
    onInitSuccess,
}: ActiveDelegationsProps) {
    const [activeTab, setActiveTab] = useState<TabType>('outgoing');
    const [outgoingSubTab, setOutgoingSubTab] = useState<OutgoingSubTab>('active');
    const [closeDialogOpen, setCloseDialogOpen] = useState(false);
    const queryClient = useQueryClient();
    const { url: rpcUrl } = useClusterConfig();
    const { data: blockTime } = useQuery({
        queryKey: ['blockTime', rpcUrl],
        queryFn: () => getBlockTimestamp(rpcUrl),
    });

    const outgoing = useDelegations();
    const incoming = useIncomingDelegations();

    const outgoingFiltered = useMemo(() => {
        const active = outgoing.all.filter(d => !isExpired(d.data.expiryTs, blockTime));
        const expired = outgoing.all.filter(d => isExpired(d.data.expiryTs, blockTime));
        return {
            active: {
                all: active,
                fixed: active.filter(d => d.type === 'Fixed'),
                recurring: active.filter(d => d.type === 'Recurring'),
            },
            expired: {
                all: expired,
                fixed: expired.filter(d => d.type === 'Fixed'),
                recurring: expired.filter(d => d.type === 'Recurring'),
            },
        };
    }, [outgoing.all, blockTime]);

    const incomingGrouped = useMemo(() => {
        return {
            all: incoming.all,
            fixed: incoming.all.filter(d => d.type === 'Fixed'),
            recurring: incoming.all.filter(d => d.type === 'Recurring'),
        };
    }, [incoming.all]);

    const staleDelegations = useMemo(() => {
        if (subscriptionAuthorityInitId == null) return [];
        return outgoing.all.filter(d => d.data.header.initId !== subscriptionAuthorityInitId);
    }, [outgoing.all, subscriptionAuthorityInitId]);

    const { revokeMultipleDelegations } = useSubscriptionsMutations();
    const approvalState = getDelegationApprovalState({
        isInitialized,
        isApproved,
        outgoingDelegationCount: outgoing.all.length,
    });

    const handleRevokeAllStale = async () => {
        if (staleDelegations.length === 0) return;
        await revokeMultipleDelegations.mutateAsync({
            delegations: staleDelegations.map(d => ({ address: d.address, payer: d.data.header.payer })),
        });
        onInitSuccess?.();
    };

    const isLoading = activeTab === 'outgoing' ? outgoing.isLoading : incoming.isLoading;
    const isFetching = outgoing.isFetching || incoming.isFetching;
    const [spinning, setSpinning] = useState(false);
    const isRefreshing = isFetching || spinning;

    const handleRefresh = async () => {
        setSpinning(true);
        const minSpin = new Promise(r => setTimeout(r, 600));
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['delegations'] }),
            queryClient.invalidateQueries({ queryKey: ['blockTime'] }),
            minSpin,
        ]);
        setSpinning(false);
    };

    const renderOutgoingContent = () => {
        if (approvalState.shouldShowApprovalPromptAsContent) {
            return <InitPrompt tokenMint={tokenMint} onSuccess={onInitSuccess} />;
        }

        const data = outgoingSubTab === 'active' ? outgoingFiltered.active : outgoingFiltered.expired;
        const isEmpty = data.all.length === 0;
        const showExpired = outgoingSubTab === 'expired';

        if (isEmpty) return <EmptyState mode="outgoing" isExpiredTab={showExpired} />;

        return (
            <div className="space-y-6">
                <FixedDelegationTable
                    delegations={data.fixed}
                    mode="outgoing"
                    showExpired={showExpired}
                    tokenMint={tokenMint}
                    blockTime={blockTime}
                    subscriptionAuthorityInitId={subscriptionAuthorityInitId}
                />
                <RecurringDelegationTable
                    delegations={data.recurring}
                    mode="outgoing"
                    showExpired={showExpired}
                    tokenMint={tokenMint}
                    blockTime={blockTime}
                    subscriptionAuthorityInitId={subscriptionAuthorityInitId}
                />
            </div>
        );
    };

    const renderIncomingContent = () => {
        if (incomingGrouped.all.length === 0) return <EmptyState mode="incoming" />;

        return (
            <div className="space-y-6">
                <FixedDelegationTable
                    delegations={incomingGrouped.fixed}
                    mode="incoming"
                    tokenMint={tokenMint}
                    blockTime={blockTime}
                />
                <RecurringDelegationTable
                    delegations={incomingGrouped.recurring}
                    mode="incoming"
                    tokenMint={tokenMint}
                    blockTime={blockTime}
                />
            </div>
        );
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-end gap-2">
                {staleDelegations.length > 0 && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRevokeAllStale}
                        disabled={revokeMultipleDelegations.isPending}
                        className="text-amber-400 border-amber-500/20 hover:bg-amber-500/10 hover:text-amber-300"
                    >
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        {revokeMultipleDelegations.isPending
                            ? 'Revoking...'
                            : `Revoke ${staleDelegations.length} Stale`}
                    </Button>
                )}
                {approvalState.canCloseSubscriptionAuthority && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCloseDialogOpen(true)}
                        className="text-red-400 border-red-500/20 hover:bg-red-500/10 hover:text-red-300"
                    >
                        <Power className="h-4 w-4 mr-1.5" />
                        Disable
                    </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
                <FilterCard
                    active={activeTab === 'outgoing' && outgoingSubTab === 'active'}
                    onClick={() => {
                        setActiveTab('outgoing');
                        setOutgoingSubTab('active');
                    }}
                    label="My Delegations"
                    count={outgoingFiltered.active.all.length}
                    subLabel="Active"
                />
                <FilterCard
                    active={activeTab === 'incoming'}
                    onClick={() => setActiveTab('incoming')}
                    label="Delegated to Me"
                    count={incomingGrouped.all.length}
                    subLabel="Active"
                />
                <FilterCard
                    active={activeTab === 'outgoing' && outgoingSubTab === 'expired'}
                    onClick={() => {
                        setActiveTab('outgoing');
                        setOutgoingSubTab('expired');
                    }}
                    label="Expired"
                    count={`(${outgoingFiltered.expired.all.length})`}
                    subLabel=""
                    isActiveCard={false}
                />
            </div>

            {activeTab === 'outgoing' && approvalState.shouldShowApprovalRecoveryBanner && (
                <InitPrompt
                    tokenMint={tokenMint}
                    onSuccess={onInitSuccess}
                    isReapproval={isInitialized}
                    subscriptionAuthorityInitId={subscriptionAuthorityInitId}
                    compact
                />
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : activeTab === 'outgoing' ? (
                renderOutgoingContent()
            ) : (
                renderIncomingContent()
            )}

            <div className="flex justify-end">
                <CreateDelegationDialog tokenMint={tokenMint} disabled={!approvalState.canCreateDelegations} />
            </div>
            <CloseSubscriptionAuthorityDialog
                tokenMint={tokenMint}
                payer={subscriptionAuthorityPayer}
                open={closeDialogOpen}
                onOpenChange={setCloseDialogOpen}
            />
        </div>
    );
}
