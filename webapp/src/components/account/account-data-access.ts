import { useWalletUi } from '@wallet-ui/react'
import { createSolanaRpc } from '@solana/kit'
import type { Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useRpc } from '@/hooks/use-rpc'
import { useUsdcMint } from '@/hooks/use-token-config'
import { useCreateToken } from '@/hooks/use-create-token'
import { invalidateWithDelay } from '@/lib/utils'

export function useGetBalanceQuery({ address: addr }: { address: Address }) {
  const clusterConfig = useClusterConfig()
  const rpc = useRpc()

  return useQuery({
    retry: false,
    queryKey: ['get-balance', { cluster: clusterConfig.id, address: addr }],
    queryFn: () => rpc.getBalance(addr).send(),
    staleTime: 5000, // Consider fresh for 5 seconds
  })
}

async function getTokenAccountsByOwner(
  rpc: ReturnType<typeof createSolanaRpc>,
  { address: addr, programId }: { address: Address; programId: Address },
) {
  const result = await rpc
    .getTokenAccountsByOwner(addr, { programId }, { commitment: 'confirmed', encoding: 'jsonParsed' })
    .send()
    .then((res) => res.value ?? [])
  return result
}

export function useGetTokenAccountsQuery({ address: addr }: { address: Address }) {
  const clusterConfig = useClusterConfig()
  const rpc = useRpc()

  return useQuery({
    queryKey: ['get-token-accounts', { cluster: clusterConfig.id, address: addr }],
    queryFn: async () => {
      const result = await Promise.all([
        getTokenAccountsByOwner(rpc, { address: addr, programId: TOKEN_PROGRAM_ADDRESS }),
        getTokenAccountsByOwner(rpc, { address: addr, programId: TOKEN_2022_PROGRAM_ADDRESS }),
      ]).then(([tokenAccounts, token2022Accounts]) => [...tokenAccounts, ...token2022Accounts])
      return result
    },
    staleTime: 5000, // Consider fresh for 5 seconds
    refetchOnWindowFocus: true,
  })
}

const LAMPORTS_PER_SOL = 1_000_000_000

export function useRequestAirdropMutation({ address: addr }: { address: Address }) {
  const clusterConfig = useClusterConfig()
  const rpc = useRpc()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (amount: number = 1) => {
      const lamportAmount = BigInt(Math.round(amount * LAMPORTS_PER_SOL))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = await rpc.requestAirdrop(addr, lamportAmount as any).send()
      return sig
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['get-balance', { cluster: clusterConfig.id, address: addr }] })
    },
  })
}

export function useAirdropSol() {
  const { account, cluster } = useWalletUi()
  const rpc = useRpc()
  const queryClient = useQueryClient()
  const isDevnet = cluster.id === 'solana:devnet'

  return useMutation({
    mutationFn: async (amount: number) => {
      if (!account) throw new Error('Wallet not connected')
      if (isDevnet) {
        const lamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await rpc.requestAirdrop(account.address as Address, lamports as any).send()
        return { message: `Airdropped ${amount} SOL on devnet` }
      }
      return api.airdrop.sol({ recipient: account.address, amount })
    },
    onSuccess: (result) => {
      toast.success(result.message ?? 'SOL airdrop successful!')
      invalidateWithDelay(queryClient, [['get-balance']])
    },
    onError: (error) => {
      toast.error(`SOL airdrop failed: ${error.message}`)
    },
  })
}

export function useAirdropUsdc() {
  const { account, cluster } = useWalletUi()
  const queryClient = useQueryClient()
  const usdcMint = useUsdcMint()
  const { mintTo } = useCreateToken()
  const isDevnet = cluster.id === 'solana:devnet'

  return useMutation({
    mutationFn: async ({ amount, recipient }: { amount: number; recipient?: string }) => {
      if (!account) throw new Error('Wallet not connected')
      if (isDevnet) {
        if (!usdcMint) throw new Error('USDC mint not configured')
        const rawAmount = BigInt(Math.round(amount * 1_000_000))
        const target = (recipient || account.address) as Address
        await mintTo.mutateAsync({
          mint: usdcMint as Address,
          amount: rawAmount,
          recipient: target,
        })
        return { message: `Minted ${amount} USDC to ${target.slice(0, 8)}...` }
      }
      return api.airdrop.usdc({ recipient: account.address, amount })
    },
    onSuccess: (result) => {
      toast.success(result.message ?? 'USDC airdrop successful!')
      invalidateWithDelay(queryClient, [['get-token-accounts']])
    },
    onError: (error) => {
      toast.error(`USDC airdrop failed: ${error.message}`)
    },
  })
}
