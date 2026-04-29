import type { Address } from '@solana/kit';
import { Connection, Keypair } from '@solana/web3.js';
import type { SmartWallet } from './SmartWallet.ts';
import { createSquadsWallet } from './squadsWallet.ts';
import { createSwigWallet } from './swigWallet.ts';

export type SmartWalletChoice = 'swig' | 'squads' | 'all' | 'none';

type CreateSmartWalletsConfig = {
    rpcUrl: string;
    choice: SmartWalletChoice;
    airdrop: (address: Address, lamportsAmount: bigint) => Promise<void>;
};

/**
 * Adapter-layer helper that isolates web3.js-only wallet SDK requirements.
 * Callers can remain on kit abstractions and plain Address values.
 */
export async function createSmartWallets(config: CreateSmartWalletsConfig): Promise<SmartWallet[]> {
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const wallets: SmartWallet[] = [];

    if (config.choice === 'swig' || config.choice === 'all') {
        const swigFeePayer = Keypair.generate();
        const swigAuthority = Keypair.generate();
        await config.airdrop(swigFeePayer.publicKey.toBase58() as Address, 2_000_000_000n);
        await config.airdrop(swigAuthority.publicKey.toBase58() as Address, 2_000_000_000n);
        const swigWallet = await createSwigWallet({
            connection,
            feePayer: swigFeePayer,
            authority: swigAuthority,
        });
        await config.airdrop(swigWallet.address, 5_000_000_000n);
        wallets.push(swigWallet);
    }

    if (config.choice === 'squads' || config.choice === 'all') {
        const squadsMembers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
        const squadsFeePayer = squadsMembers[0];
        await config.airdrop(squadsFeePayer.publicKey.toBase58() as Address, 2_000_000_000n);
        for (const member of squadsMembers.slice(1)) {
            await config.airdrop(member.publicKey.toBase58() as Address, 1_000_000_000n);
        }
        const squadsWallet = await createSquadsWallet({
            connection,
            feePayer: squadsFeePayer,
            members: squadsMembers,
            approvalsRequired: 2,
        });
        await config.airdrop(squadsWallet.address, 5_000_000_000n);
        wallets.push(squadsWallet);
    }

    return wallets;
}
