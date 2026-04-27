import { ThemeProvider } from './theme-provider'
import { ReactQueryProvider } from './react-query-provider'
import { SolanaProvider } from './solana/solana-provider'
import { ErrorBoundary } from 'react-error-boundary'
import React from 'react'

function WalletErrorFallback({ error }: { error: unknown }) {
  const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred'
  if (error instanceof Error) {
    console.error('WalletErrorFallback caught error:', error, error.stack)
  } else {
    console.error('WalletErrorFallback caught non-Error:', error)
  }
  // The cached wallet account is what's throwing (e.g. it doesn't support the
  // current chain). Reloading alone re-hydrates the same account and re-throws,
  // trapping the user. Disconnect clears wallet-ui's persisted account/cluster
  // so the next load comes up unconnected.
  const disconnectAndReload = () => {
    try {
      localStorage.removeItem('wallet-ui:account')
      localStorage.removeItem('wallet-ui:cluster')
    } catch {
      // ignore storage failures; reload is still useful
    }
    window.location.reload()
  }
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8">
      <h1 className="text-2xl font-bold text-destructive">Wallet Error</h1>
      <p className="text-muted-foreground text-center max-w-md">
        {errorMessage}
      </p>
      <div className="flex gap-2">
        <button
          onClick={disconnectAndReload}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          Disconnect Wallet & Reload
        </button>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90"
        >
          Reload Page
        </button>
      </div>
    </div>
  )
}

export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ReactQueryProvider>
      <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" disableTransitionOnChange>
        <ErrorBoundary FallbackComponent={WalletErrorFallback}>
          <SolanaProvider>
            {children}
          </SolanaProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </ReactQueryProvider>
  )
}
