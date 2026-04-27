'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { formatTransactionError } from '@/lib/transactionErrors';

const STORAGE_KEY = 'subscriptions-ui-recent-transactions-v1';
const MAX_RECENT_TRANSACTIONS = 20;

export interface RecentTransactionValues {
    delegatee?: string;
    subscriptionAuthority?: string;
    delegationPda?: string;
    mint?: string;
    planPda?: string;
    subscriptionPda?: string;
    amount?: string;
}

export interface RecentTransaction {
    id: string;
    signature: string | null;
    action: string;
    timestamp: number;
    status: 'success' | 'failed';
    error?: string;
    values?: RecentTransactionValues;
}

interface RecentTransactionsContextType {
    recentTransactions: RecentTransaction[];
    addRecentTransaction: (transaction: RecentTransaction) => void;
    clearRecentTransactions: () => void;
}

const RecentTransactionsContext = createContext<RecentTransactionsContextType | null>(null);

function normalizeValues(values?: RecentTransactionValues): RecentTransactionValues | undefined {
    if (!values) return undefined;
    const entries = Object.entries(values as Record<string, string | undefined>)
        .map(([k, v]) => [k, v?.trim() ?? ''] as const)
        .filter(([, v]) => v.length > 0);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries) as RecentTransactionValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readStoredTransactions(): RecentTransaction[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(isRecord)
            .map(item => {
                const fallbackId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                return {
                    id: typeof item.id === 'string' ? item.id : fallbackId,
                    signature: typeof item.signature === 'string' ? item.signature : null,
                    action: typeof item.action === 'string' ? item.action : 'Transaction',
                    timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
                    status: item.status === 'failed' ? ('failed' as const) : ('success' as const),
                    error: typeof item.error === 'string' ? item.error : undefined,
                    values: isRecord(item.values) ? normalizeValues(item.values as RecentTransactionValues) : undefined,
                };
            })
            .slice(0, MAX_RECENT_TRANSACTIONS);
    } catch {
        return [];
    }
}

export function RecentTransactionsProvider({ children }: { children: React.ReactNode }) {
    const [recentTransactions, setRecentTransactions] = useState<RecentTransaction[]>([]);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        setRecentTransactions(readStoredTransactions());
        setHydrated(true);
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recentTransactions));
    }, [hydrated, recentTransactions]);

    const addRecentTransaction = useCallback((transaction: RecentTransaction) => {
        setRecentTransactions(current => {
            const normalized: RecentTransaction = {
                ...transaction,
                id: transaction.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                signature: transaction.signature?.trim() || null,
                action: transaction.action.trim() || 'Transaction',
                error: transaction.error?.trim() ? formatTransactionError(transaction.error) : undefined,
                values: normalizeValues(transaction.values),
            };
            const deduped = current.filter(item =>
                normalized.signature ? item.signature !== normalized.signature : item.id !== normalized.id,
            );
            return [normalized, ...deduped].slice(0, MAX_RECENT_TRANSACTIONS);
        });
    }, []);

    const clearRecentTransactions = useCallback(() => setRecentTransactions([]), []);

    const value = useMemo(
        () => ({ recentTransactions, addRecentTransaction, clearRecentTransactions }),
        [recentTransactions, addRecentTransaction, clearRecentTransactions],
    );

    return <RecentTransactionsContext.Provider value={value}>{children}</RecentTransactionsContext.Provider>;
}

export function useRecentTransactions() {
    const ctx = useContext(RecentTransactionsContext);
    if (!ctx) throw new Error('useRecentTransactions must be used inside RecentTransactionsProvider');
    return ctx;
}
