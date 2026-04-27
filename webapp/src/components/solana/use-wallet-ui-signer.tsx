import { createContext, useContext, type ReactNode } from 'react'
import type { TransactionSendingSigner } from '@solana/kit'
import type { UiWalletAccount } from '@wallet-ui/react'
import { useWalletAccountTransactionSendingSigner, useWalletUi } from '@wallet-ui/react'

const WalletSignerContext = createContext<TransactionSendingSigner | undefined>(undefined)

function SignerProvider({
  account,
  clusterId,
  children,
}: {
  account: UiWalletAccount
  clusterId: `solana:${string}`
  children: ReactNode
}) {
  const signer = useWalletAccountTransactionSendingSigner(account, clusterId)
  return <WalletSignerContext.Provider value={signer}>{children}</WalletSignerContext.Provider>
}

export function WalletSignerProvider({ children }: { children: ReactNode }) {
  const { account, cluster } = useWalletUi()

  if (!account) {
    return <WalletSignerContext.Provider value={undefined}>{children}</WalletSignerContext.Provider>
  }

  return (
    <SignerProvider account={account} clusterId={cluster.id}>
      {children}
    </SignerProvider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWalletUiSigner() {
  return useContext(WalletSignerContext)
}
