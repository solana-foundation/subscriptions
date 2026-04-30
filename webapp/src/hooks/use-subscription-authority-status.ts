import { useCluster, useWallet } from '@solana/connector/react';
import { address, createSolanaRpc } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { fetchMaybeSubscriptionAuthority, findSubscriptionAuthorityPda } from '@subscriptions/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';

export interface SubscriptionAuthorityData {
    bump: number;
    initId: bigint;
    payer: string;
    tokenMint: string;
    user: string;
}

export interface SubscriptionAuthorityStatus {
    approved: boolean;
    data: SubscriptionAuthorityData | null;
    initialized: boolean;
    pda: string | null;
}

/**
 * Hook to check if the SubscriptionAuthority PDA is initialized for the connected wallet and token mint.
 * The SubscriptionAuthority must be initialized before creating any delegations.
 * Initialization also sets up SPL token delegation to the PDA.
 *
 * @param tokenMint - The token mint address to check initialization for
 */
export function useSubscriptionAuthorityStatus(tokenMint: string | null) {
    const { account } = useWallet();
    const { cluster } = useCluster();
    const clusterConfig = useClusterConfig();
    const progAddr = useProgramAddress();
    const queryClient = useQueryClient();

    const query = useQuery({
        enabled: !!account && !!tokenMint && !!progAddr,
        queryFn: async (): Promise<SubscriptionAuthorityStatus> => {
            if (!account || !tokenMint) {
                return { approved: false, data: null, initialized: false, pda: null };
            }

            const rpc = createSolanaRpc(clusterConfig.url);
            const progId = progAddr ? address(progAddr) : undefined;
            const [pda] = await findSubscriptionAuthorityPda(
                { tokenMint: address(tokenMint), user: address(account) },
                { programAddress: progId },
            );
            const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(rpc, pda);

            const exists =
                subscriptionAuthority && 'exists' in subscriptionAuthority ? subscriptionAuthority.exists : false;

            let approved = false;
            if (exists) {
                try {
                    const mint = address(tokenMint);
                    const owner = address(account);
                    const tokenPrograms = [TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS];

                    for (const tokenProgram of tokenPrograms) {
                        const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram });
                        const ataAccount = await rpc
                            .getAccountInfo(ata, { commitment: 'confirmed', encoding: 'jsonParsed' })
                            .send();

                        if (ataAccount.value) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const delegate = (ataAccount.value.data as any)?.parsed?.info?.delegate ?? null;
                            approved = delegate === pda;
                            break;
                        }
                    }
                } catch (err) {
                    console.error('Failed to check delegate status:', err);
                }
            }

            return {
                approved,
                data:
                    exists && subscriptionAuthority && 'data' in subscriptionAuthority
                        ? (subscriptionAuthority.data as unknown as SubscriptionAuthorityData)
                        : null,
                initialized: exists,
                pda: pda,
            };
        },
        queryKey: ['subscriptionAuthorityStatus', account, tokenMint, cluster?.id],
        retry: 2,
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 5000),
    });

    const refetch = async () => {
        await queryClient.invalidateQueries({
            queryKey: ['subscriptionAuthorityStatus', account, tokenMint, cluster?.id],
        });
    };

    return {
        ...query,
        isApproved: query.data?.approved ?? false,
        isInitialized: query.data?.initialized ?? false,
        pda: query.data?.pda ?? null,
        refetch,
    };
}
