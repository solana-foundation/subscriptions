import { lazy, Suspense } from 'react';
import { Route, Routes, Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { createSolanaRpc } from '@solana/kit';
import { AppProviders } from '@/components/app-providers';
import { AppLayout } from '@/components/app-layout';
import { Dashboard } from '@/routes/dashboard';
import { Marketplace } from '@/routes/marketplace';
import { Faucet } from '@/routes/faucet';
import { Delegations } from '@/routes/delegations';
import { Subscriptions } from '@/routes/subscriptions';
import { Plans } from '@/routes/plans';
import { CollectPayments } from '@/routes/collect-payments';
import { useNetworkConfig } from '@/hooks/use-token-config';
import { clusterIdToNetwork } from '@/lib/cluster';
import { useClusterConfig } from '@/hooks/use-cluster-config';

const Setup = lazy(() => import('@/routes/setup').then(m => ({ default: m.Setup })));
const Program = lazy(() => import('@/routes/program').then(m => ({ default: m.Program })));

function useRpcReachable() {
    const { id, url } = useClusterConfig();
    const isLocalnet = id === 'solana:localnet';

    return useQuery({
        queryKey: ['rpc-health', id],
        queryFn: async () => {
            try {
                const rpc = createSolanaRpc(url);
                await rpc.getVersion().send();
                return true;
            } catch {
                return false;
            }
        },
        enabled: isLocalnet,
        staleTime: 10_000,
        retry: false,
    });
}

function useIsSetupValid(): { ready: boolean; loading: boolean } {
    const { id } = useClusterConfig();
    const network = clusterIdToNetwork(id);
    const isLocalnet = id === 'solana:localnet';
    const lsComplete = localStorage.getItem(`setup-complete-${network}`) === 'true';
    const { data, isLoading } = useNetworkConfig();
    const { data: rpcReachable, isLoading: rpcLoading } = useRpcReachable();

    if (!lsComplete) return { ready: false, loading: false };
    if (isLoading || (isLocalnet && rpcLoading)) return { ready: true, loading: true };

    if (isLocalnet && rpcReachable === false) {
        localStorage.removeItem(`setup-complete-${network}`);
        return { ready: false, loading: false };
    }

    const hasProgram = !!data?.programAddress;
    const hasTokens = (data?.tokens?.length ?? 0) > 0;
    if (!hasProgram || !hasTokens) {
        localStorage.removeItem(`setup-complete-${network}`);
        return { ready: false, loading: false };
    }

    return { ready: true, loading: false };
}

function DevSetupGuard({ children }: { children: React.ReactNode }) {
    const location = useLocation();
    const { ready } = useIsSetupValid();
    if (!ready && location.pathname !== '/setup') {
        return <Navigate to="/setup" replace />;
    }
    return <>{children}</>;
}

function ProdSetupGuard({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}

const HAS_LOCALNET_CONFIG = !!import.meta.env.VITE_LOCALNET_USDC_MINT;
const SetupGuard = import.meta.env.DEV && !HAS_LOCALNET_CONFIG ? DevSetupGuard : ProdSetupGuard;

export default function App() {
    return (
        <AppProviders>
            <SetupGuard>
                <Suspense fallback={null}>
                    <Routes>
                        {import.meta.env.DEV && <Route path="/setup" element={<Setup />} />}
                        <Route
                            element={
                                <AppLayout>
                                    <Dashboard />
                                </AppLayout>
                            }
                            path="/"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <Marketplace />
                                </AppLayout>
                            }
                            path="/marketplace"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <Delegations />
                                </AppLayout>
                            }
                            path="/delegations"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <Subscriptions />
                                </AppLayout>
                            }
                            path="/subscriptions"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <Plans />
                                </AppLayout>
                            }
                            path="/plans"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <CollectPayments />
                                </AppLayout>
                            }
                            path="/plans/collect"
                        />
                        <Route
                            element={
                                <AppLayout>
                                    <Faucet />
                                </AppLayout>
                            }
                            path="/faucet"
                        />
                        {import.meta.env.DEV && (
                            <Route
                                element={
                                    <AppLayout>
                                        <Program />
                                    </AppLayout>
                                }
                                path="/program"
                            />
                        )}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Suspense>
            </SetupGuard>
        </AppProviders>
    );
}
