'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildDeletePlan } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function DeletePlan() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultPlan } = useSavedValues();

    const [planPda, setPlanPda] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions } = buildDeletePlan({
            owner: signer, planPda: planPda.trim() as Address, programAddress: getProgramAddress(),
        });

        await send(instructions, { action: 'DeletePlan', values: { planPda: planPda.trim() } });
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Plan PDA" value={planPda} onChange={setPlanPda}
                autoFillValue={defaultPlan} onAutoFill={setPlanPda}
                placeholder="Plan account address" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
