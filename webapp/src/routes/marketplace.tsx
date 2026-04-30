import { useState, useCallback, useEffect, useRef } from 'react';
import { Store, Search, Loader2, X, Clock } from 'lucide-react';
import { useWallet } from '@solana/connector/react';
import { Button, TextInput } from '@solana/design-system';
import { Card, CardContent } from '@/components/ui/card';
import { PlanCard } from '@/components/plan/plan-card';
import { useMerchantPlans } from '@/hooks/use-plans';
import { ellipsify } from '@/lib/utils';

const STORAGE_KEY = 'marketplace-recent';
const MAX_RECENT = 5;

type RecentEntry = { address: string; label?: string; ts: number };

function loadRecent(): RecentEntry[] {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveRecent(entries: RecentEntry[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
}

function addRecent(address: string, label?: string) {
    const entries = loadRecent().filter(e => e.address !== address);
    entries.unshift({ address, label, ts: Date.now() });
    saveRecent(entries);
}

function removeRecent(address: string) {
    saveRecent(loadRecent().filter(e => e.address !== address));
}

const MERCHANT_CACHE_KEY = 'marketplace-merchant';

function MarketplaceConnected() {
    const [inputValue, setInputValue] = useState(() => sessionStorage.getItem(MERCHANT_CACHE_KEY) ?? '');
    const [searchAddress, setSearchAddress] = useState<string | null>(() => sessionStorage.getItem(MERCHANT_CACHE_KEY));
    const [showRecent, setShowRecent] = useState(false);
    const [recent, setRecent] = useState<RecentEntry[]>(loadRecent);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const { data: plans, isLoading, isError } = useMerchantPlans(searchAddress);

    useEffect(() => {
        if (!plans || plans.length === 0 || !searchAddress) return;
        const label = plans
            .map(p => {
                try {
                    return JSON.parse(p.data.metadataUri)?.n;
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .join(', ');
        addRecent(searchAddress, label || undefined);
    }, [plans, searchAddress]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowRecent(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const refreshRecent = useCallback(() => {
        setRecent(loadRecent());
    }, []);

    const handleSearch = useCallback(() => {
        const trimmed = inputValue.trim();
        if (trimmed.length > 0 && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
            setSearchAddress(null);
            setShowRecent(false);
            return;
        }
        const addr = trimmed.length > 0 ? trimmed : null;
        if (addr) sessionStorage.setItem(MERCHANT_CACHE_KEY, addr);
        else sessionStorage.removeItem(MERCHANT_CACHE_KEY);
        setSearchAddress(addr);
        setShowRecent(false);
    }, [inputValue]);

    const handleSelectRecent = (address: string) => {
        setInputValue(address);
        sessionStorage.setItem(MERCHANT_CACHE_KEY, address);
        setSearchAddress(address);
        setShowRecent(false);
    };

    const handleRemoveRecent = (e: React.MouseEvent, address: string) => {
        e.stopPropagation();
        removeRecent(address);
        refreshRecent();
    };

    const hasSearched = searchAddress !== null;
    const hasResults = plans && plans.length > 0;

    return (
        <div className="space-y-6">
            <div className="relative" ref={dropdownRef}>
                <div className="flex gap-2">
                    <TextInput
                        value={inputValue}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputValue(e.target.value)}
                        onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && handleSearch()}
                        onFocus={() => {
                            refreshRecent();
                            const r = loadRecent();
                            if (r.length > 0) setShowRecent(true);
                        }}
                        placeholder="Enter merchant wallet address"
                        className="min-w-0 flex-1"
                        inputClassName="font-mono"
                        size="lg"
                    />
                    <Button
                        iconLeft={isLoading ? <Loader2 className="animate-spin" /> : <Search />}
                        onClick={handleSearch}
                        disabled={isLoading}
                        variant="secondary"
                        size="lg"
                        className="shrink-0"
                    >
                        Search
                    </Button>
                </div>
                {showRecent && recent.length > 0 && (
                    <div className="absolute z-50 top-full mt-1 w-full rounded-md border border-emerald-500/20 bg-slate-950 shadow-lg overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-emerald-500/10">
                            <span className="text-xs text-muted-foreground">Recent searches</span>
                            <button
                                onClick={() => {
                                    localStorage.removeItem(STORAGE_KEY);
                                    refreshRecent();
                                    setShowRecent(false);
                                }}
                                className="text-xs text-muted-foreground hover:text-red-400 transition-colors"
                            >
                                Clear all
                            </button>
                        </div>
                        {recent.map(entry => (
                            <button
                                key={entry.address}
                                onClick={() => handleSelectRecent(entry.address)}
                                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-emerald-500/10 transition-colors group"
                            >
                                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="font-mono text-sm text-emerald-400 truncate">
                                    {ellipsify(entry.address, 8)}
                                </span>
                                <X
                                    className="h-3.5 w-3.5 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 shrink-0 transition-opacity"
                                    onClick={e => handleRemoveRecent(e, entry.address)}
                                />
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {isLoading && (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
                </div>
            )}

            {isError && (
                <Card className="border-destructive/20">
                    <CardContent className="flex flex-col items-center justify-center py-8 gap-2">
                        <p className="text-destructive">Failed to fetch plans. Check the address and try again.</p>
                    </CardContent>
                </Card>
            )}

            {!isLoading && hasSearched && !isError && !hasResults && (
                <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2">
                        <Search className="h-8 w-8 text-muted-foreground" />
                        <p className="text-muted-foreground">No plans found for this merchant.</p>
                    </CardContent>
                </Card>
            )}

            {hasResults && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {plans.map((plan, i) => (
                        <div
                            key={plan.address}
                            className="animate-[fadeInUp_0.3s_ease-out_both]"
                            style={{ animationDelay: `${i * 80}ms` }}
                        >
                            <PlanCard plan={plan} variant="marketplace" />
                        </div>
                    ))}
                </div>
            )}

            {!hasSearched && !isLoading && (
                <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent">
                    <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                        <Store className="h-12 w-12 text-emerald-400" />
                        <h2 className="text-xl font-semibold">Subscription Plans</h2>
                        <p className="text-muted-foreground text-center max-w-md">
                            Search for a merchant address to browse their subscription plans.
                        </p>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export function Marketplace() {
    const { account } = useWallet();

    if (!account) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Connect your wallet to get started</h1>
                <p className="text-muted-foreground">Create and manage subscription plans on Solana.</p>
            </div>
        );
    }

    return <MarketplaceConnected />;
}
