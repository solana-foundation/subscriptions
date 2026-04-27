'use client';

import { useState } from 'react';
import { Button } from '@solana/design-system/button';
import { QuickDefaults } from '@/components/QuickDefaults';
import { RecentTransactions } from '@/components/RecentTransactions';
import { ProgramBadge } from '@/components/ProgramBadge';
import { RpcBadge } from '@/components/RpcBadge';
import { WalletButton } from '@/components/WalletButton';
import { InitSubscriptionAuthority } from '@/instructions/InitSubscriptionAuthority';
import { CloseSubscriptionAuthority } from '@/instructions/CloseSubscriptionAuthority';
import { CreateFixedDelegation } from '@/instructions/CreateFixedDelegation';
import { CreateRecurringDelegation } from '@/instructions/CreateRecurringDelegation';
import { RevokeDelegation } from '@/instructions/RevokeDelegation';
import { TransferFixed } from '@/instructions/TransferFixed';
import { TransferRecurring } from '@/instructions/TransferRecurring';
import { CreatePlan } from '@/instructions/CreatePlan';
import { UpdatePlan } from '@/instructions/UpdatePlan';
import { DeletePlan } from '@/instructions/DeletePlan';
import { Subscribe } from '@/instructions/Subscribe';
import { CancelSubscription } from '@/instructions/CancelSubscription';
import { TransferSubscription } from '@/instructions/TransferSubscription';

type InstructionId =
    | 'initSubscriptionAuthority' | 'closeSubscriptionAuthority'
    | 'createFixedDelegation' | 'createRecurringDelegation' | 'revokeDelegation'
    | 'transferFixed' | 'transferRecurring'
    | 'createPlan' | 'updatePlan' | 'deletePlan'
    | 'subscribe' | 'cancelSubscription' | 'transferSubscription';

const NAV: { group: string; items: { id: InstructionId; label: string }[] }[] = [
    {
        group: 'DELEGATE',
        items: [
            { id: 'initSubscriptionAuthority', label: 'Init Subscription Authority' },
            { id: 'closeSubscriptionAuthority', label: 'Close Subscription Authority' },
            { id: 'createFixedDelegation', label: 'Create Fixed Delegation' },
            { id: 'createRecurringDelegation', label: 'Create Recurring Delegation' },
            { id: 'revokeDelegation', label: 'Revoke Delegation' },
            { id: 'transferFixed', label: 'Transfer (Fixed)' },
            { id: 'transferRecurring', label: 'Transfer (Recurring)' },
        ],
    },
    {
        group: 'PLANS',
        items: [
            { id: 'createPlan', label: 'Create Plan' },
            { id: 'updatePlan', label: 'Update Plan' },
            { id: 'deletePlan', label: 'Delete Plan' },
        ],
    },
    {
        group: 'SUBSCRIPTIONS',
        items: [
            { id: 'subscribe', label: 'Subscribe' },
            { id: 'cancelSubscription', label: 'Cancel Subscription' },
            { id: 'transferSubscription', label: 'Transfer Subscription' },
        ],
    },
];

const PANELS: Record<InstructionId, { title: string; component: React.ComponentType }> = {
    initSubscriptionAuthority: { title: 'Init Subscription Authority', component: InitSubscriptionAuthority },
    closeSubscriptionAuthority: { title: 'Close Subscription Authority', component: CloseSubscriptionAuthority },
    createFixedDelegation: { title: 'Create Fixed Delegation', component: CreateFixedDelegation },
    createRecurringDelegation: { title: 'Create Recurring Delegation', component: CreateRecurringDelegation },
    revokeDelegation: { title: 'Revoke Delegation', component: RevokeDelegation },
    transferFixed: { title: 'Transfer (Fixed)', component: TransferFixed },
    transferRecurring: { title: 'Transfer (Recurring)', component: TransferRecurring },
    createPlan: { title: 'Create Plan', component: CreatePlan },
    updatePlan: { title: 'Update Plan', component: UpdatePlan },
    deletePlan: { title: 'Delete Plan', component: DeletePlan },
    subscribe: { title: 'Subscribe', component: Subscribe },
    cancelSubscription: { title: 'Cancel Subscription', component: CancelSubscription },
    transferSubscription: { title: 'Transfer Subscription', component: TransferSubscription },
};

export default function HomePage() {
    const [active, setActive] = useState<InstructionId>('initSubscriptionAuthority');
    const panel = PANELS[active];
    const Panel = panel.component;

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <header style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 24px', borderBottom: '1px solid var(--color-border)',
                background: 'var(--color-card)', position: 'sticky', top: 0, zIndex: 10,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--color-accent)' }}>
                        Subscriptions
                    </span>
                    <RpcBadge />
                    <ProgramBadge />
                </div>
                <WalletButton />
            </header>

            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                <nav style={{
                    width: 230, borderRight: '1px solid var(--color-border)',
                    padding: '16px 0', flexShrink: 0, overflowY: 'auto',
                }}>
                    {NAV.map(({ group, items }) => (
                        <div key={group} style={{ marginBottom: 24 }}>
                            <div style={{
                                fontSize: '0.6875rem', fontWeight: 700, color: 'var(--color-muted)',
                                letterSpacing: '0.08em', padding: '0 16px', marginBottom: 6,
                            }}>
                                {group}
                            </div>
                            {items.map(item => (
                                <Button key={item.id} onClick={() => setActive(item.id)}
                                    variant={active === item.id ? 'primary' : 'secondary'} size="sm"
                                    style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 0 }}>
                                    {item.label}
                                </Button>
                            ))}
                        </div>
                    ))}
                </nav>

                <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
                    <QuickDefaults />
                    <RecentTransactions />
                    <h2 style={{
                        fontSize: '1.125rem', fontWeight: 600, marginBottom: 24,
                        paddingBottom: 16, borderBottom: '1px solid var(--color-border)',
                    }}>
                        {panel.title}
                    </h2>
                    <div style={{ maxWidth: 620 }}>
                        <Panel />
                    </div>
                </main>
            </div>
        </div>
    );
}
