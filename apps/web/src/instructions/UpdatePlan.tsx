'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { getUpdatePlanOverlayInstruction, PlanStatus } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SelectField, SendButton, TxResultDisplay } from './shared';

export function UpdatePlan() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultPlan } = useSavedValues();

    const [planPda, setPlanPda] = useState('');
    const [statusKey, setStatusKey] = useState<'Active' | 'Sunset'>('Active');
    const [endTs, setEndTs] = useState('0');
    const [metadataUri, setMetadataUri] = useState('');
    const [pullers, setPullers] = useState('');

    function parseAddressList(raw: string): Address[] {
        return raw.split(',').map(s => s.trim()).filter(Boolean) as Address[];
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const instruction = getUpdatePlanOverlayInstruction({
            owner: signer, planPda: planPda.trim() as Address,
            status: statusKey === 'Active' ? PlanStatus.Active : PlanStatus.Sunset,
            endTs: BigInt(endTs), metadataUri: metadataUri.trim(),
            pullers: parseAddressList(pullers), programAddress: getProgramAddress(),
        });

        await send([instruction], { action: 'UpdatePlan', values: { planPda: planPda.trim() } });
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Plan PDA" value={planPda} onChange={setPlanPda}
                autoFillValue={defaultPlan} onAutoFill={setPlanPda}
                placeholder="Plan account address" required />
            <SelectField label="Status" value={statusKey}
                onChange={v => setStatusKey(v as 'Active' | 'Sunset')}
                options={[{ label: 'Active', value: 'Active' }, { label: 'Sunset', value: 'Sunset' }]} />
            <FormField label="End Timestamp" value={endTs} onChange={setEndTs} type="number"
                hint="Unix timestamp (0 = no end; Sunset requires non-zero future value)" required />
            <FormField label="Metadata URI" value={metadataUri} onChange={setMetadataUri}
                placeholder="https://..." hint="Max 128 bytes" />
            <FormField label="Pullers (up to 4)" value={pullers} onChange={setPullers}
                placeholder="Comma-separated addresses" hint="Updated authorized pullers" />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
