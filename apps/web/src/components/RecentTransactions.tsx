'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@solana/design-system/badge';
import { Button } from '@solana/design-system/button';
import { useRecentTransactions } from '@/contexts/RecentTransactionsContext';
import { useRpcContext } from '@/contexts/RpcContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getClusterFromRpcUrl, getSolanaExplorerUrl } from '@/lib/explorer';

function truncate(value: string, start = 6, end = 6) {
    if (value.length <= start + end + 3) return value;
    return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function RecentTransactions() {
    const { recentTransactions, clearRecentTransactions } = useRecentTransactions();
    const { rememberDelegatee, rememberSubscriptionAuthority, rememberDelegation, rememberMint, rememberPlan } = useSavedValues();
    const { rpcUrl } = useRpcContext();
    const [collapsed, setCollapsed] = useState(false);

    const cluster = useMemo(() => getClusterFromRpcUrl(rpcUrl), [rpcUrl]);

    if (recentTransactions.length === 0) return null;

    return (
        <section style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginBottom: 24, background: 'var(--color-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 style={{ fontSize: '0.9375rem', fontWeight: 600 }}>
                    Recent Transactions ({recentTransactions.length})
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setCollapsed(v => !v)}>
                        {collapsed ? 'Expand' : 'Collapse'}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={clearRecentTransactions}>Clear</Button>
                </div>
            </div>
            {!collapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {recentTransactions.map(tx => {
                        const explorerUrl = tx.signature ? getSolanaExplorerUrl(tx.signature, cluster) : null;
                        return (
                            <div key={tx.id} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                    <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{tx.action}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Badge variant={tx.status === 'failed' ? 'danger' : 'success'}>{tx.status}</Badge>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                                            {new Date(tx.timestamp).toLocaleString()}
                                        </span>
                                    </div>
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                                    Signature: <span style={{ color: 'var(--color-text)' }}>{tx.signature ? truncate(tx.signature, 10, 10) : 'Unavailable'}</span>
                                </div>
                                {tx.error && <div style={{ fontSize: '0.75rem', color: 'var(--color-error)', wordBreak: 'break-word' }}>Error: {tx.error}</div>}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    {explorerUrl && (
                                        <Button asChild size="sm" variant="secondary">
                                            <a href={explorerUrl} target="_blank" rel="noopener noreferrer">View Explorer</a>
                                        </Button>
                                    )}
                                    {tx.values && (
                                        <Button type="button" size="sm" variant="secondary" onClick={() => {
                                            if (!tx.values) return;
                                            if (tx.values.delegatee) rememberDelegatee(tx.values.delegatee);
                                            if (tx.values.subscriptionAuthority) rememberSubscriptionAuthority(tx.values.subscriptionAuthority);
                                            if (tx.values.delegationPda) rememberDelegation(tx.values.delegationPda);
                                            if (tx.values.mint) rememberMint(tx.values.mint);
                                            if (tx.values.planPda) rememberPlan(tx.values.planPda);
                                        }}>
                                            Save to Defaults
                                        </Button>
                                    )}
                                </div>
                                {tx.values && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                        {Object.entries(tx.values).map(([key, value]) => (
                                            <span key={`${tx.id}-${key}`} style={{ fontSize: '0.6875rem', color: 'var(--color-muted)', border: '1px solid var(--color-border)', borderRadius: 999, padding: '2px 8px' }}>
                                                {key}: {truncate(typeof value === 'string' ? value : '', 8, 8)}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
