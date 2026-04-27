'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildCreatePlan } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress, TOKEN_2022_PROGRAM_ID } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function CreatePlan() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultMint, rememberMint, rememberPlan } = useSavedValues();

    const [planId, setPlanId] = useState('0');
    const [mint, setMint] = useState('');
    const [amount, setAmount] = useState('');
    const [periodHours, setPeriodHours] = useState('');
    const [endTs, setEndTs] = useState('0');
    const [destinations, setDestinations] = useState('');
    const [pullers, setPullers] = useState('');
    const [metadataUri, setMetadataUri] = useState('');

    function parseAddressList(raw: string): Address[] {
        return raw.split(',').map(s => s.trim()).filter(Boolean) as Address[];
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions, planPda } = await buildCreatePlan({
            owner: signer, planId: BigInt(planId), mint: mint.trim() as Address,
            amount: BigInt(amount), periodHours: BigInt(periodHours),
            endTs: BigInt(endTs), destinations: parseAddressList(destinations),
            pullers: parseAddressList(pullers), metadataUri: metadataUri.trim(),
            tokenProgram: TOKEN_2022_PROGRAM_ID, programAddress: getProgramAddress(),
        });

        const sig = await send(instructions, { action: 'CreatePlan', values: { mint: mint.trim(), planPda } });
        if (sig) {
            rememberMint(mint.trim());
            rememberPlan(planPda);
        }
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Plan ID" value={planId} onChange={setPlanId} type="number"
                hint="Unique numeric ID for this plan under your wallet" required />
            <FormField label="Mint" value={mint} onChange={setMint}
                autoFillValue={defaultMint} onAutoFill={setMint}
                placeholder="Token mint address" required />
            <FormField label="Amount" value={amount} onChange={setAmount} type="number"
                hint="Amount per billing period (base units)" required />
            <FormField label="Period Hours" value={periodHours} onChange={setPeriodHours} type="number"
                hint="Billing period in hours" required />
            <FormField label="End Timestamp" value={endTs} onChange={setEndTs} type="number"
                hint="Unix timestamp when plan stops accepting new subscriptions (0 = no end, otherwise must be future)" required />
            <FormField label="Destinations (up to 4)" value={destinations} onChange={setDestinations}
                placeholder="Comma-separated addresses" hint="Recipient addresses for transferred funds" />
            <FormField label="Pullers (up to 4)" value={pullers} onChange={setPullers}
                placeholder="Comma-separated addresses" hint="Addresses authorized to pull subscription payments" />
            <FormField label="Metadata URI" value={metadataUri} onChange={setMetadataUri}
                placeholder="https://..." hint="Off-chain metadata URL (max 128 bytes)" />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
