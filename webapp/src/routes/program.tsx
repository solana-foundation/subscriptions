import { Code2 } from 'lucide-react';
import { useCluster, useWallet } from '@solana/connector/react';
import { ProgramStatusCard } from '@/components/program/program-status-card';
import { ProgramDeployCard } from '@/components/program/program-deploy-card';

export function Program() {
    const { account } = useWallet();
    const { cluster } = useCluster();

    if (!account) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Connect your wallet to get started</h1>
                <p className="text-muted-foreground">Manage program deployment on devnet.</p>
            </div>
        );
    }

    if (cluster?.id === 'solana:localnet') {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Program Management not available on Localnet</h1>
                <p className="text-muted-foreground">Switch to Devnet or Testnet to manage program deployment.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Code2 className="h-8 w-8 text-purple-400" />
                <div>
                    <h1 className="text-2xl font-bold">Program Management</h1>
                    <p className="text-sm text-muted-foreground">Deploy and manage the on-chain program</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ProgramStatusCard />
                <ProgramDeployCard />
            </div>
        </div>
    );
}
