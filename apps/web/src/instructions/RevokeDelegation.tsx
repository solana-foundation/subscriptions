'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { getRevokeDelegationOverlayInstruction } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function RevokeDelegation() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultDelegation } = useSavedValues();

    const [delegationAccount, setDelegationAccount] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const instruction = getRevokeDelegationOverlayInstruction({
            authority: signer,
            delegationAccount: delegationAccount.trim() as Address,
            programAddress: getProgramAddress(),
        });

        await send([instruction], {
            action: 'RevokeDelegation',
            values: { delegationPda: delegationAccount.trim() },
        });
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Delegation Account" value={delegationAccount} onChange={setDelegationAccount}
                autoFillValue={defaultDelegation} onAutoFill={setDelegationAccount}
                placeholder="Delegation PDA address" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
