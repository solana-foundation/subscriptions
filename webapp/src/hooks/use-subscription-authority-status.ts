import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWalletUi } from '@wallet-ui/react'
import { createSolanaRpc, address } from 'gill'
import { TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from 'gill/programs/token'
import { getSubscriptionAuthorityPDA, fetchMaybeSubscriptionAuthority } from '@subscriptions/client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useProgramAddress } from '@/hooks/use-token-config'

export interface SubscriptionAuthorityData {
  user: string
  tokenMint: string
  payer: string
  bump: number
  initId: bigint
}

export interface SubscriptionAuthorityStatus {
  initialized: boolean
  approved: boolean
  pda: string | null
  data: SubscriptionAuthorityData | null
}

/**
 * Hook to check if the SubscriptionAuthority PDA is initialized for the connected wallet and token mint.
 * The SubscriptionAuthority must be initialized before creating any delegations.
 * Initialization also sets up SPL token delegation to the PDA.
 *
 * @param tokenMint - The token mint address to check initialization for
 */
export function useSubscriptionAuthorityStatus(tokenMint: string | null) {
  const { account, cluster } = useWalletUi()
  const clusterConfig = useClusterConfig()
  const progAddr = useProgramAddress()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['subscriptionAuthorityStatus', account?.address, tokenMint, cluster.id],
    queryFn: async (): Promise<SubscriptionAuthorityStatus> => {
      if (!account?.address || !tokenMint) {
        return { initialized: false, approved: false, pda: null, data: null }
      }

      const rpc = createSolanaRpc(clusterConfig.url)
      const progId = progAddr ? address(progAddr) : undefined
      const [pda] = await getSubscriptionAuthorityPDA(address(account.address), address(tokenMint), progId)
      const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(rpc, pda)

      const exists = subscriptionAuthority && 'exists' in subscriptionAuthority ? subscriptionAuthority.exists : false

      let approved = false
      if (exists) {
        try {
          const mint = address(tokenMint)
          const owner = address(account.address)
          const tokenPrograms = [TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]

          for (const tokenProgram of tokenPrograms) {
            const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram })
            const ataAccount = await rpc
              .getAccountInfo(ata, { encoding: 'jsonParsed', commitment: 'confirmed' })
              .send()

            if (ataAccount.value) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const delegate = (ataAccount.value.data as any)?.parsed?.info?.delegate ?? null
              approved = delegate === pda
              break
            }
          }
        } catch (err) {
          console.error('Failed to check delegate status:', err)
        }
      }

      return {
        initialized: exists,
        approved,
        pda: pda,
        data: exists && subscriptionAuthority && 'data' in subscriptionAuthority ? subscriptionAuthority.data as unknown as SubscriptionAuthorityData : null,
      }
    },
    enabled: !!account?.address && !!tokenMint && !!progAddr,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  })

  const refetch = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['subscriptionAuthorityStatus', account?.address, tokenMint, cluster.id],
    })
  }

  return {
    ...query,
    refetch,
    isInitialized: query.data?.initialized ?? false,
    isApproved: query.data?.approved ?? false,
    pda: query.data?.pda ?? null,
  }
}
