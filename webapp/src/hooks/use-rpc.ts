import { useMemo } from 'react'
import { createSolanaRpc } from '@solana/kit'
import { useClusterConfig } from '@/hooks/use-cluster-config'

export function useRpc() {
  const { url } = useClusterConfig()
  return useMemo(() => createSolanaRpc(url), [url])
}
