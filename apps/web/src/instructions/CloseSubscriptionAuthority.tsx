'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildCloseSubscriptionAuthority } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function CloseSubscriptionAuthority() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultMint } = useSavedValues();

    const [mint, setMint] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions } = await buildCloseSubscriptionAuthority({
            user: signer, tokenMint: mint.trim() as Address, programAddress: getProgramAddress(),
        });

        await send(instructions, { action: 'CloseSubscriptionAuthority', values: { mint: mint.trim() } });
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Token Mint" value={mint} onChange={setMint}
                autoFillValue={defaultMint} onAutoFill={setMint}
                placeholder="Mint address" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
