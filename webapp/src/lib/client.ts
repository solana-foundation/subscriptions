import { SubscriptionsClient } from '@subscriptions/client'
import { createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory, getBase58Decoder } from 'gill'

export function createSubscriptionsClient(endpoint: string) {
  const rpc = createSolanaRpc(endpoint)
  const wsEndpoint = endpoint.replace('http', 'ws')
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsEndpoint)
  
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  })

  return new SubscriptionsClient({
    rpc,
    sendAndConfirmTransaction: async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmTransaction(tx as any, { commitment: 'confirmed' })
      // Convert signature bytes to base58 string
      // The factory returns signature bytes that we need to decode
      const sigBytes = result as unknown as Uint8Array
      return getBase58Decoder().decode(sigBytes)
    },
  })
}
