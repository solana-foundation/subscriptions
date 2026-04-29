import { useWalletUi } from '@wallet-ui/react';
import { address } from '@solana/kit';
import type { Address, Lamports } from '@solana/kit';

const lamportsToSol = (lamports: bigint | number): number => Number(lamports) / 1e9;
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { AppAlert } from '@/components/app-alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Wallet, DollarSign, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { TokenAccountEntry } from '@/lib/types';
import { useGetBalanceQuery, useGetTokenAccountsQuery, useAirdropSol, useAirdropUsdc } from './account-data-access';
import { useDelegations, useIncomingDelegations } from '@/hooks/use-delegations';
import { useUsdcMint, useUsdcMintRaw } from '@/hooks/use-token-config';
import { useSubscriptionAuthorityStatus } from '@/hooks/use-subscription-authority-status';
import { USDC_MULTIPLIER, recurringAvailable } from '@/lib/utils';
import { getBlockTimestamp } from '@/hooks/use-time-travel';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';

export function AccountChecker() {
    const { account } = useWalletUi();
    if (!account) {
        return null;
    }
    return <AccountBalanceCheck address={address(account.address)} />;
}

export function AccountBalanceCheck({ address: addr }: { address: Address }) {
    const { cluster } = useWalletUi();
    const query = useGetBalanceQuery({ address: addr });

    if (query.isLoading) {
        return null;
    }
    if (query.isError || !query.data?.value) {
        if (cluster.id !== 'solana:localnet' && cluster.id !== 'solana:devnet') return null;
        return (
            <AppAlert
                action={
                    <Button variant="outline" asChild>
                        <Link to="/faucet">Request Airdrop</Link>
                    </Button>
                }
            >
                You are connected to <strong>{cluster.label}</strong> but your account is not found on this cluster.
            </AppAlert>
        );
    }
    return null;
}

export function AccountBalance({ address: addr }: { address: Address }) {
    const query = useGetBalanceQuery({ address: addr });

    return (
        <h1 className="text-5xl font-bold cursor-pointer" onClick={() => query.refetch()}>
            {query.data?.value ? <BalanceSol balance={query.data?.value} /> : '...'} SOL
        </h1>
    );
}

export function WalletBalanceCards({ address: addr }: { address: Address }) {
    const solQuery = useGetBalanceQuery({ address: addr });
    const tokenQuery = useGetTokenAccountsQuery({ address: addr });
    const { url: rpcUrl } = useClusterConfig();
    const usdcMint = useUsdcMint();
    const progAddr = useProgramAddress();
    const outgoing = useDelegations();
    const incoming = useIncomingDelegations();
    const [blockTime, setBlockTime] = useState<number | undefined>();

    useEffect(() => {
        getBlockTimestamp(rpcUrl)
            .then(setBlockTime)
            .catch(e => {
                console.warn('[WalletBalanceCards] Failed to fetch block timestamp:', e);
            });
    }, [rpcUrl, incoming.all]);

    const reservedAmount = useMemo(() => {
        let total = 0;
        for (const d of outgoing.fixed) total += Number(d.data.amount) / USDC_MULTIPLIER;
        for (const d of outgoing.recurring) total += Number(d.data.amountPerPeriod) / USDC_MULTIPLIER;
        return total;
    }, [outgoing.fixed, outgoing.recurring]);

    const incomingAmount = useMemo(() => {
        let total = 0;
        for (const d of incoming.all) {
            if (d.type === 'Fixed') {
                total += Number(d.data.amount) / USDC_MULTIPLIER;
            } else {
                total +=
                    Number(
                        recurringAvailable(
                            d.data.amountPerPeriod,
                            d.data.amountPulledInPeriod,
                            d.data.currentPeriodStartTs,
                            d.data.periodLengthS,
                            blockTime,
                        ),
                    ) / USDC_MULTIPLIER;
            }
        }
        return total;
    }, [incoming.all, blockTime]);

    const usdcAccount = useMemo(() => {
        return (tokenQuery.data as TokenAccountEntry[] | undefined)?.find(entry => {
            return entry.account?.data?.parsed?.info?.mint === usdcMint;
        });
    }, [tokenQuery.data, usdcMint]);

    const usdcBalance = usdcAccount?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;

    const { mint: usdcMintRaw } = useUsdcMintRaw();
    const { data: statusData } = useSubscriptionAuthorityStatus(usdcMintRaw);
    const delegationId = statusData?.data?.initId ?? null;

    const [spinning, setSpinning] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const isFetching = solQuery.isFetching || tokenQuery.isFetching;
    const isRefreshing = isFetching || spinning;

    const handleRefresh = async () => {
        setSpinning(true);
        const minSpin = new Promise(r => setTimeout(r, 600));
        await Promise.all([solQuery.refetch(), tokenQuery.refetch(), minSpin]);
        setSpinning(false);
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <h2 className="text-[28px] font-bold tracking-tight text-white">Wallet Overview</h2>
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                        <span>Program:</span>
                        <span className="font-mono text-gray-400">
                            {progAddr ? `${progAddr.slice(0, 8)}...${progAddr.slice(-4)}` : '...'}
                        </span>
                        <button
                            onClick={() => {
                                if (progAddr) navigator.clipboard.writeText(progAddr);
                                setCopiedField('program');
                                setTimeout(() => setCopiedField(null), 1500);
                            }}
                            className="text-gray-600 hover:text-gray-300 transition-colors"
                        >
                            {copiedField === 'program' ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                                <Copy className="h-3 w-3" />
                            )}
                        </button>
                    </div>
                    {delegationId != null && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <span>Delegation ID:</span>
                            <span className="text-gray-400">{delegationId.toString()}</span>
                        </div>
                    )}
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="rounded-full bg-white/5 border-white/10 hover:bg-white/10 text-white"
                >
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card className="relative overflow-hidden border border-purple-500/30 bg-gradient-to-br from-purple-900/40 to-black/60 backdrop-blur-xl shadow-[0_0_30px_rgba(168,85,247,0.15)] rounded-2xl">
                    <CardHeader className="relative pb-2">
                        <CardTitle className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-300">Solana Balance</span>
                            <div className="p-2 bg-purple-500/20 rounded-lg">
                                <Wallet className="h-5 w-5 text-purple-400" />
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="relative pt-4">
                        <div className="space-y-1">
                            <div className="text-xl sm:text-3xl lg:text-[40px] leading-tight font-bold tracking-tight text-purple-300">
                                {solQuery.data?.value ? (
                                    <span className="drop-shadow-[0_0_10px_rgba(168,85,247,0.5)]">
                                        {Number(lamportsToSol(solQuery.data.value)).toFixed(4)}
                                    </span>
                                ) : (
                                    <span className="text-muted-foreground">...</span>
                                )}
                            </div>
                            <div className="text-sm font-medium text-gray-500 tracking-wide">SOL</div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="relative overflow-hidden border border-emerald-500/30 bg-gradient-to-br from-emerald-900/40 to-black/60 backdrop-blur-xl shadow-[0_0_30px_rgba(16,185,129,0.15)] rounded-2xl">
                    <CardHeader className="relative pb-2">
                        <CardTitle className="flex items-center justify-between">
                            <div>
                                <span className="text-sm font-medium text-gray-300">USDC Balance</span>
                                {usdcMint && (
                                    <p className="flex items-center gap-1 text-[10px] font-mono text-gray-600 mt-0.5">
                                        {usdcMint.slice(0, 8)}...{usdcMint.slice(-4)}
                                        <button
                                            onClick={e => {
                                                e.stopPropagation();
                                                navigator.clipboard.writeText(usdcMint);
                                                setCopiedField('usdc');
                                                setTimeout(() => setCopiedField(null), 1500);
                                            }}
                                            className="text-gray-600 hover:text-gray-300 transition-colors"
                                        >
                                            {copiedField === 'usdc' ? (
                                                <Check className="h-2.5 w-2.5 text-emerald-400" />
                                            ) : (
                                                <Copy className="h-2.5 w-2.5" />
                                            )}
                                        </button>
                                    </p>
                                )}
                            </div>
                            <div className="p-2 bg-emerald-500/20 rounded-lg">
                                <DollarSign className="h-5 w-5 text-emerald-400" />
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="relative pt-4">
                        <div className="space-y-3">
                            {tokenQuery.isLoading ? (
                                <div className="text-lg sm:text-2xl lg:text-[36px] leading-tight font-bold text-muted-foreground">
                                    ...
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="min-w-0">
                                        <div className="text-lg sm:text-2xl lg:text-[36px] leading-tight font-bold tracking-tight text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]">
                                            {usdcBalance.toLocaleString(undefined, {
                                                minimumFractionDigits: 2,
                                                maximumFractionDigits: 2,
                                            })}
                                        </div>
                                        <div className="text-sm font-medium text-gray-500 tracking-wide">Wallet</div>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-lg sm:text-2xl lg:text-[36px] leading-tight font-bold tracking-tight text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]">
                                            {(usdcBalance - reservedAmount + incomingAmount).toLocaleString(undefined, {
                                                minimumFractionDigits: 2,
                                                maximumFractionDigits: 2,
                                            })}
                                        </div>
                                        <div className="text-sm font-medium text-gray-500 tracking-wide">Spendable</div>
                                        {(reservedAmount > 0 || incomingAmount > 0) && (
                                            <div className="text-xs text-gray-600">incl. delegations</div>
                                        )}
                                    </div>
                                </div>
                            )}
                            {(reservedAmount > 0 || incomingAmount > 0) && (
                                <div className="flex items-center gap-3 text-sm flex-wrap">
                                    {reservedAmount > 0 && (
                                        <span className="text-amber-400/80">
                                            {reservedAmount.toLocaleString(undefined, {
                                                minimumFractionDigits: 2,
                                                maximumFractionDigits: 2,
                                            })}{' '}
                                            delegated
                                        </span>
                                    )}
                                    {reservedAmount > 0 && incomingAmount > 0 && (
                                        <span className="text-gray-600">|</span>
                                    )}
                                    {incomingAmount > 0 && (
                                        <span className="text-emerald-400/80">
                                            {incomingAmount.toLocaleString(undefined, {
                                                minimumFractionDigits: 2,
                                                maximumFractionDigits: 2,
                                            })}{' '}
                                            from delegations
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function SolFaucetCard() {
    const [amount, setAmount] = useState('1');
    const { cluster } = useWalletUi();
    const isDevnet = cluster.id === 'solana:devnet';
    const airdrop = useAirdropSol();

    const handleAirdrop = async () => {
        const val = parseFloat(amount);
        if (!amount || !Number.isFinite(val) || val <= 0) {
            toast.error('Please enter a valid SOL amount');
            return;
        }
        if (isDevnet && val > 2) {
            toast.error('Devnet limits airdrops to 2 SOL per request');
            return;
        }
        await airdrop.mutateAsync(val);
    };

    return (
        <Card
            className={`relative overflow-hidden border bg-gradient-to-br transition-all duration-300 ${isDevnet ? 'border-gray-500/20 from-gray-950/40 via-gray-900/20 to-transparent opacity-60' : 'border-purple-500/20 from-purple-950/40 via-purple-900/20 to-transparent hover:border-purple-500/40'}`}
        >
            <CardHeader className="relative pb-2">
                <CardTitle className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-400">SOL Airdrop</span>
                    <Wallet className={`h-5 w-5 ${isDevnet ? 'text-gray-500' : 'text-purple-400'}`} />
                </CardTitle>
            </CardHeader>
            <CardContent className="relative space-y-4">
                {isDevnet ? (
                    <p className="text-sm text-gray-500 py-4">
                        SOL airdrop is not available on devnet. Use{' '}
                        <a
                            href="https://faucet.solana.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline"
                        >
                            faucet.solana.com
                        </a>{' '}
                        instead.
                    </p>
                ) : (
                    <>
                        <Input
                            type="number"
                            placeholder="0"
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                            min="0.1"
                            step="0.1"
                            className="text-3xl font-bold h-14 border-purple-500/20 focus-visible:ring-purple-500/40"
                        />
                        <div className="flex flex-wrap gap-2">
                            {[1, 2, 5, 10].map(v => (
                                <Button
                                    key={v}
                                    variant="outline"
                                    size="sm"
                                    className="rounded-full text-xs border-purple-500/30 hover:bg-purple-500/10"
                                    onClick={() => setAmount(String(v))}
                                >
                                    {v} SOL
                                </Button>
                            ))}
                        </div>
                        <Button
                            onClick={handleAirdrop}
                            disabled={airdrop.isPending}
                            className="w-full rounded-full bg-purple-600 hover:bg-purple-500 text-white"
                        >
                            {airdrop.isPending ? 'Requesting...' : 'Request Airdrop'}
                        </Button>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

export function UsdcFaucetCard() {
    const [amount, setAmount] = useState('1000');
    const [recipient, setRecipient] = useState('');
    const { cluster, account } = useWalletUi();
    const isDevnet = cluster.id === 'solana:devnet';
    const airdrop = useAirdropUsdc();

    const handleAirdrop = async () => {
        const val = parseFloat(amount);
        if (!amount || !Number.isFinite(val) || val <= 0) {
            toast.error('Please enter a valid USDC amount');
            return;
        }
        await airdrop.mutateAsync({
            amount: val,
            recipient: isDevnet && recipient ? recipient : undefined,
        });
    };

    return (
        <Card className="relative overflow-hidden border border-green-500/20 bg-gradient-to-br from-green-950/40 via-green-900/20 to-transparent hover:border-green-500/40 transition-all duration-300">
            <CardHeader className="relative pb-2">
                <CardTitle className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-400">USDC {isDevnet ? 'Mint' : 'Airdrop'}</span>
                    <DollarSign className="h-5 w-5 text-green-400" />
                </CardTitle>
            </CardHeader>
            <CardContent className="relative space-y-4">
                <Input
                    type="number"
                    placeholder="0"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    min="1"
                    step="100"
                    className="text-3xl font-bold h-14 border-green-500/20 focus-visible:ring-green-500/40"
                />
                {isDevnet && (
                    <Input
                        type="text"
                        placeholder={account?.address ?? 'Recipient address (leave empty for self)'}
                        value={recipient}
                        onChange={e => setRecipient(e.target.value)}
                        className="font-mono text-xs h-10 border-green-500/20 focus-visible:ring-green-500/40"
                    />
                )}
                <div className="flex flex-wrap gap-2">
                    {[100, 1000, 5000, 10000].map(v => (
                        <Button
                            key={v}
                            variant="outline"
                            size="sm"
                            className="rounded-full text-xs border-green-500/30 hover:bg-green-500/10"
                            onClick={() => setAmount(String(v))}
                        >
                            {v.toLocaleString()}
                        </Button>
                    ))}
                </div>
                {isDevnet && <p className="text-xs text-gray-500">Mint authority wallet required</p>}
                <Button
                    onClick={handleAirdrop}
                    disabled={airdrop.isPending}
                    className="w-full rounded-full bg-green-600 hover:bg-green-500 text-white"
                >
                    {airdrop.isPending ? 'Requesting...' : isDevnet ? 'Mint USDC' : 'Request Airdrop'}
                </Button>
            </CardContent>
        </Card>
    );
}

function BalanceSol({ balance }: { balance: Lamports }) {
    return <span>{lamportsToSol(balance)}</span>;
}
