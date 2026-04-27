'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildCancelSubscription } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function CancelSubscription() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultPlan, defaultSubscription } = useSavedValues();

    const [planPda, setPlanPda] = useState('');
    const [subscriptionPda, setSubscriptionPda] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions } = await buildCancelSubscription({
            subscriber: signer, planPda: planPda.trim() as Address,
            subscriptionPda: subscriptionPda.trim() as Address,
            programAddress: getProgramAddress(),
        });

        await send(instructions, {
            action: 'CancelSubscription',
            values: { planPda: planPda.trim(), subscriptionPda: subscriptionPda.trim() },
        });
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Plan PDA" value={planPda} onChange={setPlanPda}
                autoFillValue={defaultPlan} onAutoFill={setPlanPda}
                placeholder="Plan account address" required />
            <FormField label="Subscription PDA" value={subscriptionPda} onChange={setSubscriptionPda}
                autoFillValue={defaultSubscription} onAutoFill={setSubscriptionPda}
                placeholder="Subscription account address" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
