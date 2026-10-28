import { type Address, generateKeyPairSigner } from '@solana/kit';
import type { SmartWallet } from './SmartWallet.ts';
import { createSquadsWallet } from './squadsWallet.ts';
import { createSwigWallet } from './swigWallet.ts';
import type { SmartWalletClient } from './utils.ts';

export type SmartWalletChoice = 'swig' | 'squads' | 'all' | 'none';

type CreateSmartWalletsConfig = {
    client: SmartWalletClient;
    choice: SmartWalletChoice;
    airdrop: (address: Address, lamportsAmount: bigint) => Promise<void>;
};

export async function createSmartWallets(config: CreateSmartWalletsConfig): Promise<SmartWallet[]> {
    const wallets: SmartWallet[] = [];

    if (config.choice === 'swig' || config.choice === 'all') {
        const swigFeePayer = await generateKeyPairSigner();
        const swigAuthority = await generateKeyPairSigner();
        await config.airdrop(swigFeePayer.address, 2_000_000_000n);
        await config.airdrop(swigAuthority.address, 2_000_000_000n);
        const swigWallet = await createSwigWallet({
            client: config.client,
            feePayer: swigFeePayer,
            authority: swigAuthority,
        });
        await config.airdrop(swigWallet.address, 5_000_000_000n);
        wallets.push(swigWallet);
    }

    if (config.choice === 'squads' || config.choice === 'all') {
        const squadsMembers = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);
        const squadsFeePayer = squadsMembers[0];
        await config.airdrop(squadsFeePayer.address, 2_000_000_000n);
        for (const member of squadsMembers.slice(1)) {
            await config.airdrop(member.address, 1_000_000_000n);
        }
        const squadsWallet = await createSquadsWallet({
            client: config.client,
            feePayer: squadsFeePayer,
            members: squadsMembers,
            approvalsRequired: 2,
        });
        await config.airdrop(squadsWallet.address, 5_000_000_000n);
        wallets.push(squadsWallet);
    }

    return wallets;
}
