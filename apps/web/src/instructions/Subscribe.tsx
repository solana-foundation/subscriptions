'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildSubscribe } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function Subscribe() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultMint, rememberSubscription } = useSavedValues();

    const [merchant, setMerchant] = useState('');
    const [planId, setPlanId] = useState('0');
    const [tokenMint, setTokenMint] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions, subscriptionPda } = await buildSubscribe({
            subscriber: signer, merchant: merchant.trim() as Address,
            planId: BigInt(planId), tokenMint: tokenMint.trim() as Address,
            programAddress: getProgramAddress(),
        });

        const sig = await send(instructions, {
            action: 'Subscribe',
            values: { mint: tokenMint.trim(), subscriptionPda },
        });
        if (sig) rememberSubscription(subscriptionPda);
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Merchant" value={merchant} onChange={setMerchant}
                placeholder="Plan owner wallet address" required />
            <FormField label="Plan ID" value={planId} onChange={setPlanId} type="number"
                hint="Numeric plan identifier" required />
            <FormField label="Token Mint" value={tokenMint} onChange={setTokenMint}
                autoFillValue={defaultMint} onAutoFill={setTokenMint}
                placeholder="Mint address" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
