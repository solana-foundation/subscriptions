'use client';

import { useState } from 'react';
import type { Address } from '@solana/kit';
import {
    findSubscriptionAuthorityPda,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
} from '@subscriptions/client';
import { findAssociatedTokenPda } from '@solana-program/token';
import { useWallet } from '@/contexts/WalletContext';
import { useSavedValues } from '@/contexts/SavedValuesContext';
import { getProgramAddress, TOKEN_2022_PROGRAM_ID } from '@/lib/program';
import { useSendTx } from '@/hooks/useSendTx';
import { FormField, SendButton, TxResultDisplay } from './shared';

export function InitSubscriptionAuthority() {
    const { createSigner, account } = useWallet();
    const { send, sending, error, signature, reset } = useSendTx();
    const { defaultMint, rememberMint, rememberSubscriptionAuthority } = useSavedValues();

    const [mint, setMint] = useState('');
    const [userAta, setUserAta] = useState('');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        reset();
        const signer = createSigner();
        if (!signer) return;

        const mintAddress = mint.trim() as Address;
        const tokenProgram = TOKEN_2022_PROGRAM_ID;
        const programAddress = getProgramAddress();

        let ataAddress: Address;
        if (userAta.trim()) {
            ataAddress = userAta.trim() as Address;
        } else {
            const [derived] = await findAssociatedTokenPda({ mint: mintAddress, owner: signer.address, tokenProgram });
            ataAddress = derived;
        }

        const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
            { user: signer.address, tokenMint: mintAddress },
            { programAddress },
        );
        const instruction = await getInitSubscriptionAuthorityOverlayInstructionAsync({
            owner: signer, tokenMint: mintAddress, userAta: ataAddress,
            tokenProgram, programAddress,
        });

        const sig = await send([instruction], {
            action: 'InitSubscriptionAuthority',
            values: { mint: mintAddress, subscriptionAuthority: subscriptionAuthorityPda },
        });
        if (sig) {
            rememberMint(mintAddress);
            rememberSubscriptionAuthority(subscriptionAuthorityPda);
        }
    }

    return (
        <form onSubmit={e => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FormField label="Token Mint" value={mint} onChange={setMint}
                autoFillValue={defaultMint} onAutoFill={setMint}
                placeholder="Mint address (Token-2022)" required />
            <FormField label="User ATA (optional)" value={userAta} onChange={setUserAta}
                placeholder={account?.address ? `Auto-derived for ${account.address.slice(0, 8)}...` : 'Auto-derived from wallet + mint if empty'}
                hint="Leave blank to auto-derive the associated token account" />
            <SendButton sending={sending} />
            <TxResultDisplay signature={signature} error={error} />
        </form>
    );
}
