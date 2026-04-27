'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import { buildCreateFixedDelegation } from '@subscriptions/client';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function CreateFixedDelegation() {
    const { createSigner } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultMint, defaultDelegatee, rememberMint, rememberDelegatee, rememberDelegation } = useSavedValues();

    const [mint, setMint] = useState('');
    const [delegatee, setDelegatee] = useState('');
    const [nonce, setNonce] = useState('0');
    const [amount, setAmount] = useState('');
    const [expiryTs, setExpiryTs] = useState('0');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const { instructions, delegationPda } = await buildCreateFixedDelegation({
            delegator: signer,
            tokenMint: mint.trim() as Address,
            delegatee: delegatee.trim() as Address,
            nonce: BigInt(nonce),
            amount: BigInt(amount),
            expiryTs: BigInt(expiryTs),
            programAddress: getProgramAddress(),
        });

        const sig = await send(instructions, {
            action: 'CreateFixedDelegation',
            values: { mint: mint.trim(), delegatee: delegatee.trim(), delegationPda },
        });
        if (sig) {
            rememberMint(mint.trim());
            rememberDelegatee(delegatee.trim());
            rememberDelegation(delegationPda);
        }
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Token Mint" value={mint} onChange={setMint}
                autoFillValue={defaultMint} onAutoFill={setMint}
                placeholder="Mint address" required />
            <FormField label="Delegatee" value={delegatee} onChange={setDelegatee}
                autoFillValue={defaultDelegatee} onAutoFill={setDelegatee}
                placeholder="Delegatee address" required />
            <FormField label="Nonce" value={nonce} onChange={setNonce} type="number"
                hint="Unique nonce to distinguish multiple delegations to the same delegatee" required />
            <FormField label="Amount" value={amount} onChange={setAmount} type="number"
                hint="Total token amount (base units)" required />
            <FormField label="Expiry Timestamp" value={expiryTs} onChange={setExpiryTs} type="number"
                hint="Unix timestamp — must be in the future" required />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
