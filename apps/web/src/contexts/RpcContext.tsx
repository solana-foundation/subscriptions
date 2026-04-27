'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'subscriptions-rpc-url';
const FALLBACK_RPC = 'https://api.devnet.solana.com';
const DEFAULT_RPC = process.env.NEXT_PUBLIC_RPC_URL ?? FALLBACK_RPC;

export const RPC_PRESETS = [
    { label: 'Devnet', url: 'https://api.devnet.solana.com' },
    { label: 'Mainnet', url: 'https://api.mainnet-beta.solana.com' },
    { label: 'Testnet', url: 'https://api.testnet.solana.com' },
    { label: 'Localhost', url: 'http://localhost:8899' },
] as const;

interface RpcContextType {
    rpcUrl: string;
    setRpcUrl: (url: string) => void;
}

const RpcContext = createContext<RpcContextType | null>(null);

export function RpcProvider({ children }: { children: React.ReactNode }) {
    const [rpcUrl, setRpcUrlState] = useState<string>(DEFAULT_RPC);

    useEffect(() => {
        const storedRpcUrl = window.localStorage.getItem(STORAGE_KEY);
        if (storedRpcUrl) {
            setRpcUrlState(storedRpcUrl);
        }
    }, []);

    const setRpcUrl = useCallback((url: string) => {
        window.localStorage.setItem(STORAGE_KEY, url);
        setRpcUrlState(url);
    }, []);

    const value = useMemo(() => ({ rpcUrl, setRpcUrl }), [rpcUrl, setRpcUrl]);

    return <RpcContext.Provider value={value}>{children}</RpcContext.Provider>;
}

export function useRpcContext() {
    const ctx = useContext(RpcContext);
    if (!ctx) throw new Error('useRpcContext must be used inside RpcProvider');
    return ctx;
}
