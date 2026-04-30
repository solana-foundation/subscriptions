import { Droplets } from 'lucide-react';
import { useCluster, useWallet } from '@solana/connector/react';
import { SolFaucetCard, UsdcFaucetCard } from '../components/account/account-ui';

export function Faucet() {
    const { account } = useWallet();
    const { cluster } = useCluster();

    if (!account) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Connect your wallet to get started</h1>
                <p className="text-muted-foreground">Request test tokens to try the application.</p>
            </div>
        );
    }

    if (cluster?.id === 'solana:mainnet') {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Faucet not available on Mainnet</h1>
                <p className="text-muted-foreground">Switch to a devnet or testnet cluster to request tokens.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Droplets className="h-8 w-8 text-foreground" />
                <div>
                    <h1 className="text-2xl font-bold">Development Faucet</h1>
                    <p className="text-sm text-muted-foreground">Request test tokens for development</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <SolFaucetCard />
                <UsdcFaucetCard />
            </div>
        </div>
    );
}
