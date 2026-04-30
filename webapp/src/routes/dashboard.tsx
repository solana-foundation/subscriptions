import { useWallet } from '@solana/connector/react';
import { address } from '@solana/kit';
import { WalletBalanceCards } from '../components/account/account-ui';
import { SummaryCards } from '@/components/dashboard/summary-cards';

function DashboardConnected() {
    const { account } = useWallet();
    return (
        <div className="space-y-8 max-w-5xl mx-auto">
            {account && <WalletBalanceCards address={address(account)} />}
            <SummaryCards />
        </div>
    );
}

export function Dashboard() {
    const { account } = useWallet();

    if (!account) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <h1 className="text-2xl font-bold">Connect your wallet to get started</h1>
                <p className="text-muted-foreground">Manage your Solana delegations securely.</p>
            </div>
        );
    }

    return <DashboardConnected />;
}
